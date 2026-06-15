#!/usr/bin/env bash
# Validate the host has the right runtime versions for all four AOH repos.
#
# Why bother: pi requires node>=22.19.0, OWUI caps node<=22.x. Python: hub
# needs >=3.12, OWUI needs <3.13. Hitting any of these mid-install costs an
# hour to back out. Run this BEFORE install-all.sh.
#
# Exits non-zero on any unmet requirement, with a single line each
# explaining what's wrong and how to fix.

. "$(dirname "$0")/lib/paths.sh"

aoh_info "Checking environment for AOH stack"
aoh_dump_paths
echo

REQ_NODE_MAJOR=22         # pi: >=22.19.0, OWUI: <=22.x  -> intersection is 22.x
REQ_NODE_MIN_MINOR=19     # pi pin: >=22.19
REQ_PY_MAJOR=3
REQ_PY_MINOR=12           # hub: >=3.12, OWUI: <3.13  -> 3.12.x

fail=0

# ---------- node ----------
if command -v node >/dev/null 2>&1; then
  node_v="$(node -v | sed 's/^v//')"
  node_major="${node_v%%.*}"
  node_rest="${node_v#*.}"
  node_minor="${node_rest%%.*}"
  if [ "$node_major" != "$REQ_NODE_MAJOR" ]; then
    aoh_err "node $node_v: AOH requires node v${REQ_NODE_MAJOR}.x"
    aoh_err "  pi/package.json pins >=22.19.0; open-webui-custom pins <=22.x.x"
    aoh_err "  Install Node v22 LTS (22.22.3 or later) and rerun."
    fail=1
  elif [ "$node_minor" -lt "$REQ_NODE_MIN_MINOR" ]; then
    aoh_err "node $node_v: too old; pi pins >=22.${REQ_NODE_MIN_MINOR}.0"
    aoh_err "  Install Node v22 LTS (22.22.3 or later) and rerun."
    fail=1
  else
    aoh_ok "node $node_v"
  fi
else
  aoh_err "node not found in PATH"
  fail=1
fi

# ---------- npm ----------
if command -v npm >/dev/null 2>&1; then
  aoh_ok "npm $(npm -v)"
else
  aoh_err "npm not found (ships with Node, did your installer skip it?)"
  fail=1
fi

# ---------- pnpm (required by pi) ----------
if command -v pnpm >/dev/null 2>&1; then
  aoh_ok "pnpm $(pnpm -v)"
else
  aoh_err "pnpm not found"
  aoh_err "  pi/ is a pnpm workspace. Enable it with: corepack enable pnpm"
  aoh_err "  (or install with: npm i -g pnpm)"
  fail=1
fi

# ---------- python ----------
py=""
for cand in python3.12 python3 python; do
  if command -v "$cand" >/dev/null 2>&1; then
    py_v="$("$cand" -c 'import sys; print(".".join(map(str, sys.version_info[:3])))' 2>/dev/null || true)"
    py_major="${py_v%%.*}"
    py_rest="${py_v#*.}"
    py_minor="${py_rest%%.*}"
    if [ "$py_major" = "$REQ_PY_MAJOR" ] && [ "$py_minor" = "$REQ_PY_MINOR" ]; then
      py="$cand"
      aoh_ok "$cand $py_v"
      break
    fi
  fi
done
if [ -z "$py" ]; then
  aoh_err "no Python ${REQ_PY_MAJOR}.${REQ_PY_MINOR}.x found in PATH"
  aoh_err "  hub/pyproject.toml requires >=3.12; open-webui-custom requires <3.13"
  aoh_err "  Install Python 3.12 and rerun (try: python3.12)"
  fail=1
fi

# ---------- pip ----------
if [ -n "$py" ]; then
  if "$py" -m pip --version >/dev/null 2>&1; then
    aoh_ok "pip ($("$py" -m pip --version | awk '{print $2}'))"
  else
    aoh_err "pip module missing for $py"
    aoh_err "  install with your distro's package manager (e.g. apt install python3.12-venv)"
    fail=1
  fi
fi

# ---------- git ----------
if command -v git >/dev/null 2>&1; then
  aoh_ok "git $(git --version | awk '{print $3}')"
else
  aoh_err "git not found"
  fail=1
fi

# ---------- tar (offline bundle prep/unpack uses it) ----------
if command -v tar >/dev/null 2>&1; then
  aoh_ok "tar"
else
  aoh_err "tar not found"
  fail=1
fi

# ---------- corepack (controls pnpm version) ----------
if command -v corepack >/dev/null 2>&1; then
  aoh_dim "corepack $(corepack --version) (ok; used for pnpm activation)"
fi

echo
if [ "$fail" -ne 0 ]; then
  aoh_err "Environment check FAILED. Fix the items above and rerun."
  exit 1
fi
aoh_ok "Environment check passed."
