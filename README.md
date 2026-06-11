# pi-owui-bridge

TypeScript bridge that fronts Open WebUI's chat completions with a Pi-style
agent runtime. Replaces the Python `pi-adapter` while leaving every other
piece (Open WebUI's tool HTTP service, Hub overlay snapshots, ledger
correlation) unchanged.

## Why TS, not Python

The Python adapter reinvented an agent loop (model → tool → model →
streaming). TypeScript lets us depend on `@earendil-works/pi-agent-core`
so future upstream Pi improvements (provider compat, streaming bug fixes,
retry tuning) flow in via `npm update` instead of being ported by hand.

## What's in scope (Phase 1)

- HTTP server with the same `/v1/chat/completions` contract as pi-adapter
- Tool discovery + dispatch through the OWUI service
- Skill markdown loaded per turn from `$AOH_SKILLS_DIR/<user>/*.md`
- Overlay snapshot read from
  `$AOH_OBSERVATION_DIR/overlays/chats/<user>/<chat>.json` and applied
  through the mixed scheme (system-prompt annotation + hidden tombstone)
- Observation events emitted as JSONL the hub tailer already ingests
- 29 vitest cases covering each module

## What's deferred (Phase 2)

- Switching the body of `runAgentLoop` to use `AgentHarness` from
  `@earendil-works/pi-agent-core`. The surrounding wiring (tool client,
  overlay loader, skills loader, observation emitter, server) is built
  to make that a one-file swap.
- True mid-flight SSE streaming with tool dispatch (current streaming
  endpoint runs the non-stream loop and emits the final assistant
  message as one SSE chunk).

## Environment

```sh
AOH_UPSTREAM_BASE_URL=http://127.0.0.1:43180/v1
AOH_UPSTREAM_API_KEY=any
AOH_UPSTREAM_MODEL=MiniMax-M2
AOH_OWUI_BASE_URL=http://127.0.0.1:8080
AOH_PI_SHARED_SECRET=<shared with Open WebUI>
AOH_OBSERVATION_DIR=~/.aoh/observation
AOH_SKILLS_DIR=~/.aoh/skills
AOH_BRIDGE_PORT=19000
```

## Run

```sh
npm install
npm run build
npm start
```

Or in dev:

```sh
npm run dev
```

## Test

```sh
npm test
```

## Wire Open WebUI at it

In OWUI's `.env`:

```sh
OPENAI_API_BASE_URLS=http://127.0.0.1:19000/v1
OPENAI_API_KEYS=ignored
```
