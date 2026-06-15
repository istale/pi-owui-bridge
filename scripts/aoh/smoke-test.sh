#!/usr/bin/env bash
# Bring up hub + owui backend + bridge, run all three test suites + the
# bridge e2e (fake mode). Tears everything down on exit.
#
# Frontend (vite :5173) is NOT started — that's left for human eyes
# after this finishes green.
#
# Exit codes:
#   0  — all green
#   1  — startup failure (a service didn't come up)
#   2  — test suite failure
#
# Useful env vars:
#   AOH_SKIP_HUB_TESTS=1     skip hub pytest
#   AOH_SKIP_OWUI_TESTS=1    skip owui pytest
#   AOH_SKIP_E2E=1           skip bridge e2e
#   AOH_KEEP_RUNNING=1       leave services up after tests for manual poking

. "$(dirname "$0")/lib/paths.sh"
aoh_require_repos

PY_HUB="$AOH_HUB_DIR/.venv/bin/python"
PY_OWUI="$AOH_OWUI_DIR/.venv/bin/python"
[ -x "$PY_HUB" ]  || aoh_die "hub venv missing — run install-all.sh first"
[ -x "$PY_OWUI" ] || aoh_die "owui venv missing — run install-all.sh first"

# Load .env files into the shell environment (smoke-test needs the
# shared secret to actually exercise the OWUI tool path).
load_env() {
  local f="$1"
  [ -f "$f" ] || return 0
  set -a
  # shellcheck disable=SC1090
  . "$f"
  set +a
}
load_env "$AOH_HUB_DIR/.env"
load_env "$AOH_BRIDGE_DIR/.env"
load_env "$AOH_OWUI_DIR/.env"

LOG_DIR="$(mktemp -d -t aoh-smoke-XXXX)"
PIDS=()

cleanup() {
  if [ "${AOH_KEEP_RUNNING:-0}" = "1" ]; then
    aoh_warn "AOH_KEEP_RUNNING=1, leaving ${#PIDS[@]} processes alive:"
    for pid in "${PIDS[@]}"; do aoh_dim "  pid $pid"; done
    aoh_dim "logs at $LOG_DIR"
    return
  fi
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  rm -rf "$LOG_DIR"
}
trap cleanup EXIT

wait_for_port() {
  local label="$1" url="$2" deadline=$(( $(date +%s) + 30 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -sf -o /dev/null "$url"; then
      aoh_ok "$label up"
      return 0
    fi
    sleep 1
  done
  aoh_err "$label did not respond at $url within 30s"
  return 1
}

# ---------- start hub :43180 ----------
aoh_info "Starting hub (port 43180)"
(
  cd "$AOH_HUB_DIR"
  AOH_OBSERVATION_DIR="${AOH_OBSERVATION_DIR}" \
    "$PY_HUB" -m uvicorn app.main:app --host 127.0.0.1 --port 43180 \
    > "$LOG_DIR/hub.log" 2>&1
) &
PIDS+=($!)

wait_for_port hub http://127.0.0.1:43180/healthz || {
  aoh_err "hub log:"
  tail -30 "$LOG_DIR/hub.log" >&2
  exit 1
}

# ---------- start owui backend :8080 ----------
aoh_info "Starting OWUI backend (port 8080)"
(
  cd "$AOH_OWUI_DIR/backend"
  PYTHONPATH=. "$PY_OWUI" -m uvicorn open_webui.main:app --host 127.0.0.1 --port 8080 \
    > "$LOG_DIR/owui.log" 2>&1
) &
PIDS+=($!)

# OWUI startup is slower — give it 60s.
wait_for_port_60() {
  local label="$1" url="$2" deadline=$(( $(date +%s) + 60 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -sf -o /dev/null "$url"; then
      aoh_ok "$label up"
      return 0
    fi
    sleep 2
  done
  aoh_err "$label did not respond at $url within 60s"
  return 1
}
wait_for_port_60 owui http://127.0.0.1:8080/health || {
  aoh_err "owui log:"
  tail -30 "$LOG_DIR/owui.log" >&2
  exit 1
}

# ---------- start bridge :19000 ----------
aoh_info "Starting bridge (port 19000)"
(
  cd "$AOH_BRIDGE_DIR"
  npm start > "$LOG_DIR/bridge.log" 2>&1
) &
PIDS+=($!)

wait_for_port bridge http://127.0.0.1:19000/healthz || {
  aoh_err "bridge log:"
  tail -30 "$LOG_DIR/bridge.log" >&2
  exit 1
}

echo
aoh_ok "All three services up. Running test suites."
echo

fail=0

# ---------- bridge unit ----------
aoh_info "bridge: npm test"
(cd "$AOH_BRIDGE_DIR" && npm test 2>&1 | tail -15) || fail=1

# ---------- hub pytest ----------
if [ "${AOH_SKIP_HUB_TESTS:-0}" != "1" ]; then
  aoh_info "hub: pytest"
  (cd "$AOH_HUB_DIR" \
    && .venv/bin/python -m pytest tests/ -q --no-header \
         --ignore=tests/test_correlations.py \
         --ignore=tests/test_ingress_routes.py \
         --ignore=tests/test_openai_proxy_errors.py \
         --ignore=tests/test_openai_proxy_non_stream.py \
         --ignore=tests/test_openai_proxy_stream.py \
       2>&1 | tail -8) || fail=1
fi

# ---------- owui data_analysis ----------
if [ "${AOH_SKIP_OWUI_TESTS:-0}" != "1" ]; then
  aoh_info "owui: pytest tests/data_analysis"
  (cd "$AOH_OWUI_DIR" \
    && .venv/bin/python -m pytest tests/data_analysis/ -q --no-header 2>&1 | tail -8) || fail=1
fi

# ---------- bridge e2e (fake mode) ----------
if [ "${AOH_SKIP_E2E:-0}" != "1" ]; then
  aoh_info "bridge: e2e (mode=fake)"
  (cd "$AOH_BRIDGE_DIR" \
    && AOH_PI_SHARED_SECRET="$AOH_PI_SHARED_SECRET" \
       AOH_OBSERVATION_DIR="$AOH_OBSERVATION_DIR" \
       AOH_SKILLS_DIR="$AOH_SKILLS_DIR" \
       node e2e/run.mjs --mode=fake 2>&1 | tail -8) || fail=1
fi

echo
if [ "$fail" -eq 0 ]; then
  aoh_ok "Smoke test PASS"
  exit 0
else
  aoh_err "Smoke test FAILED. Logs at $LOG_DIR"
  exit 2
fi
