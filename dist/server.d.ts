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
/** Read a GatewayConfig from environment variables (server-side only). */
export declare function gatewayConfigFromEnv(env?: Record<string, string | undefined>): GatewayConfig;
/**
 * Forward an already-assembled `messages` array to the gateway and return the
 * OpenAI-shaped completion as a Response. Failures map to the JSON shape the
 * UIs already understand — `{ error, detail? }` with 400/500/502/504 — so the
 * browser-side postChat() surfaces an actionable message.
 */
export declare function forwardToGateway(messages: unknown, cfg: GatewayConfig): Promise<Response>;
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
export declare function forwardToGatewayStream(messages: unknown, cfg: GatewayConfig, signal?: AbortSignal): Promise<Response>;
/** Best-effort human-readable message out of an upstream error payload. */
export declare function safeDetail(text: string): string;
