#!/usr/bin/env node
/**
 * AOH e2e runner.
 *
 * Spawns one bridge process per run (in --mode=fake, with a fake upstream
 * baked in) so scenarios are isolated from any developer-facing bridge
 * already on :19000. The OWUI backend and the Hub must already be up;
 * the runner refuses to proceed if they aren't reachable.
 *
 * Outputs a single JSON report to stdout (plus optional --report-file).
 * Exit code is non-zero on any scenario failure.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { BridgeClient, HubClient, OwuiClient } from "./lib/clients.mjs";
import { startFakeUpstream } from "./lib/fake-upstream.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const ALL_SCENARIOS = [
  "stack-up",
  "tool-dispatch",
  "overlay-stale",
  "overlay-stale-late",
  "skill-inject",
  "concurrent-turns",
  "overlay-baseline",
  "overlay-revert",
  "overlay-multi-mark",
  "overlay-note",
  "overlay-killswitch",
];

function parseArgs(argv) {
  const out = { mode: "fake", scenario: "all", reportFile: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--mode=")) out.mode = a.slice("--mode=".length);
    else if (a.startsWith("--scenario=")) out.scenario = a.slice("--scenario=".length);
    else if (a.startsWith("--report-file=")) out.reportFile = a.slice("--report-file=".length);
  }
  return out;
}

function env(name, def) {
  const v = (process.env[name] ?? "").trim();
  return v || def;
}

async function waitFor(predicate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function startEphemeralBridge({ owuiUrl, sharedSecret, upstreamUrl, upstreamKey, observationDir, skillsDir }) {
  const port = 19500 + Math.floor(Math.random() * 100);
  const env = {
    ...process.env,
    AOH_BRIDGE_PORT: String(port),
    AOH_OWUI_BASE_URL: owuiUrl,
    AOH_PI_SHARED_SECRET: sharedSecret,
    AOH_UPSTREAM_BASE_URL: upstreamUrl,
    AOH_UPSTREAM_API_KEY: upstreamKey,
    AOH_OBSERVATION_DIR: observationDir,
    AOH_SKILLS_DIR: skillsDir,
    // Stage 12 — point at Pi CLI + the OWUI tools extension.
    AOH_PI_CLI_PATH:
      process.env.AOH_PI_CLI_PATH
      ?? "/Users/istale/Documents/pi-agent-obervation/repos/pi/packages/coding-agent/dist/cli.js",
    AOH_PI_EXTENSION_PATH:
      process.env.AOH_PI_EXTENSION_PATH
      ?? "/Users/istale/Documents/pi-agent-obervation/repos/pi-owui-bridge/extension/dist/owui-tools.js",
  };
  const repoRoot = join(__dirname, "..");
  const proc = spawn("node", ["dist/server.js"], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  const url = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    try {
      const r = await fetch(`${url}/healthz`);
      return r.status === 200;
    } catch {
      return false;
    }
  }, `bridge :${port}`);
  return { url, port, kill: () => proc.kill("SIGTERM") };
}

async function loadScenario(name) {
  const mod = await import(`./scenarios/${name}.mjs`);
  return mod.run;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scenarios = args.scenario === "all" ? ALL_SCENARIOS : args.scenario.split(",").map((s) => s.trim());

  const owuiUrl = env("AOH_OWUI_BASE_URL", "http://127.0.0.1:8080");
  const hubUrl = env("AOH_HUB_BASE_URL", "http://127.0.0.1:43180");
  const sharedSecret = env("AOH_PI_SHARED_SECRET");
  if (!sharedSecret) throw new Error("AOH_PI_SHARED_SECRET must be set");

  // Hub writes overlay snapshots into its own AOH_OBSERVATION_DIR; the bridge
  // reads them. For overlay-stale to pass, both processes must point at the
  // same directory. If AOH_OBSERVATION_DIR is set, we reuse it (the assumption
  // is that the hub is already pointed there); otherwise we fall back to a
  // tmp dir and overlay-stale will fail with a clear evidence message.
  const obsDir = env("AOH_OBSERVATION_DIR", mkdtempSync(join(tmpdir(), "aoh-e2e-obs-")));
  const skillsDir = env("AOH_SKILLS_DIR", mkdtempSync(join(tmpdir(), "aoh-e2e-skills-")));

  let upstreamUrl;
  let upstreamKey = env("AOH_UPSTREAM_API_KEY", "fake-key");
  let fakeUpstream = null;
  if (args.mode === "fake") {
    fakeUpstream = await startFakeUpstream();
    upstreamUrl = fakeUpstream.baseUrl;
  } else {
    upstreamUrl = env("AOH_UPSTREAM_BASE_URL", "https://api.minimax.io/v1");
    if (!process.env.AOH_UPSTREAM_API_KEY) {
      throw new Error("AOH_UPSTREAM_API_KEY must be set in --mode=real");
    }
  }

  const bridge = await startEphemeralBridge({
    owuiUrl,
    sharedSecret,
    upstreamUrl,
    upstreamKey,
    observationDir: obsDir,
    skillsDir,
  });

  const ctx = {
    owui: new OwuiClient(owuiUrl, sharedSecret),
    hub: new HubClient(hubUrl),
    bridge: new BridgeClient(bridge.url),
    mode: args.mode,
    skillsDir,
    randomUserId: () => `e2e_user_${Math.random().toString(36).slice(2, 8)}`,
    randomChatId: () => `e2e_chat_${Math.random().toString(36).slice(2, 8)}`,
    scriptFake: async (script) => {
      if (!fakeUpstream) return;
      const r = await fetch(`${fakeUpstream.baseUrl}/_script`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(script),
      });
      if (r.status !== 200) throw new Error(`failed to load fake script: ${r.status}`);
    },
  };

  const report = {
    started_at: new Date().toISOString(),
    mode: args.mode,
    scenarios: [],
  };

  let failed = 0;
  for (const name of scenarios) {
    const run = await loadScenario(name);
    const t0 = Date.now();
    try {
      const out = await run(ctx);
      const entry = { name, passed: out.passed, duration_ms: Date.now() - t0, evidence: out.evidence };
      if (!out.passed) failed += 1;
      report.scenarios.push(entry);
    } catch (err) {
      failed += 1;
      report.scenarios.push({
        name,
        passed: false,
        duration_ms: Date.now() - t0,
        evidence: { error: err instanceof Error ? err.message : String(err), stack: err?.stack },
      });
    }
  }

  report.summary = {
    total: report.scenarios.length,
    passed: report.scenarios.length - failed,
    failed,
  };

  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  if (args.reportFile) writeFileSync(args.reportFile, JSON.stringify(report, null, 2));

  bridge.kill();
  if (fakeUpstream) await fakeUpstream.close();

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(JSON.stringify({ runner_error: err instanceof Error ? err.message : String(err) }));
  process.exit(2);
});
