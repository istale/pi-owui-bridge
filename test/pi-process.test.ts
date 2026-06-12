/**
 * Unit tests for ``PiPool``'s spawn / symlink / sidecar logic, exercised
 * against a tiny shell script that pretends to be Pi: it just acks every
 * stdin line as JSON on stdout. We're verifying the bridge-side plumbing,
 * not Pi's actual behaviour.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PiPool, makeTraceId } from "../src/pi-process.js";
import type { BridgeConfig } from "../src/config.js";

function makeFakePi(tmpRoot: string): string {
  // A Node script that mirrors stdin lines as JSON events on stdout.
  // Plays the role of pi --mode rpc for spawn/IO tests.
  const script = `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      const cmd = JSON.parse(line);
      // Echo back as an event.
      process.stdout.write(JSON.stringify({ type: 'echoed', input: cmd }) + '\\n');
      if (cmd.type === 'prompt') {
        process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }) + '\\n');
        process.stdout.write(JSON.stringify({ type: 'agent_end' }) + '\\n');
      }
    } catch (e) {
      process.stderr.write('parse_error: ' + e.message + '\\n');
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`;
  const path = join(tmpRoot, "fake-pi.mjs");
  writeFileSync(path, script);
  return path;
}

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  const tmpRoot = mkdtempSync(join(tmpdir(), "aoh-test-"));
  const fakeCli = makeFakePi(tmpRoot);
  const fakeExt = join(tmpRoot, "fake-ext.mjs");
  writeFileSync(fakeExt, "export default function (pi) {}");
  return {
    hubBaseUrl: "http://127.0.0.1:43180/v1",
    hubApiKey: "fake-key",
    modelProvider: "aoh-hub",
    modelId: "fake-model",
    owuiBaseUrl: "http://127.0.0.1:8080",
    piSharedSecret: "shh",
    observationDir: null,
    skillsDir: null,
    piCliPath: fakeCli,
    extensionPath: fakeExt,
    port: 0,
    idleEvictMs: 60_000,
    ...overrides,
  };
}

describe("PiPool", () => {
  const pools: PiPool[] = [];
  afterEach(() => {
    while (pools.length) pools.pop()?.stop();
  });

  it("spawns a Pi process and routes stdout events to subscribers", async () => {
    const pool = new PiPool(makeConfig());
    pools.push(pool);
    const pi = pool.acquire({ userId: "alice", chatId: "c1", aohTraceId: "trace-1" });

    const received: Record<string, unknown>[] = [];
    pi.onEvent((e) => received.push(e));
    pi.send({ type: "prompt", message: "hello" });

    // Wait up to 2s for the fake-pi to ack.
    await new Promise<void>((resolve) => {
      const deadline = Date.now() + 2000;
      const check = () => {
        if (received.some((e) => e.type === "agent_end")) return resolve();
        if (Date.now() > deadline) return resolve();
        setTimeout(check, 50);
      };
      check();
    });

    const types = received.map((e) => e.type);
    expect(types).toContain("echoed");
    expect(types).toContain("message_end");
    expect(types).toContain("agent_end");
  });

  it("pre-seeds models.json with the hub URL under the synthetic provider", async () => {
    const cfg = makeConfig({
      hubBaseUrl: "http://test-hub:1234/v1",
      modelProvider: "test-hub",
      modelId: "test-model-id",
      hubApiKey: "test-key",
    });
    const pool = new PiPool(cfg);
    pools.push(pool);
    const pi = pool.acquire({ userId: "alice", chatId: "c1", aohTraceId: "trace-1" });
    // models.json sits next to cwd in pi-agent dir; the cwd is a sibling.
    // We assert via the file we KNOW exists: cwd/.aoh-current-trace-id.
    const sidecar = readFileSync(join(pi.cwd, ".aoh-current-trace-id"), "utf8");
    expect(sidecar).toBe("trace-1");
  });

  it("setActiveTraceId updates the sidecar file mid-process", async () => {
    const pool = new PiPool(makeConfig());
    pools.push(pool);
    const pi = pool.acquire({ userId: "alice", chatId: "c1", aohTraceId: "trace-A" });
    expect(readFileSync(join(pi.cwd, ".aoh-current-trace-id"), "utf8")).toBe("trace-A");

    pi.setActiveTraceId("trace-B");
    expect(readFileSync(join(pi.cwd, ".aoh-current-trace-id"), "utf8")).toBe("trace-B");
  });

  it("acquire returns the same Pi process for the same (user, chat) key", async () => {
    const pool = new PiPool(makeConfig());
    pools.push(pool);
    const first = pool.acquire({ userId: "alice", chatId: "c1", aohTraceId: "t1" });
    const second = pool.acquire({ userId: "alice", chatId: "c1", aohTraceId: "t2" });
    expect(second.proc.pid).toBe(first.proc.pid);
    expect(pool.size()).toBe(1);
  });

  it("acquire spawns a fresh Pi for a different (user, chat) key", async () => {
    const pool = new PiPool(makeConfig());
    pools.push(pool);
    const aliceA = pool.acquire({ userId: "alice", chatId: "cA", aohTraceId: "t1" });
    const bobA = pool.acquire({ userId: "bob", chatId: "cA", aohTraceId: "t2" });
    expect(bobA.proc.pid).not.toBe(aliceA.proc.pid);
    expect(pool.size()).toBe(2);
  });

  it("symlinks the user's skills dir into the spawned cwd's .pi/skills/", async () => {
    const skillsRoot = mkdtempSync(join(tmpdir(), "aoh-skills-"));
    mkdirSync(join(skillsRoot, "alice"), { recursive: true });
    writeFileSync(join(skillsRoot, "alice", "x.md"), "skill body");
    const pool = new PiPool(makeConfig({ skillsDir: skillsRoot }));
    pools.push(pool);
    const pi = pool.acquire({ userId: "alice", chatId: "c1", aohTraceId: "t1" });
    const skill = readFileSync(join(pi.cwd, ".pi", "skills", "x.md"), "utf8");
    expect(skill).toBe("skill body");
  });
});

describe("makeTraceId", () => {
  it("returns a pi-prefixed 16-hex id", () => {
    const id = makeTraceId();
    expect(id).toMatch(/^pi-[0-9a-f]{16}$/);
  });
});
