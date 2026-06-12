/**
 * Capture Pi RPC events into the hub-tailer-readable JSONL format so the
 * hub's existing ``/api/assertions/payload-inspect/<trace>`` endpoint can
 * answer "did the STALE annotation reach the wire?" against our
 * synthetic ``aoh_trace_id``. Without this, the bridge would emit no
 * agent_events of its own — Pi's stdout uses Pi's internal trace ids,
 * not ours — and the regression scenarios would be guessing.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const PROCESS_ID = `bridge-rpc-${randomUUID().slice(0, 8)}`;
let seq = 0;

export interface PiEventCapture {
  observationDir: string | null;
}

export class BridgeObservationEmitter {
  private readonly path: string | null;
  constructor(observationDir: string | null) {
    if (!observationDir) {
      this.path = null;
      return;
    }
    const dir = join(observationDir, "pi-owui-bridge");
    try {
      mkdirSync(dir, { recursive: true });
      this.path = join(dir, `${PROCESS_ID}.jsonl`);
    } catch {
      this.path = null;
    }
  }

  get enabled(): boolean {
    return this.path !== null;
  }

  emit(opts: {
    stage: string;
    traceId: string;
    sessionId: string;
    payload: unknown;
  }): void {
    if (!this.path) return;
    seq += 1;
    const record = {
      kind: "agent_event",
      trace_id: opts.traceId,
      session_id: opts.sessionId,
      event_seq: seq,
      stage: opts.stage,
      source_module: "pi-owui-bridge/rpc-subprocess",
      ts: new Date().toISOString(),
      payload: opts.payload,
    };
    try {
      appendFileSync(this.path, JSON.stringify(record) + "\n", "utf8");
    } catch {
      /* observation must never break the bridge */
    }
  }
}
