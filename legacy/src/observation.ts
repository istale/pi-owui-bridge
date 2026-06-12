/**
 * Append observation events as JSONL the hub tailer already ingests.
 * Single file per bridge process; appends are sequential per process
 * which is sufficient — the hub is the durable store.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

let seq = 0;

export interface AgentEvent {
  stage: string;
  trace_id: string;
  session_id: string;
  payload: Record<string, unknown>;
  source_module?: string;
}

export class ObservationEmitter {
  private path: string | null = null;
  constructor(observationDir: string | null, processId: string = `bridge-${randomUUID().slice(0, 8)}`) {
    if (!observationDir) return;
    const dir = join(observationDir, "pi-owui-bridge");
    try {
      mkdirSync(dir, { recursive: true });
      this.path = join(dir, `${processId}.jsonl`);
    } catch {
      this.path = null;
    }
  }

  get enabled(): boolean {
    return this.path !== null;
  }

  emit(event: AgentEvent): void {
    if (!this.path) return;
    seq += 1;
    const record = {
      kind: "agent_event",
      trace_id: event.trace_id,
      session_id: event.session_id,
      event_seq: seq,
      stage: event.stage,
      source_module: event.source_module ?? "pi-owui-bridge",
      ts: new Date().toISOString(),
      payload: event.payload,
    };
    try {
      appendFileSync(this.path, JSON.stringify(record) + "\n", "utf8");
    } catch {
      // observation must never break the agent
    }
  }
}
