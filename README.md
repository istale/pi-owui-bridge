# pi-owui-bridge

TypeScript service that fronts Open WebUI's chat completions and dispatches
tool calls back to OWUI's HTTP tool service. Replaces the Python `pi-adapter`
while leaving every other piece (Open WebUI's tool HTTP service, Hub overlay
snapshots, ledger correlation) unchanged.

> **Status: Phase 3 (branch `feature/coding-agent-runtime`).** The default
> runtime is **`pi-coding-agent`** — bridge is now the communication layer
> only, with the agent loop, tools, skills, sessions, and compaction all
> living in `@earendil-works/pi-coding-agent`. Upstream Pi improvements
> flow in via `npm update @earendil-works/pi-coding-agent`. Two earlier
> runtimes (`harness` direct pi-agent-core, `self` original DIY loop) stay
> behind `AOH_RUNTIME` for comparison / fallback.

## Why TS

When Phase 2 lands, depending on `@earendil-works/pi-agent-core` means
future upstream Pi improvements (provider compat, streaming bug fixes,
retry tuning) flow in via `npm update` instead of being ported by hand.
The Python `pi-adapter` reinvented an agent loop that would otherwise
need that maintenance burden ourselves.

## What's in scope (Phase 1)

- HTTP server with the same `/v1/chat/completions` contract as pi-adapter
- Tool discovery + dispatch through the OWUI service
- Skill markdown loaded per turn from `$AOH_SKILLS_DIR/<user>/*.md`
- Overlay snapshot read from
  `$AOH_OBSERVATION_DIR/overlays/chats/<user>/<chat>.json` and applied
  through the mixed scheme (system-prompt annotation + hidden tombstone)
- Observation events emitted as JSONL the hub tailer already ingests
- 29 vitest cases covering each module

## Runtime mode

| `AOH_RUNTIME=` | Brain lives in | Notes |
|---|---|---|
| `coding-agent` (default) | `@earendil-works/pi-coding-agent` (`createAgentSession`) | Bridge = comm layer only. `noTools:"builtin"` hides bash/read/edit/write; `InMemoryAuthStorage` holds the Hub key; tmpdir cwd/agentDir gets removed in a `finally`. |
| `harness` | `@earendil-works/pi-agent-core` (`AgentHarness`) | Lower-level than `coding-agent` — skips pi-coding-agent's skill loader / project trust / default tool set. |
| `self` | this repo (`src/agent-loop.ts`) | The original Phase-1 self-written OpenAI HTTP loop. Kept as a fallback / A-B comparison. |

Both modes go through the same `server.ts` wiring (overlay, skills,
observation, response shape) and emit byte-equivalent
`pi_adapter.aoh_trace_id` / `pi_adapter.overlay` / `pi_adapter.skills`
metadata so e2e scenarios run unchanged against either.

## What's deferred

- **Real mid-flight SSE streaming.** The `stream: true` endpoint
  currently runs the non-stream loop end-to-end, then emits the final
  assistant message as one SSE chunk plus `[DONE]`. The user sees the
  full answer once the loop completes — not token-by-token. The
  response carries `X-Aoh-Trace-Id` and the chunk includes
  `pi_adapter.iterations` so callers can still inspect what happened.
  Real streaming will land by subscribing to AgentHarness's
  `text_delta` / `tool_call_arguments_delta` events.

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
