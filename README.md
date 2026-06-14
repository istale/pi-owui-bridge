# pi-owui-bridge

Communication layer between Open WebUI's chat API and a per-(user, chat)
Pi subprocess running in `--mode rpc`. The bridge does **not** run an
agent loop: that's Pi's job. The bridge just translates HTTP ↔ Pi RPC.

> **Status: Stage 12.** Brain lives in `pi --mode rpc`. Bridge is
> ~300 lines of HTTP-to-stdio translation. The extension at
> `extension/owui-tools.ts` teaches each Pi instance about Open WebUI's
> 5 data-analysis HTTP tools.

## Architecture

```
USER → Open WebUI → pi-owui-bridge ──RPC──> pi (subprocess) ──> Hub ──> MiniMax
                       (this repo)            │
                                              └ via owui-tools.ts extension
                                                ──HTTP──> Open WebUI tool service
```

- **Bridge** owns: HTTP server, OpenAI-format ↔ Pi RPC translation,
  per-(user_id, chat_id) Pi subprocess pool with idle eviction, symlinks
  for skill / observation directories into each Pi's cwd, models.json
  pre-seed pointing at Hub.
- **Pi** owns: agent loop, model call, tool dispatch, system prompt
  composition (skills, overlay annotation, hidden tombstone — all native
  Pi features), compaction, retry, streaming.
- **Extension** owns: discovering OWUI tool specs at session start and
  shelling each `execute()` callback over HTTP to OWUI.

## Environment

```sh
AOH_UPSTREAM_BASE_URL=http://127.0.0.1:43180/v1   # Hub
AOH_UPSTREAM_API_KEY=<any>                         # Hub auth pass-through
AOH_UPSTREAM_MODEL=MiniMax-M2
AOH_UPSTREAM_PROVIDER=aoh-hub                     # synthetic name in models.json

AOH_OWUI_BASE_URL=http://127.0.0.1:8080
AOH_PI_SHARED_SECRET=<shared with Open WebUI>

AOH_OBSERVATION_DIR=~/.pi/observation              # Pi reads overlays from here
AOH_SKILLS_DIR=~/.aoh/skills                       # symlinked into Pi cwd .pi/skills

AOH_PI_CLI_PATH=/path/to/pi/packages/coding-agent/dist/cli.js
AOH_PI_EXTENSION_PATH=/path/to/pi-owui-bridge/extension/dist/owui-tools.js

AOH_BRIDGE_PORT=19000
AOH_PI_IDLE_EVICT_MS=300000                        # 5 min default
```

## Build

```sh
npm install
npm run build         # compiles both src/ → dist/ and extension/ → extension/dist/
# or each half independently:
npm run build:bridge
npm run build:extension
```

## Run

```sh
npm start
```

## Test

End-to-end against real OWUI + Hub + fake upstream (no MiniMax cost):

```sh
AOH_PI_SHARED_SECRET=... \
AOH_OBSERVATION_DIR=~/.pi/observation \
AOH_SKILLS_DIR=~/.aoh/skills \
  node e2e/run.mjs --mode=fake
# 11/11 scenarios PASS
```

### Release-time canary (real LLM)

`e2e/canary.sh` runs a small subset against the real upstream so you
catch provider-behaviour drift that fake-mode masks (header changes,
streaming framing, schema strictness). Run before each release:

```sh
AOH_UPSTREAM_API_KEY=sk-real-key \
AOH_PI_SHARED_SECRET=... \
AOH_OBSERVATION_DIR=~/.pi/observation \
  ./e2e/canary.sh
```

This is **not** nightly — it costs money and there's no live customer
yet. Promote to a cron job once a real consumer is on the stack.
