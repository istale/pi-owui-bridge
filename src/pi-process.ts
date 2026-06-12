/**
 * Manage Pi RPC subprocesses on behalf of HTTP requests.
 *
 * One Pi process per (user_id, chat_id). The process owns the chat's
 * agent session — the bridge does not seed history, it just sends
 * ``{type:"prompt", ...}`` for each new user message. Idle processes
 * are evicted after ``AOH_PI_IDLE_EVICT_MS`` (default 5 min) so a
 * 10-20 user deployment never holds more than a handful at a time.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import readline from "node:readline";

import type { BridgeConfig } from "./config.js";

export interface PiProc {
  key: string;
  proc: ChildProcessWithoutNullStreams;
  cwd: string;
  /** Last activity timestamp — used by the idle reaper. */
  lastActivityAt: number;
  /** Forward each line of JSON Pi writes on stdout. */
  onEvent: (handler: (event: Record<string, unknown>) => void) => () => void;
  send: (command: Record<string, unknown>) => void;
  kill: () => void;
}

interface SpawnOptions {
  userId: string;
  chatId: string;
  aohTraceId: string;
}

export class PiPool {
  private map = new Map<string, PiProc>();
  private reaper: NodeJS.Timeout | null = null;

  constructor(private readonly cfg: BridgeConfig) {}

  start(): void {
    if (this.reaper) return;
    // The reaper period is intentionally one third of idle — gives at
    // worst a 4/3 multiplier on idle eviction with a single timer.
    const period = Math.max(30_000, Math.floor(this.cfg.idleEvictMs / 3));
    this.reaper = setInterval(() => this.evictIdle(), period).unref();
  }

  stop(): void {
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = null;
    for (const pi of this.map.values()) pi.kill();
    this.map.clear();
  }

  size(): number {
    return this.map.size;
  }

  /**
   * Get the Pi for this (user, chat), spawning one if absent.
   * ``aohTraceId`` is pinned only on first spawn — subsequent prompts in
   * the same chat thread reuse the process and that original trace id.
   */
  acquire(opts: SpawnOptions): PiProc {
    const key = `${opts.userId}${opts.chatId}`;
    const existing = this.map.get(key);
    if (existing) {
      existing.lastActivityAt = Date.now();
      return existing;
    }
    const pi = this.spawnPi(key, opts);
    this.map.set(key, pi);
    return pi;
  }

  private evictIdle(): void {
    const cutoff = Date.now() - this.cfg.idleEvictMs;
    for (const [key, pi] of this.map.entries()) {
      if (pi.lastActivityAt < cutoff) {
        pi.kill();
        this.map.delete(key);
      }
    }
  }

  private spawnPi(key: string, opts: SpawnOptions): PiProc {
    const baseTmp = mkdtempSync(join(tmpdir(), "aoh-pi-"));
    const cwd = join(baseTmp, "cwd");
    const piAgentDir = join(baseTmp, "pi-agent");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(piAgentDir, { recursive: true });

    // Pre-seed models.json so the synthetic ``aoh-hub`` provider resolves
    // to our Hub URL. Pi reads this on startup; no /login flow needed.
    const modelsJson = {
      providers: {
        [this.cfg.modelProvider]: {
          baseUrl: this.cfg.hubBaseUrl,
          api: "openai-completions",
          apiKey: this.cfg.hubApiKey,
          compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
          },
          models: [{ id: this.cfg.modelId }],
        },
      },
    };
    writeFileSync(join(piAgentDir, "models.json"), JSON.stringify(modelsJson, null, 2), "utf8");

    // Symlink the user's skill directory into where pi's resource loader
    // looks; pi's DefaultResourceLoader picks up <cwd>/.pi/skills/.
    if (this.cfg.skillsDir) {
      const userSkills = join(this.cfg.skillsDir, opts.userId);
      if (existsSync(userSkills)) {
        const target = join(cwd, ".pi", "skills");
        mkdirSync(join(cwd, ".pi"), { recursive: true });
        try {
          symlinkSync(userSkills, target, "dir");
        } catch {
          /* ignore — race or perm; the agent still runs without skills */
        }
      }
    }

    // Same for the observation directory — pi's overlay reader looks
    // for ~/.pi/observation by default; we redirect via env (set below).
    // For per-process safety we also symlink into <cwd>/.pi/observation
    // so any code path that probes locally still finds the snapshot.
    if (this.cfg.observationDir) {
      try {
        const target = join(cwd, ".pi", "observation");
        mkdirSync(join(cwd, ".pi"), { recursive: true });
        symlinkSync(this.cfg.observationDir, target, "dir");
      } catch {
        /* ignore */
      }
    }

    const env = {
      ...process.env,
      // Pinned identity the extension's per-request callbacks need.
      AOH_USER_ID: opts.userId,
      AOH_CHAT_ID: opts.chatId,
      AOH_TRACE_ID: opts.aohTraceId,
      AOH_OWUI_BASE_URL: this.cfg.owuiBaseUrl,
      AOH_PI_SHARED_SECRET: this.cfg.piSharedSecret,
      AOH_OBSERVATION_DIR: this.cfg.observationDir ?? "",
      // Pi reads PI_CODING_AGENT_DIR for its config dir; pointing at our
      // tmp keeps anything Pi writes (sessions, models.json we pre-seed,
      // any tool downloads) inside the per-process sandbox.
      PI_CODING_AGENT_DIR: piAgentDir,
    };

    const args = [
      this.cfg.piCliPath,
      "--mode",
      "rpc",
      "--no-builtin-tools",
      "--no-session",
      "--extension",
      this.cfg.extensionPath,
      "--provider",
      this.cfg.modelProvider,
      "--model",
      this.cfg.modelId,
    ];
    const proc = spawn("node", args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;

    const listeners = new Set<(e: Record<string, unknown>) => void>();
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      for (const l of listeners) {
        try {
          l(event);
        } catch (err) {
          console.error("listener threw:", err);
        }
      }
    });

    const stderrLines: string[] = [];
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrLines.push(chunk.toString("utf8"));
      // keep last 200 lines for crash dumps
      if (stderrLines.length > 200) stderrLines.shift();
    });

    proc.on("exit", (code, signal) => {
      this.map.delete(key);
      if (code !== 0 && code !== null) {
        console.warn(`pi(${key}) exited code=${code} signal=${signal} stderr=\n${stderrLines.join("")}`);
      }
      rmSync(baseTmp, { recursive: true, force: true });
    });

    const onEvent = (handler: (event: Record<string, unknown>) => void) => {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    };

    const send = (command: Record<string, unknown>): void => {
      proc.stdin.write(JSON.stringify(command) + "\n");
    };

    const kill = (): void => {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    };

    return {
      key,
      proc,
      cwd,
      lastActivityAt: Date.now(),
      onEvent,
      send,
      kill,
    };
  }
}

export function makeTraceId(): string {
  return `pi-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
