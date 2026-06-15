#!/usr/bin/env bash
# Run on the ONLINE machine. Bundles everything the offline machine needs
# to install all four AOH repos: source code, dependency caches, vendor
# wheels, and these scripts themselves.
#
# Output:
#   $AOH_WORKSPACE_ROOT/dist/aoh-offline-bundle-YYYYMMDD-<sha>.tar.gz
#
# On the offline machine: extract and run scripts/aoh/offline-unpack.sh
# from within. See ../README.md for the full flow.
#
# Idempotent: re-run any time. Each step is skippable via env var
# (AOH_SKIP_PY=1, AOH_SKIP_NODE=1, AOH_SKIP_PYODIDE=1) when iterating.

. "$(dirname "$0")/lib/paths.sh"
aoh_require_repos

DATE="$(date -u +%Y%m%d)"
GIT_SHA="$(cd "$AOH_BRIDGE_DIR" && git rev-parse --short HEAD)"
STAGE="$(mktemp -d -t aoh-prep-XXXX)"
OUT_DIR="$AOH_WORKSPACE_ROOT/dist"
OUT="$OUT_DIR/aoh-offline-bundle-${DATE}-${GIT_SHA}.tar.gz"
mkdir -p "$OUT_DIR"

PY="${AOH_PY:-python3.12}"

aoh_info "Staging offline bundle at $STAGE"
aoh_dim "Output: $OUT"
echo

# ---------- 1. git bundles (history preserved, small) ----------
aoh_info "(1/5) git bundle each repo"
mkdir -p "$STAGE/repos"
for repo in pi pi-owui-bridge hub open-webui-custom; do
  case "$repo" in
    pi)               src="$AOH_PI_DIR" ;;
    pi-owui-bridge)   src="$AOH_BRIDGE_DIR" ;;
    hub)              src="$AOH_HUB_DIR" ;;
    open-webui-custom) src="$AOH_OWUI_DIR" ;;
  esac
  aoh_dim "  - bundling $repo from $src"
  (cd "$src" && git bundle create "$STAGE/repos/$repo.bundle" HEAD --branches --tags)
done

# ---------- 2. python wheels ----------
if [ "${AOH_SKIP_PY:-0}" != "1" ]; then
  aoh_info "(2/5) downloading Python wheels"

  aoh_dim "  - hub (small, fast)"
  mkdir -p "$STAGE/vendor/python/hub"
  "$PY" -m pip download \
      --dest "$STAGE/vendor/python/hub" \
      --quiet \
      "$AOH_HUB_DIR[dev]" \
      || aoh_die "pip download for hub failed"

  aoh_dim "  - open-webui-custom (heavy, ~3GB, can take 5-10 min)"
  mkdir -p "$STAGE/vendor/python/open-webui-custom"
  "$PY" -m pip download \
      --dest "$STAGE/vendor/python/open-webui-custom" \
      --quiet \
      "$AOH_OWUI_DIR[dev]" \
      || aoh_die "pip download for open-webui-custom failed"
else
  aoh_warn "AOH_SKIP_PY=1 set; skipping Python wheel download"
fi

# ---------- 3. npm + pnpm caches ----------
if [ "${AOH_SKIP_NODE:-0}" != "1" ]; then
  aoh_info "(3/5) hydrating npm + pnpm caches"

  aoh_dim "  - bridge: npm install --cache to populate tarball cache"
  mkdir -p "$STAGE/vendor/npm-cache/bridge"
  (cd "$AOH_BRIDGE_DIR" \
     && npm install --cache "$STAGE/vendor/npm-cache/bridge" --prefer-offline --ignore-scripts) \
     || aoh_warn "bridge npm cache hydration had non-zero exit; continuing"

  aoh_dim "  - owui: same"
  mkdir -p "$STAGE/vendor/npm-cache/owui"
  (cd "$AOH_OWUI_DIR" \
     && npm install --cache "$STAGE/vendor/npm-cache/owui" --prefer-offline --ignore-scripts) \
     || aoh_warn "owui npm cache hydration had non-zero exit; continuing"

  aoh_dim "  - pi: pnpm fetch into shared store"
  mkdir -p "$STAGE/vendor/pnpm-store"
  (cd "$AOH_PI_DIR" && pnpm fetch --store-dir "$STAGE/vendor/pnpm-store") \
    || aoh_die "pnpm fetch failed"
else
  aoh_warn "AOH_SKIP_NODE=1 set; skipping npm/pnpm cache hydration"
fi

# ---------- 4. pyodide WASM packages ----------
if [ "${AOH_SKIP_PYODIDE:-0}" != "1" ]; then
  if [ -f "$AOH_OWUI_DIR/scripts/prepare-pyodide.js" ]; then
    aoh_info "(4/5) caching pyodide WASM via OWUI's prepare-pyodide.js"
    (cd "$AOH_OWUI_DIR" && node scripts/prepare-pyodide.js) \
      || aoh_warn "prepare-pyodide.js failed; offline frontend may miss Python sandbox"
    if [ -d "$AOH_OWUI_DIR/static/pyodide" ]; then
      mkdir -p "$STAGE/vendor/pyodide"
      cp -R "$AOH_OWUI_DIR/static/pyodide/." "$STAGE/vendor/pyodide/"
    fi
  else
    aoh_warn "(4/5) prepare-pyodide.js not found in OWUI; skipping"
  fi
else
  aoh_warn "AOH_SKIP_PYODIDE=1 set; skipping pyodide caching"
fi

# ---------- 5. ship the aoh scripts themselves ----------
aoh_info "(5/5) including aoh scripts in the bundle"
mkdir -p "$STAGE/scripts"
cp -R "$AOH_SCRIPTS_DIR" "$STAGE/scripts/aoh"

cat > "$STAGE/MANIFEST" <<EOF
aoh-offline-bundle
  generated_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)
  bridge_sha:   $GIT_SHA
  host:         $(hostname)
  user:         ${USER:-unknown}
EOF

aoh_info "Creating tarball ..."
tar -C "$STAGE" -czf "$OUT" .
size=$(du -h "$OUT" | awk '{print $1}')
aoh_ok "Bundle ready: $OUT ($size)"
rm -rf "$STAGE"

echo
aoh_dim "Next steps on the offline machine:"
aoh_dim "  1. transfer $(basename "$OUT") to the team dev host"
aoh_dim "  2. mkdir ~/aoh && tar -C ~/aoh -xzf $(basename "$OUT")"
aoh_dim "  3. ~/aoh/scripts/aoh/offline-unpack.sh"
aoh_dim "  4. ~/aoh/scripts/aoh/check-environment.sh"
aoh_dim "  5. ~/aoh/scripts/aoh/install-all.sh"
