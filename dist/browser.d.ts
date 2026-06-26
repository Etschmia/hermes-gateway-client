export interface ApiMessage {
    role: 'user' | 'assistant';
    content: unknown;
}
export type ChatErrorKind = 'offline' | 'timeout' | 'network' | 'http';
/** A failure talking to the gateway, pre-classified with a user-facing message. */
export declare class ChatError extends Error {
    readonly kind: ChatErrorKind;
    readonly status?: number;
    constructor(kind: ChatErrorKind, message: string, status?: number);
}
export interface PostChatOptions {
    /** Proxy endpoint. Default '/api/chat'. */
    endpoint?: string;
    /** Client-side cap in ms. Default 240_000 — deliberately above the server's
     *  HERMES_TIMEOUT_MS (180s) so the server's clean 504 surfaces first. */
    timeoutMs?: number;
    /** Caller cancellation (e.g. the user navigated away). */
    signal?: AbortSignal;
    /** Retry a connection failure only when it rejects within this window (ms).
     *  A near-instant rejection means the request never reached the agent, so a
     *  retry can't double-fire a tool. Set 0 to disable. Default 1500. */
    fastFailRetryMs?: number;
    /** Max auto-retries for fast connection failures. Default 2. */
    maxRetries?: number;
    /** Called before each retry (1-based attempt). */
    onRetry?: (attempt: number) => void;
}
export interface ChatCompletion {
    choices?: Array<{
        message?: {
            content?: string;
        };
    }>;
    [k: string]: unknown;
}
/** POST a turn to the gateway proxy and return the OpenAI-shaped completion. */
export declare function postChat(messages: ApiMessage[], options?: PostChatOptions): Promise<ChatCompletion>;
/** Pull the assistant's text out of a completion (with a sane fallback). */
export declare function assistantText(data: ChatCompletion): string;
/** A live tool-progress notification the gateway emits while the agent works. */
export interface StreamProgress {
    tool?: string;
    emoji?: string;
    label?: string;
    toolCallId?: string;
}
export interface StreamChatOptions {
    /** Proxy endpoint. Default '/api/chat'. */
    endpoint?: string;
    /** Caller cancellation (e.g. the user navigated away or hit stop). */
    signal?: AbortSignal;
    /** Abort if NO byte arrives for this long. The gateway sends a keepalive every
     *  ~30s, so a real stall is unambiguous. Default 90_000. This is an INACTIVITY
     *  cap, not a total cap — a healthy turn may run for minutes. */
    idleTimeoutMs?: number;
    /** Called for each new piece of assistant text. `full` is the running total. */
    onDelta?: (delta: string, full: string) => void;
    /** Called when the agent reports tool progress (search, read, …). */
    onProgress?: (info: StreamProgress) => void;
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
export declare function streamChat(messages: ApiMessage[], options?: StreamChatOptions): Promise<string>;
