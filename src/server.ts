// Server entry point: framework-neutral core for proxying one OpenAI-compatible
// chat turn to the local Hermes gateway.
//
// It returns a web-standard `Response`, so it drops straight into a Next.js
// route handler (which may return a Response), Hono, or a bare server. Each app
// keeps its OWN concerns — auth gating, system-prompt / context assembly,
// persistence — and hands the already-assembled `messages` here. That seam is
// deliberate: hermes-chat forwards raw, depot3 first injects live depot context
// and a session check, but both share this exact transport.

export interface GatewayConfig {
  /** Gateway base, e.g. http://127.0.0.1:8081/v1. */
  base?: string;
  /** Bearer token — MUST match the gateway's API_SERVER_KEY. Required. */
  apiKey: string;
  /** Upstream model id. Default 'hermes-agent'. */
  model?: string;
  /** Server-side cap before we abort the upstream turn (ms). Default 180_000. */
  timeoutMs?: number;
}

const DEFAULT_BASE = 'http://127.0.0.1:8081/v1';
const DEFAULT_MODEL = 'hermes-agent';
const DEFAULT_TIMEOUT_MS = 180_000;

/** Read a GatewayConfig from environment variables (server-side only). */
export function gatewayConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): GatewayConfig {
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
export async function forwardToGateway(messages: unknown, cfg: GatewayConfig): Promise<Response> {
  if (!Array.isArray(messages) || messages.length === 0) {
    return json({ error: 'Feld "messages" fehlt oder ist leer.' }, 400);
  }

  const base = (cfg.base || DEFAULT_BASE).replace(/\/+$/, '');
  const model = cfg.model || DEFAULT_MODEL;
  const timeoutMs = cfg.timeoutMs && cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS;

  if (!cfg.apiKey) {
    console.error('[gateway-client] apiKey missing — refusing to call the gateway.');
    return json(
      { error: 'Server-Konfiguration unvollständig: HERMES_API_KEY ist nicht gesetzt.' },
      500,
    );
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
      return json(
        { error: `Hermes-Gateway antwortete mit ${upstream.status}.`, detail: safeDetail(text) },
        502,
      );
    }

    // Pass the OpenAI-shaped completion straight through.
    return new Response(text, { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      console.error('[gateway-client] gateway timeout after', timeoutMs, 'ms');
      return json(
        { error: `Zeitüberschreitung: Hermes hat nicht innerhalb von ${Math.round(timeoutMs / 1000)}s geantwortet.` },
        504,
      );
    }
    const message = error instanceof Error ? error.message : 'Unbekannter Fehler';
    console.error('[gateway-client] fetch to gateway failed:', message);
    return json({ error: `Gateway nicht erreichbar (${base}): ${message}` }, 502);
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort human-readable message out of an upstream error payload. */
export function safeDetail(text: string): string {
  try {
    const parsed = JSON.parse(text);
    return parsed?.error?.message || parsed?.error || text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
