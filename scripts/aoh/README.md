# AOH bootstrap scripts

Bring the full AOH stack (pi + pi-owui-bridge + hub + open-webui-custom)
up on a fresh machine — online or air-gapped.

## Layout assumption

All four repos must be siblings under one directory. This is hard-coded
by `pi-owui-bridge/package.json` (`file:../pi/packages/agent`), not by
these scripts.

```
$AOH_WORKSPACE_ROOT/
├── pi/
├── pi-owui-bridge/
│   └── scripts/aoh/        ← you are here
├── hub/
├── open-webui-custom/
└── vendor/                 ← offline-prep produces this; install-all reads it
```

The default `$AOH_WORKSPACE_ROOT` is the grandparent of this directory.
Override with `AOH_WORKSPACE_ROOT=/path` if your layout differs.

## Required versions

- **Node 22.x** (specifically 22.22.3+ to satisfy pi's `>=22.19.0` and
  open-webui-custom's `<=22.x.x`)
- **Python 3.12.x** (hub requires `>=3.12`; owui requires `<3.13`)
- **pnpm** (for pi's pnpm workspace) — `corepack enable pnpm` works
- **npm** (ships with Node)
- **git**, **tar**, **openssl** (or python's `secrets`)

`check-environment.sh` validates all of this.

## Flow

### A. Online machine (the build box)

```sh
cd pi-owui-bridge/scripts/aoh
./check-environment.sh          # verify versions
./offline-prep-all.sh           # ~10–20 min, produces dist/aoh-offline-bundle-*.tar.gz
```

Transfer the tarball to the offline machine (scp / USB / whatever).

### B. Offline machine (team dev box)

```sh
mkdir ~/aoh
tar -C ~/aoh -xzf aoh-offline-bundle-*.tar.gz
cd ~/aoh

./scripts/aoh/check-environment.sh   # confirm runtime versions
./scripts/aoh/offline-unpack.sh      # materialise repos from git bundles
./scripts/aoh/install-all.sh         # AOH_OFFLINE=1 set automatically if vendor/ exists
./scripts/aoh/init-env.sh            # write .env files + generate shared secret
# Edit the .env files to fill UPSTREAM_OPENAI_API_KEY / MINIMAX_API_KEY
(cd ~/aoh/hub && scripts/init_db.sh) # init the hub sqlite DB
./scripts/aoh/smoke-test.sh          # start services + run all tests + e2e
```

For interactive dev sessions after smoke is green: `AOH_KEEP_RUNNING=1
./scripts/aoh/smoke-test.sh` leaves services up so you can hit them.

## Online dev box (skip the tarball)

If the box has internet (or an enterprise mirror configured in
`~/.npmrc` / `~/.pip/pip.conf`), skip the prep + unpack steps:

```sh
git clone https://github.com/istale/pi.git
git clone https://github.com/istale/pi-owui-bridge.git
git clone https://github.com/istale/agent-observation-hub.git hub
git clone https://github.com/istale/open-webui-custom.git
pi-owui-bridge/scripts/aoh/check-environment.sh
pi-owui-bridge/scripts/aoh/install-all.sh
pi-owui-bridge/scripts/aoh/init-env.sh
(cd hub && scripts/init_db.sh)
pi-owui-bridge/scripts/aoh/smoke-test.sh
```

## Script reference

| Script | Where it runs | What it does |
|---|---|---|
| `check-environment.sh` | both | verify node/python/pnpm/npm/git/tar versions |
| `offline-prep-all.sh` | online | bundle source + wheels + npm-cache + pnpm-store into a tarball |
| `offline-unpack.sh` | offline | unbundle git history into working trees, verify vendor/ |
| `install-all.sh` | both | run install in dependency order (pi → bridge → hub → owui) |
| `init-env.sh` | both | generate shared secret + write the three `.env` files |
| `smoke-test.sh` | both | start services, run unit tests + bridge e2e (no frontend) |

## Path overrides

If the standard layout doesn't fit:

```sh
export AOH_WORKSPACE_ROOT=/custom/path        # moves all four repos
export AOH_HUB_DIR=/somewhere/else/hub        # moves one repo specifically
export AOH_VENDOR_DIR=/path/to/vendor         # moves the offline cache
```

## Offline mode trigger

`install-all.sh` checks for `AOH_OFFLINE=1`. The offline-unpack script
prints a "set this" hint if vendor/ is present. Force it:

```sh
AOH_OFFLINE=1 ./install-all.sh
```

This refuses to fall back to network — better to fail loudly than to
silently quote from a mirror the team didn't realise they'd set up.

## Things this does NOT do

- Doesn't set up the OWUI frontend dev server (`npm run dev` on :5173).
  Smoke test verifies backend + bridge + hub; frontend is left for
  human verification once everything else is green.
- Doesn't run `--mode=real` e2e (would cost real LLM credits and
  requires `AOH_LLM_API_KEY`). See `e2e/canary.sh` for that.
- Doesn't validate enterprise pip/npm mirror coverage upfront. If the
  team's mirror is missing a package, install-all will fail at that
  point with the package name; install up to that point is preserved.
