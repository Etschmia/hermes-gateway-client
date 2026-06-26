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
/**
 * Stream one turn from the gateway proxy, returning the full assistant text.
 *
 * Unlike postChat (one long blocking POST that any idle timeout can sever), this
 * consumes the gateway's SSE: tokens arrive incrementally via `onDelta`, tool
 * activity via `onProgress`, and the per-30s keepalive resets an inactivity
 * watchdog so an arbitrarily long but healthy turn never times out — while a
 * genuinely dead gateway still ends in a clean, typed ChatError.
 *
 * No auto-retry: a streamed turn may already have fired a tool, so re-running it
 * is never side-effect-safe. Surface the error and let the user resend.
 */
export async function streamChat(messages, options = {}) {
    const endpoint = options.endpoint ?? '/api/chat';
    const idleTimeoutMs = options.idleTimeoutMs ?? 90000;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        throw new ChatError('offline', 'Keine Internetverbindung — die Nachricht wurde nicht gesendet.');
    }
    const ctrl = new AbortController();
    let idledOut = false;
    const onAbort = () => ctrl.abort();
    if (options.signal) {
        if (options.signal.aborted)
            ctrl.abort();
        else
            options.signal.addEventListener('abort', onAbort, { once: true });
    }
    let idleTimer;
    const armIdle = () => {
        if (idleTimer)
            clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            idledOut = true;
            ctrl.abort();
        }, idleTimeoutMs);
    };
    const cleanup = () => {
        if (idleTimer)
            clearTimeout(idleTimer);
        if (options.signal)
            options.signal.removeEventListener('abort', onAbort);
    };
    let res;
    try {
        armIdle();
        res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages, stream: true }),
            credentials: 'same-origin', // carry the page's basic-auth on same origin
            signal: ctrl.signal,
        });
    }
    catch (err) {
        cleanup();
        if (options.signal?.aborted)
            throw err; // caller cancelled — propagate raw
        if (idledOut)
            throw new ChatError('timeout', 'Zeitüberschreitung: Hermes hat nicht rechtzeitig geantwortet. Bitte erneut senden.');
        throw new ChatError('network', 'Verbindung zu Hermes unterbrochen. Bitte erneut senden.');
    }
    const ctype = res.headers.get('content-type') || '';
    // Failures come back as a normal JSON body ({error,detail}), not a stream.
    if (!res.ok || !ctype.includes('text/event-stream')) {
        cleanup();
        const text = await res.text().catch(() => '');
        const data = parseJson(text);
        const detail = (data && (data.detail || data.error)) || `HTTP ${res.status}`;
        throw new ChatError(res.ok ? 'network' : 'http', String(detail), res.ok ? undefined : res.status);
    }
    if (!res.body) {
        cleanup();
        throw new ChatError('network', 'Verbindung zu Hermes unterbrochen. Bitte erneut senden.');
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done)
                break;
            armIdle(); // a byte arrived → the connection is alive, reset the watchdog
            buffer += decoder.decode(value, { stream: true });
            // SSE events are separated by a blank line; process every complete one.
            let sep;
            while ((sep = buffer.indexOf('\n\n')) !== -1) {
                const evt = parseSseEvent(buffer.slice(0, sep));
                buffer = buffer.slice(sep + 2);
                if (evt.errorMsg)
                    throw new ChatError('http', evt.errorMsg);
                if (evt.progress)
                    options.onProgress?.(evt.progress);
                if (evt.delta) {
                    full += evt.delta;
                    options.onDelta?.(evt.delta, full);
                }
            }
        }
    }
    catch (err) {
        if (options.signal?.aborted)
            throw err;
        if (idledOut)
            throw new ChatError('timeout', 'Zeitüberschreitung: Hermes antwortet nicht mehr. Bitte erneut senden.');
        if (err instanceof ChatError)
            throw err;
        throw new ChatError('network', 'Verbindung zu Hermes unterbrochen. Bitte erneut senden.');
    }
    finally {
        cleanup();
        try {
            reader.releaseLock();
        }
        catch { /* already released */ }
    }
    return full || 'Keine Antwort erhalten.';
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
/**
 * Parse one SSE event block (lines up to the blank-line separator). Handles the
 * three things the gateway emits: keepalive comments (`: …`, ignored), named
 * `hermes.tool.progress` / `hermes.error` events, and the default
 * `chat.completion.chunk` data carrying `choices[0].delta.content`. The terminal
 * `data: [DONE]` carries no text, so it naturally yields nothing.
 */
function parseSseEvent(raw) {
    let event = 'message';
    const dataLines = [];
    for (const line of raw.split(/\r?\n/)) {
        if (!line || line.startsWith(':'))
            continue; // blank or keepalive comment
        if (line.startsWith('event:'))
            event = line.slice(6).trim();
        else if (line.startsWith('data:'))
            dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (dataLines.length === 0)
        return {};
    const data = dataLines.join('\n');
    if (data === '[DONE]')
        return {};
    if (event === 'hermes.tool.progress') {
        try {
            return { progress: JSON.parse(data) };
        }
        catch {
            return {};
        }
    }
    if (event === 'hermes.error') {
        try {
            const o = JSON.parse(data);
            return { errorMsg: typeof o.error === 'string' ? o.error : 'Hermes-Fehler.' };
        }
        catch {
            return { errorMsg: 'Hermes-Fehler.' };
        }
    }
    // Default: an OpenAI-shaped streaming chunk.
    try {
        const o = JSON.parse(data);
        const piece = o.choices?.[0]?.delta?.content;
        if (typeof piece === 'string' && piece)
            return { delta: piece };
    }
    catch { /* non-JSON data line — ignore */ }
    return {};
}
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
