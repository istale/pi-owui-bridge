# AOH end-to-end runner — built for AI agents

This directory ships scenarios that exercise the whole stack
(`OWUI tool service → bridge → upstream LLM → bridge → OWUI`) without
any browser. An AI agent can run the suite, read the structured report,
and propose changes — that's the closing of the loop the project was
built for.

## What it covers (Phase 1)

- **stack-up**: every healthz endpoint is reachable and reports the
  expected feature flags
- **tool-dispatch**: send a turn that should call ``list_datasets``;
  assert via Hub's `/api/assertions/session-summary` that the model
  call happened and OWUI's ledger received the event with the same
  `aoh_trace_id`
- **overlay-stale**: mark a turn `stale`, send the next turn, and use
  Hub's `/api/assertions/payload-inspect/<trace>` to confirm "STALE"
  appears in the system prompt the model actually saw
- **skill-inject**: write a tiny skill markdown, send a turn, and
  confirm the skill name appears in `pi_adapter.skills.names` and the
  skill body is in the system prompt the model saw

## How to run

Two modes:

```sh
# zero-cost: bridge uses an in-process fake upstream that scripts canned
# tool-use → final-text responses. Suitable for CI / pre-merge gating.
node e2e/run.mjs --mode=fake

# real upstream: hits MiniMax (or whatever AOH_UPSTREAM_BASE_URL points
# at) for one short turn per scenario, capped at 200 max_tokens.
node e2e/run.mjs --mode=real
```

Each scenario can be run on its own:

```sh
node e2e/run.mjs --mode=fake --scenario=overlay-stale
```

## Prerequisites

| Mode | Need running |
|---|---|
| `fake` | OWUI backend, Hub, bridge (bridge gets a fake upstream injected; no MiniMax cost) |
| `real` | OWUI backend, Hub, bridge (with real `AOH_UPSTREAM_API_KEY`) |

Set these env vars before running (same ones the bridge reads):

```sh
export AOH_OWUI_BASE_URL=http://127.0.0.1:8080
export AOH_BRIDGE_BASE_URL=http://127.0.0.1:19000
export AOH_HUB_BASE_URL=http://127.0.0.1:43180
export AOH_PI_SHARED_SECRET=<the shared secret>
# real mode only:
export AOH_UPSTREAM_API_KEY=<minimax key>
```

## Output

A JSON report at stdout (and `--report-file` if you want it saved):

```json
{
  "started_at": "2026-06-11T00:00:00Z",
  "mode": "fake",
  "scenarios": [
    { "name": "stack-up", "passed": true, "duration_ms": 21, "evidence": {...} },
    { "name": "tool-dispatch", "passed": true, ... },
    { "name": "overlay-stale", "passed": true, ... },
    { "name": "skill-inject", "passed": true, ... }
  ],
  "summary": { "total": 4, "passed": 4, "failed": 0 }
}
```

Exit code is non-zero if any scenario fails.

## Notes for AI agents

- Every assertion uses an HTTP endpoint — no log scraping, no DB read.
- `evidence` is the raw response from the assertion endpoint; quote
  fields from it when proposing a fix, not from logs.
- The runner is intentionally side-effecting in `real` mode (creates
  ledger rows, snapshot files). Run against a dev hub, not production.
- The bridge offers a refresh endpoint
  (`POST /v1/tool-specs/refresh`) so a scenario can take effect even
  if OWUI's tool list changed mid-run.
