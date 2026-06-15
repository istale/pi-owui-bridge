#!/usr/bin/env bash
# Install all four AOH repos, in dependency order:
#   1. pi             (pnpm)  — provides @earendil-works/pi-* dist that bridge file:-deps on
#   2. pi-owui-bridge (npm)   — links to pi via ../pi/packages/*
#   3. hub            (pip)   — independent Python service
#   4. open-webui-custom (pip + npm) — heaviest; runs last so failures here
#                                       don't block faster green signals
#
# Online mode (default): assumes network or enterprise mirrors are
# configured in ~/.npmrc / ~/.pip/pip.conf.
#
# Offline mode (AOH_OFFLINE=1): uses the vendor/ tree from offline-unpack
# exclusively; refuses to fall back to network.

. "$(dirname "$0")/lib/paths.sh"
aoh_require_repos

PY="${AOH_PY:-python3.12}"
OFFLINE="${AOH_OFFLINE:-0}"

if [ "$OFFLINE" = "1" ]; then
  aoh_info "Installing in OFFLINE mode (vendor/ only, no network)"
  for d in "$AOH_VENDOR_DIR/python/hub" "$AOH_VENDOR_DIR/python/open-webui-custom" \
           "$AOH_VENDOR_DIR/npm-cache/bridge" "$AOH_VENDOR_DIR/npm-cache/owui" \
           "$AOH_VENDOR_DIR/pnpm-store"; do
    [ -d "$d" ] || aoh_die "AOH_OFFLINE=1 but vendor cache missing: $d"
  done
else
  aoh_info "Installing in ONLINE mode (network or enterprise mirrors)"
fi
aoh_dump_paths
echo

# ---------- 1. pi (pnpm workspace) ----------
aoh_info "(1/4) pi   — pnpm install + build agent/ai/coding-agent"
cd "$AOH_PI_DIR"
if [ "$OFFLINE" = "1" ]; then
  pnpm install --offline --store-dir "$AOH_VENDOR_DIR/pnpm-store"
else
  pnpm install
fi
pnpm -C packages/agent build
pnpm -C packages/ai build
pnpm -C packages/coding-agent build
aoh_ok "pi installed and built"
echo

# ---------- 2. pi-owui-bridge (npm) ----------
aoh_info "(2/4) pi-owui-bridge — npm install + build"
cd "$AOH_BRIDGE_DIR"
if [ "$OFFLINE" = "1" ]; then
  npm install --offline --cache "$AOH_VENDOR_DIR/npm-cache/bridge"
else
  npm install
fi
npm run build
aoh_ok "bridge installed and built"
echo

# ---------- 3. hub (pip) ----------
aoh_info "(3/4) hub   — venv + pip install -e .[dev]"
cd "$AOH_HUB_DIR"
[ -d .venv ] || "$PY" -m venv .venv
if [ "$OFFLINE" = "1" ]; then
  ./.venv/bin/pip install --no-index --find-links "$AOH_VENDOR_DIR/python/hub" -e ".[dev]"
else
  ./.venv/bin/pip install -e ".[dev]"
fi
aoh_ok "hub installed"
echo

# ---------- 4. open-webui-custom (pip + npm) ----------
aoh_info "(4/4) open-webui-custom — venv + pip + npm (this is the slow one)"
cd "$AOH_OWUI_DIR"
[ -d .venv ] || "$PY" -m venv .venv
if [ "$OFFLINE" = "1" ]; then
  ./.venv/bin/pip install --no-index --find-links "$AOH_VENDOR_DIR/python/open-webui-custom" -e ".[dev]"
  npm install --offline --cache "$AOH_VENDOR_DIR/npm-cache/owui"
  # pyodide files for the frontend Python sandbox
  if [ -d "$AOH_VENDOR_DIR/pyodide" ] && [ ! -d static/pyodide ]; then
    aoh_dim "  - dropping pyodide WASM into static/pyodide"
    mkdir -p static/pyodide
    cp -R "$AOH_VENDOR_DIR/pyodide/." static/pyodide/
  fi
else
  ./.venv/bin/pip install -e ".[dev]"
  npm install
fi
aoh_ok "open-webui-custom installed"
echo

aoh_ok "All four repos installed."
echo
aoh_dim "Next: scripts/aoh/init-env.sh"
