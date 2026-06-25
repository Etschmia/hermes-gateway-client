# @hermes/gateway-client

Shared client + server core for talking to the **local Hermes
OpenAI-compatible gateway** (`127.0.0.1:8081`). Extracted so the same
hard-won robustness (timeouts, error classification, safe retry) lives in **one
place** instead of being copy-pasted into every app that hangs off the gateway.

Consumed today by `hermes-chat` and `depot3`; built to take more.

## Why this exists

The gateway is a real tool-using agent — a turn can take tens of seconds. Over a
phone connection that long-lived POST is fragile, and a bare `fetch` collapses
every network blip into the opaque `TypeError: Failed to fetch`. This package
turns that into a controlled timeout, a typed/actionable error, and a *narrow,
side-effect-safe* retry that never re-runs a turn that may already have fired a
tool.

## Install (git dependency, pinned by tag)

```jsonc
// package.json of each consumer
"dependencies": {
  "@hermes/gateway-client": "git+ssh://git@<host>/hermes-gateway-client#v0.1.0"
}
```

No registry required. Pin a tag per consumer so apps upgrade independently.
The compiled `dist/` is committed, so the install needs no build step or
toolchain on the consumer side.

## Usage

### Browser — `@hermes/gateway-client/browser`

```ts
import { postChat, assistantText, ChatError } from '@hermes/gateway-client/browser';

try {
  const data = await postChat(apiMessages);          // owns timeout + safe retry
  const text = assistantText(data);
} catch (e) {
  if (e instanceof ChatError) showError(e.message);   // already a German sentence
}
```

### Server — `@hermes/gateway-client/server`

Framework-neutral: returns a web `Response`, which a Next.js route handler can
return directly. Each app keeps its own auth / system-prompt assembly and hands
the final `messages` in.

```ts
import { forwardToGateway, gatewayConfigFromEnv } from '@hermes/gateway-client/server';

export async function POST(request: Request) {
  const { messages } = await request.json();
  // ...app-specific auth + system-prompt injection here...
  return forwardToGateway(messages, gatewayConfigFromEnv());
}
```

## Develop

```bash
bun install
bun run build      # tsc → dist/ (commit dist before tagging a release)
```

Cut a release: bump `version`, `bun run build`, commit `dist/`, `git tag vX.Y.Z`,
then bump the tag in each consumer's `package.json` and reinstall.

## Scope

v0.1.0 covers the **chat transport** only. Attachment helpers (`toApiContent`,
`fileToAttachment`) are still duplicated per-app and are the obvious next
candidate to fold in under a `/browser` re-export.
