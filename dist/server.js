// Server entry point: framework-neutral core for proxying one OpenAI-compatible
// chat turn to the local Hermes gateway.
//
// It returns a web-standard `Response`, so it drops straight into a Next.js
// route handler (which may return a Response), Hono, or a bare server. Each app
// keeps its OWN concerns — auth gating, system-prompt / context assembly,
// persistence — and hands the already-assembled `messages` here. That seam is
// deliberate: hermes-chat forwards raw, depot3 first injects live depot context
// and a session check, but both share this exact transport.
const DEFAULT_BASE = 'http://127.0.0.1:8081/v1';
const DEFAULT_MODEL = 'hermes-agent';
const DEFAULT_TIMEOUT_MS = 180000;
/** Read a GatewayConfig from environment variables (server-side only). */
export function gatewayConfigFromEnv(env = process.env) {
    return {
        base: env.HERMES_API_BASE,
        apiKey: env.HERMES_API_KEY ?? '',
        model: env.HERMES_MODEL,
        timeoutMs: env.HERMES_TIMEOUT_MS ? Number(env.HERMES_TIMEOUT_MS) : undefined,
    };
}
/**
 * Forward an already-assembled `messages` array to the gateway and return the
 * OpenAI-shaped completion as a Response. Failures map to the JSON shape the
 * UIs already understand — `{ error, detail? }` with 400/500/502/504 — so the
 * browser-side postChat() surfaces an actionable message.
 */
export async function forwardToGateway(messages, cfg) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return json({ error: 'Feld "messages" fehlt oder ist leer.' }, 400);
    }
    const base = (cfg.base || DEFAULT_BASE).replace(/\/+$/, '');
    const model = cfg.model || DEFAULT_MODEL;
    const timeoutMs = cfg.timeoutMs && cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS;
    if (!cfg.apiKey) {
        console.error('[gateway-client] apiKey missing — refusing to call the gateway.');
        return json({ error: 'Server-Konfiguration unvollständig: HERMES_API_KEY ist nicht gesetzt.' }, 500);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const upstream = await fetch(`${base}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${cfg.apiKey}`,
            },
            body: JSON.stringify({ model, messages, stream: false }),
            signal: controller.signal,
        });
        const text = await upstream.text();
        if (!upstream.ok) {
            console.error(`[gateway-client] gateway ${upstream.status}: ${text.slice(0, 500)}`);
            return json({ error: `Hermes-Gateway antwortete mit ${upstream.status}.`, detail: safeDetail(text) }, 502);
        }
        // Pass the OpenAI-shaped completion straight through.
        return new Response(text, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            console.error('[gateway-client] gateway timeout after', timeoutMs, 'ms');
            return json({ error: `Zeitüberschreitung: Hermes hat nicht innerhalb von ${Math.round(timeoutMs / 1000)}s geantwortet.` }, 504);
        }
        const message = error instanceof Error ? error.message : 'Unbekannter Fehler';
        console.error('[gateway-client] fetch to gateway failed:', message);
        return json({ error: `Gateway nicht erreichbar (${base}): ${message}` }, 502);
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * Streaming variant: forward `messages` with `stream: true` and pipe the
 * gateway's Server-Sent-Events straight back to the browser.
 *
 * Why this exists: the non-streaming `forwardToGateway` holds ONE long-lived
 * response open for the entire agent turn. A deep turn (many tool calls) keeps
 * that connection byte-silent for minutes, and an idle-connection timeout
 * anywhere in the path (an HTTP/3 proxy ~120s, the gateway, the client) kills it
 * — the browser sees a bare `Failed to fetch`. The gateway already emits a
 * `: keepalive` comment every ~30s plus `hermes.tool.progress` events while it
 * works, so streaming keeps bytes flowing and no idle timer ever fires.
 *
 * Pass the route's `request.signal` so a client disconnect cancels the upstream
 * agent turn (no orphaned tool work). There is deliberately NO server-side total
 * timeout here: the gateway enforces its own cap and the browser owns an
 * inactivity watchdog (see streamChat) — a fixed server timer would wrongly kill
 * a healthy but long turn.
 */
export async function forwardToGatewayStream(messages, cfg, signal) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return json({ error: 'Feld "messages" fehlt oder ist leer.' }, 400);
    }
    const base = (cfg.base || DEFAULT_BASE).replace(/\/+$/, '');
    const model = cfg.model || DEFAULT_MODEL;
    if (!cfg.apiKey) {
        console.error('[gateway-client] apiKey missing — refusing to call the gateway.');
        return json({ error: 'Server-Konfiguration unvollständig: HERMES_API_KEY ist nicht gesetzt.' }, 500);
    }
    let upstream;
    try {
        upstream = await fetch(`${base}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${cfg.apiKey}`,
            },
            body: JSON.stringify({ model, messages, stream: true }),
            signal,
        });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'Unbekannter Fehler';
        console.error('[gateway-client] stream connect to gateway failed:', message);
        return json({ error: `Gateway nicht erreichbar (${base}): ${message}` }, 502);
    }
    // A non-OK status (or no body) arrives as a normal response BEFORE any stream
    // starts — surface it as the same JSON error shape the UIs already understand.
    if (!upstream.ok || !upstream.body) {
        const text = await upstream.text().catch(() => '');
        console.error(`[gateway-client] gateway ${upstream.status}: ${text.slice(0, 500)}`);
        return json({ error: `Hermes-Gateway antwortete mit ${upstream.status}.`, detail: safeDetail(text) }, 502);
    }
    // Pass the SSE body through untouched. The anti-buffering headers stop Caddy
    // and Next from coalescing chunks — the per-30s keepalive MUST reach the client
    // promptly, or the idle timeouts we are defeating would just move downstream.
    return new Response(upstream.body, {
        status: 200,
        headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        },
    });
}
/** Best-effort human-readable message out of an upstream error payload. */
export function safeDetail(text) {
    try {
        const parsed = JSON.parse(text);
        return parsed?.error?.message || parsed?.error || text.slice(0, 300);
    }
    catch {
        return text.slice(0, 300);
    }
}
function json(body, status) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}
