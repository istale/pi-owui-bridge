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
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  /**
   * Update the trace id the OWUI tools extension should stamp on
   * outgoing HTTP calls for the *next* prompt. Bridge calls this right
   * before ``send({type:"prompt"})`` for each new turn, otherwise the
   * extension would keep using whatever trace id was pinned at spawn
   * and cross-service correlation breaks on the second turn.
   */
  setActiveTraceId: (traceId: string) => void;
  /**
   * Make sure the chat-keyed overlay snapshot the hub writes is reachable
   * at the session-keyed path Pi's overlay reader expects. Must be called
   * before each prompt — the user may have marked / unmarked turns *after*
   * the Pi process was spawned, in which case the spawn-time symlink is
   * stale (or missing).
   */
  refreshOverlay: () => void;
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
   *
   * Per-turn refresh: the caller is expected to invoke
   * ``setActiveTraceId(currentTurnTraceId)`` and ``refreshOverlay()``
   * before sending the next prompt so the sidecar files and overlay
   * symlinks reflect the *current* turn rather than whatever was true
   * at spawn time.
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

    // Stage 12.5: align Pi's overlay reader (which keys by Pi session
    // id) with the hub's chat-keyed snapshot via a deterministic id +
    // symlink. The actual symlink work happens in refreshOverlay()
    // below, called from spawn AND from each prompt — users may mark
    // turns AFTER the Pi process is up.
    const sessionId = deterministicSessionId(opts.userId, opts.chatId);

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

    // Tool selection: ``--exclude-tools bash,edit,write`` (denylist)
    // rather than ``--tools read`` (allowlist, which would also hide
    // every extension tool we register). Pi's read tool stays active so
    // the ``<available_skills>`` system-prompt block surfaces; bash /
    // edit / write are removed because chat users must not touch the
    // host filesystem. Extension tools (list_datasets etc.) keep their
    // default-on status.
    const args = [
      this.cfg.piCliPath,
      "--mode",
      "rpc",
      "--exclude-tools",
      "bash,edit,write",
      "--session-id",
      sessionId,
      "--extension",
      this.cfg.extensionPath,
      "--provider",
      this.cfg.modelProvider,
      "--model",
      this.cfg.modelId,
    ];
    // Pi's ResourceLoader only scans default skill dirs when
    // includeDefaults is set, which createAgentSession does not enable.
    // Pass the user's skills dir explicitly via ``--skill`` so the
    // loader picks it up. Skip if the user has no skills dir at all.
    if (this.cfg.skillsDir) {
      const userSkillsDir = join(this.cfg.skillsDir, opts.userId);
      if (existsSync(userSkillsDir)) {
        args.push("--skill", userSkillsDir);
      }
    }
    const proc = spawn("node", args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;

    const listeners = new Set<(e: Record<string, unknown>) => void>();

    // Pi RPC docs warn against using a generic line reader: Node's
    // ``readline`` splits on Unicode line separators (U+2028, U+2029,
    // etc.) which can appear inside legitimate string values in a JSON
    // chunk and would corrupt JSONL framing. Pi guarantees `\n`-delimited
    // JSON, so we split strictly on LF byte 0x0A.
    let buffer = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line);
        } catch {
          // not JSON or partial — drop and continue, framing is restored
          // by the next newline.
          continue;
        }
        for (const l of listeners) {
          try {
            l(event);
          } catch (err) {
            console.error("listener threw:", err);
          }
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

    // Sidecar file the extension reads per-tool-call so the *current*
    // turn's trace id stamps OWUI HTTP headers, not the trace id from
    // process spawn.
    const traceIdPath = join(cwd, ".aoh-current-trace-id");
    writeFileSync(traceIdPath, opts.aohTraceId, "utf8");
    const setActiveTraceId = (traceId: string): void => {
      try {
        writeFileSync(traceIdPath, traceId, "utf8");
      } catch {
        /* ignore — extension falls back to env */
      }
    };

    // Overlay symlink refresher. The chat snapshot lifecycle is
    // independent of the Pi process: a user may mark turns AFTER Pi
    // spawned (need to make the link), or clear all marks (need to
    // remove a stale link). Calling this is idempotent.
    const observationDir = this.cfg.observationDir;
    const refreshOverlay = (): void => {
      if (!observationDir) return;
      const overlayDir = join(observationDir, "overlays");
      const chatSnap = join(overlayDir, "chats", opts.userId, `${opts.chatId}.json`);
      const piSnap = join(overlayDir, `${sessionId}.json`);
      try {
        mkdirSync(overlayDir, { recursive: true });
        const linkPresent = (() => {
          try {
            return lstatSync(piSnap).isSymbolicLink();
          } catch {
            return false;
          }
        })();
        if (existsSync(chatSnap)) {
          if (!linkPresent) symlinkSync(chatSnap, piSnap);
        } else if (linkPresent) {
          unlinkSync(piSnap);
        }
      } catch {
        /* observability never breaks the agent */
      }
    };
    // First call at spawn so the freshly-built Pi sees the right overlay.
    refreshOverlay();

    return {
      key,
      proc,
      cwd,
      lastActivityAt: Date.now(),
      onEvent,
      send,
      setActiveTraceId,
      refreshOverlay,
      kill,
    };
  }
}

export function makeTraceId(): string {
  return `pi-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/**
 * Stable Pi session id per (user, chat). Same input → same id, so the
 * hub's overlay snapshot path (keyed by chat) can be symlinked to where
 * Pi's overlay reader looks (keyed by session id). The id format matches
 * what Pi accepts on ``--session-id``: a hex string we derive
 * deterministically.
 */
export function deterministicSessionId(userId: string, chatId: string): string {
  const h = createHash("sha1").update(`${userId} ${chatId}`).digest("hex");
  // Pi accepts UUID v4-ish 32-hex strings; we synthesise one that's clearly
  // ours by prefixing the hash's first 32 chars with a fixed tag suffix.
  return `aoh${h.slice(0, 29)}`;
}
