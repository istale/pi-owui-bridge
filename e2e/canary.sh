#!/usr/bin/env bash
# Release-time canary: run a small subset of e2e scenarios against the
# real LLM provider (default MiniMax) to catch behaviour drift that
# fake-mode can't see (header changes, streaming framing, prompt template
# rejections, schema strictness, etc).
#
# Usage:
#   AOH_LLM_API_KEY=sk-... ./e2e/canary.sh
#   # or, with the deprecated alias still honoured:
#   AOH_UPSTREAM_API_KEY=sk-... ./e2e/canary.sh
#
# This is NOT a nightly job — it costs real money and only catches
# drift that matters when there's a live consumer. Run before release.
# When a customer goes live, promote the same script into a nightly
# cron under repos/<provider>-canary.
set -euo pipefail

if [[ -z "${AOH_LLM_API_KEY:-}${AOH_UPSTREAM_API_KEY:-}" ]]; then
  echo "AOH_LLM_API_KEY must be set (real provider key). Legacy AOH_UPSTREAM_API_KEY also accepted." >&2
  exit 1
fi

# Canary subset: smallest scenarios that still hit each integration
# surface (Pi spawn, OWUI tool call, hub trace ingest, overlay annotation).
# Order chosen so a failure surfaces the broken layer fast.
SCENARIOS="stack-up,tool-dispatch,overlay-stale,skill-inject"

REPORT="${REPORT_FILE:-/tmp/aoh-canary-$(date -u +%Y%m%dT%H%M%SZ).json}"

echo "Canary scenarios: ${SCENARIOS}"
echo "Report: ${REPORT}"
echo

node e2e/run.mjs \
  --mode=real \
  --scenario="${SCENARIOS}" \
  --report-file="${REPORT}"

echo
echo "Pass. Report saved to ${REPORT}"
