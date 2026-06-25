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
