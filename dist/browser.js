// Browser entry point: robust client for the same-origin /api/chat proxy that
// fronts the local Hermes gateway.
//
// Why this exists: the gateway is a real tool-using agent, so a turn can take
// tens of seconds. Over a phone's connection a long-lived POST is fragile — a
// network handover, a screen lock, or a reverse proxy closing the connection
// surfaces in the browser as `TypeError: Failed to fetch` with NO response
// object. A bare fetch turns every such blip into that opaque string.
//
// postChat adds:
//   1. a client-side timeout we control, so a hung turn ends with a clean
//      message instead of spinning forever (kept ABOVE the server's own
//      timeout so the server's tidy 504 JSON wins the race when it can);
//   2. typed errors carrying a human, actionable German message;
//   3. a *narrow, side-effect-safe* auto-retry — only for failures that reject
//      almost immediately (a connection that never established), so we never
//      re-run an agent turn that may already have fired a tool. A drop that
//      happens deep into a turn is surfaced, not retried.
/** A failure talking to the gateway, pre-classified with a user-facing message. */
export class ChatError extends Error {
    constructor(kind, message, status) {
        super(message);
        this.name = 'ChatError';
        this.kind = kind;
        this.status = status;
    }
}
const DEFAULTS = {
    endpoint: '/api/chat',
    timeoutMs: 240000,
    fastFailRetryMs: 1500,
    maxRetries: 2,
};
/** POST a turn to the gateway proxy and return the OpenAI-shaped completion. */
export async function postChat(messages, options = {}) {
    const o = { ...DEFAULTS, ...options };
    let attempt = 0;
    for (;;) {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            throw new ChatError('offline', 'Keine Internetverbindung — die Nachricht wurde nicht gesendet.');
        }
        const startedAt = typeof performance !== 'undefined' ? performance.now() : 0;
        try {
            return await once(messages, o);
        }
        catch (err) {
            const e = err instanceof ChatError ? err : new ChatError('network', 'Verbindung zu Hermes unterbrochen. Bitte erneut senden.');
            const elapsed = (typeof performance !== 'undefined' ? performance.now() : 0) - startedAt;
            const canRetry = e.kind === 'network' &&
                attempt < o.maxRetries &&
                o.fastFailRetryMs > 0 &&
                elapsed <= o.fastFailRetryMs;
            if (!canRetry)
                throw e;
            attempt += 1;
            o.onRetry?.(attempt);
            await sleep(Math.min(2000, 250 * 2 ** (attempt - 1)));
        }
    }
}
/** Pull the assistant's text out of a completion (with a sane fallback). */
export function assistantText(data) {
    return data.choices?.[0]?.message?.content || 'Keine Antwort erhalten.';
}
async function once(messages, o) {
    const ctrl = new AbortController();
    let timedOut = false;
    const onAbort = () => ctrl.abort();
    if (o.signal) {
        if (o.signal.aborted)
            ctrl.abort();
        else
            o.signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => {
        timedOut = true;
        ctrl.abort();
    }, o.timeoutMs);
    let res;
    try {
        res = await fetch(o.endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages }),
            credentials: 'same-origin', // carry the page's basic-auth on same origin
            signal: ctrl.signal,
        });
    }
    catch (err) {
        if (o.signal?.aborted)
            throw err; // caller cancelled — let it propagate raw
        if (timedOut) {
            throw new ChatError('timeout', 'Zeitüberschreitung: Hermes hat nicht rechtzeitig geantwortet. Bitte erneut senden.');
        }
        throw new ChatError('network', 'Verbindung zu Hermes unterbrochen. Bitte erneut senden.');
    }
    finally {
        clearTimeout(timer);
        if (o.signal)
            o.signal.removeEventListener('abort', onAbort);
    }
    const text = await res.text().catch(() => '');
    const data = parseJson(text);
    if (!res.ok) {
        const detail = (data && (data.detail || data.error)) || `HTTP ${res.status}`;
        throw new ChatError('http', String(detail), res.status);
    }
    return (data ?? {});
}
function parseJson(text) {
    try {
        return text ? JSON.parse(text) : null;
    }
    catch {
        return null;
    }
}
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
