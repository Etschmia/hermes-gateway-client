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

## Install (GitHub dependency, pinned by tag)

```jsonc
// package.json of each consumer
"dependencies": {
  "@hermes/gateway-client": "github:Etschmia/hermes-gateway-client#v0.2.0"
}
```

```bash
bun add github:Etschmia/hermes-gateway-client#v0.2.0
```

No registry required. Pin a tag per consumer so apps upgrade independently.
The compiled `dist/` is committed, so the install needs no build step or
toolchain on the consumer side.

> **Why `github:` and not `git+ssh`/`git+file`?** bun 1.3.x cannot install git
> dependencies here (its git clone fails where plain `git` succeeds), and its
> `github:` path downloads an HTTPS tarball that only works for a **public**
> repo. Hence: public repo + `github:` tag. Keep the tree clean (no committed
> `bun.lock` / `*.tgz`) or bun throws `DependencyLoop`.

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

### Attachments — `@hermes/gateway-client/attachments`

Browser-only helpers for the composer: image downscale → JPEG data-URL, text
files inlined, and `toApiContent` to build the per-message `content` (plain
string, or OpenAI multimodal parts when images are present).

```ts
import { fileToAttachment, toApiContent, type Attachment } from '@hermes/gateway-client/attachments';
```

## Release / Upgrade

1. Bump `version` in `package.json`.
2. `bun run build` — regenerates `dist/` (committed; consumers run no build step).
3. Commit `dist/`, then `git tag vX.Y.Z && git push origin master --tags`.
4. In each consuming app, **remove then re-add** the dep, then rebuild the app —
   bun throws `DependencyLoop` if you `bun add` a new tag *over* the existing
   install, so the remove is mandatory:
   ```bash
   bun remove @hermes/gateway-client
   bun add github:Etschmia/hermes-gateway-client#vX.Y.Z
   ```

> **Never commit `bun.lock` or a packed `*.tgz`.** The `github:` install tarballs
> the whole git tree, so a committed lockfile or a nested package tarball makes
> bun throw `DependencyLoop`. Both are gitignored. `dist/` **is** committed — the
> install runs no build step or toolchain on the consumer side.

Local package development:

```bash
bun install        # dev deps (typescript only)
bun run build      # tsc → dist/
```

## Streaming (SSE)

A deep agent turn can keep one blocking POST byte-silent for minutes, and an
idle-connection timeout anywhere in the path (an HTTP/3 proxy at ~120s, the
gateway, the client) severs it — surfacing as a bare `Failed to fetch`. The
streaming path defeats this: the gateway emits a `: keepalive` every ~30s plus
`hermes.tool.progress` events, so bytes never stop flowing.

```ts
// server route — pass request.signal so a client disconnect cancels the turn
import { forwardToGatewayStream, gatewayConfigFromEnv } from '@hermes/gateway-client/server';
if (body.stream) return forwardToGatewayStream(body.messages, gatewayConfigFromEnv(), request.signal);

// browser — tokens arrive incrementally; an inactivity watchdog (not a total
// cap) ends a genuinely dead gateway with a typed ChatError. No auto-retry.
import { streamChat } from '@hermes/gateway-client/browser';
const full = await streamChat(apiMessages, {
  onDelta: (_piece, running) => setText(running),
  onProgress: (p) => setStatus(`${p.emoji ?? ''} ${p.label ?? p.tool ?? ''}`),
});
```

## Scope

- `/browser` — `postChat`, `streamChat`, `assistantText`, `ChatError` (the chat transport).
- `/server` — `forwardToGateway`, `forwardToGatewayStream`, `gatewayConfigFromEnv` (framework-neutral proxy core).
- `/attachments` — `fileToAttachment`, `toApiContent`, `Attachment` & co.
  (browser image-downscale + text-inlining for the composer).

Consumed today by `hermes-chat` and `depot3`; built to take more.
