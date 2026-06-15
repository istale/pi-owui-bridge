# Shared path resolver for AOH scripts. source this from every script:
#   . "$(dirname "$0")/lib/paths.sh"
#
# Layout assumption: the 4 repos are siblings under AOH_WORKSPACE_ROOT.
# That's required, not a preference — pi-owui-bridge's package.json has
# ``file:../pi/packages/agent`` which can't be relaxed without breaking
# the dependency resolution.
#
# Override precedence:
#   1. ``AOH_<REPO>_DIR``        — pin a single repo's location
#   2. ``AOH_WORKSPACE_ROOT``    — pin all four together
#   3. script-location autodetect (default; works for the standard layout)

set -euo pipefail

# Resolve script location through symlinks. Works on macOS bash 3.x +
# GNU bash 4+. We rely on BASH_SOURCE because $0 is the *caller*, not
# this lib file.
_aoh_resolve() {
  local source="${BASH_SOURCE[0]}"
  while [ -h "$source" ]; do
    local dir
    dir="$(cd "$(dirname "$source")" && pwd)"
    source="$(readlink "$source")"
    case "$source" in
      /*) ;;
      *) source="$dir/$source" ;;
    esac
  done
  cd "$(dirname "$source")" && pwd
}

AOH_LIB_DIR="$(_aoh_resolve)"
AOH_SCRIPTS_DIR="$(cd "$AOH_LIB_DIR/.." && pwd)"   # scripts/aoh
AOH_BRIDGE_DIR_DEFAULT="$(cd "$AOH_SCRIPTS_DIR/../.." && pwd)"   # pi-owui-bridge
AOH_WORKSPACE_ROOT_DEFAULT="$(dirname "$AOH_BRIDGE_DIR_DEFAULT")"

AOH_WORKSPACE_ROOT="${AOH_WORKSPACE_ROOT:-$AOH_WORKSPACE_ROOT_DEFAULT}"

AOH_PI_DIR="${AOH_PI_DIR:-$AOH_WORKSPACE_ROOT/pi}"
AOH_BRIDGE_DIR="${AOH_BRIDGE_DIR:-$AOH_WORKSPACE_ROOT/pi-owui-bridge}"
AOH_HUB_DIR="${AOH_HUB_DIR:-$AOH_WORKSPACE_ROOT/hub}"
AOH_OWUI_DIR="${AOH_OWUI_DIR:-$AOH_WORKSPACE_ROOT/open-webui-custom}"
AOH_VENDOR_DIR="${AOH_VENDOR_DIR:-$AOH_WORKSPACE_ROOT/vendor}"

# Logging helpers — colour-aware, NO_COLOR-aware.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  AOH_C_OK="\033[32m"; AOH_C_WARN="\033[33m"; AOH_C_ERR="\033[31m"
  AOH_C_DIM="\033[2m"; AOH_C_BOLD="\033[1m"; AOH_C_RESET="\033[0m"
else
  AOH_C_OK=""; AOH_C_WARN=""; AOH_C_ERR=""
  AOH_C_DIM=""; AOH_C_BOLD=""; AOH_C_RESET=""
fi

aoh_info()  { printf "%b[aoh]%b %s\n" "$AOH_C_BOLD" "$AOH_C_RESET" "$*"; }
aoh_ok()    { printf "%b[ok]%b %s\n" "$AOH_C_OK" "$AOH_C_RESET" "$*"; }
aoh_warn()  { printf "%b[warn]%b %s\n" "$AOH_C_WARN" "$AOH_C_RESET" "$*" >&2; }
aoh_err()   { printf "%b[err]%b %s\n" "$AOH_C_ERR" "$AOH_C_RESET" "$*" >&2; }
aoh_dim()   { printf "%b%s%b\n" "$AOH_C_DIM" "$*" "$AOH_C_RESET"; }

aoh_die() {
  aoh_err "$*"
  exit 1
}

# Verify the four repo dirs exist. Most scripts call this right after
# sourcing paths.sh; offline-prep is the exception because it builds
# the dirs from scratch.
aoh_require_repos() {
  local missing=()
  for d in "$AOH_PI_DIR" "$AOH_BRIDGE_DIR" "$AOH_HUB_DIR" "$AOH_OWUI_DIR"; do
    [ -d "$d" ] || missing+=("$d")
  done
  if [ ${#missing[@]} -ne 0 ]; then
    aoh_err "missing repo directories:"
    for m in "${missing[@]}"; do
      aoh_err "  - $m"
    done
    aoh_err ""
    aoh_err "Set AOH_WORKSPACE_ROOT to the parent containing pi / pi-owui-bridge / hub / open-webui-custom,"
    aoh_err "or set AOH_<REPO>_DIR individually."
    exit 1
  fi
}

aoh_dump_paths() {
  aoh_dim "AOH_WORKSPACE_ROOT = $AOH_WORKSPACE_ROOT"
  aoh_dim "AOH_PI_DIR         = $AOH_PI_DIR"
  aoh_dim "AOH_BRIDGE_DIR     = $AOH_BRIDGE_DIR"
  aoh_dim "AOH_HUB_DIR        = $AOH_HUB_DIR"
  aoh_dim "AOH_OWUI_DIR       = $AOH_OWUI_DIR"
  aoh_dim "AOH_VENDOR_DIR     = $AOH_VENDOR_DIR"
}
