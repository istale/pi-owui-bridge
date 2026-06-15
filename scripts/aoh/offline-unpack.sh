#!/usr/bin/env bash
# Run on the OFFLINE machine AFTER extracting the tarball.
#
# What it does:
#   1. confirms the bundle layout is intact (repos/, vendor/, scripts/aoh/, MANIFEST)
#   2. for each repo, unbundles the git history into a working tree
#   3. prints the manifest so the team knows which bridge sha they have
#
# Assumes you ran something like:
#   mkdir ~/aoh && tar -C ~/aoh -xzf aoh-offline-bundle-*.tar.gz
#   cd ~/aoh && ./scripts/aoh/offline-unpack.sh

. "$(dirname "$0")/lib/paths.sh"

# DO NOT call aoh_require_repos here — the dirs don't exist yet; this
# script creates them.

if [ ! -d "$AOH_WORKSPACE_ROOT/repos" ]; then
  aoh_die "missing $AOH_WORKSPACE_ROOT/repos — did you extract the bundle in the right place?
Expected layout:
  $AOH_WORKSPACE_ROOT/repos/{pi,pi-owui-bridge,hub,open-webui-custom}.bundle
  $AOH_WORKSPACE_ROOT/vendor/...
  $AOH_WORKSPACE_ROOT/scripts/aoh/..."
fi

if [ -f "$AOH_WORKSPACE_ROOT/MANIFEST" ]; then
  aoh_info "Bundle manifest:"
  sed 's/^/  /' "$AOH_WORKSPACE_ROOT/MANIFEST"
  echo
fi

# ---------- unbundle each repo ----------
for repo in pi pi-owui-bridge hub open-webui-custom; do
  bundle="$AOH_WORKSPACE_ROOT/repos/$repo.bundle"
  dest="$AOH_WORKSPACE_ROOT/$repo"
  if [ ! -f "$bundle" ]; then
    aoh_err "missing bundle: $bundle"
    exit 1
  fi
  if [ -d "$dest/.git" ]; then
    aoh_dim "$repo: already cloned at $dest (skipping)"
    continue
  fi
  aoh_info "Cloning $repo from bundle"
  git clone "$bundle" "$dest"
  # Detach from the bundle file so the working clone is portable.
  (cd "$dest" && git remote remove origin 2>/dev/null || true)
done

aoh_ok "All four repos materialised at:"
aoh_dim "  $AOH_PI_DIR"
aoh_dim "  $AOH_BRIDGE_DIR"
aoh_dim "  $AOH_HUB_DIR"
aoh_dim "  $AOH_OWUI_DIR"

# Verify vendor layout
echo
aoh_info "Vendor layout:"
for sub in vendor/python/hub vendor/python/open-webui-custom \
           vendor/npm-cache/bridge vendor/npm-cache/owui \
           vendor/pnpm-store; do
  p="$AOH_WORKSPACE_ROOT/$sub"
  if [ -d "$p" ]; then
    count=$(find "$p" -type f 2>/dev/null | wc -l | tr -d ' ')
    aoh_ok "$sub ($count files)"
  else
    aoh_warn "$sub missing (offline install for that lane will need to hit the enterprise mirror)"
  fi
done

echo
aoh_dim "Next: scripts/aoh/check-environment.sh"
