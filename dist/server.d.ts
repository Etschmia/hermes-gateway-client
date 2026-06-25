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
/** Best-effort human-readable message out of an upstream error payload. */
export declare function safeDetail(text: string): string;
