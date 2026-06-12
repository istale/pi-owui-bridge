import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BridgeObservationEmitter } from "../src/observation-emit.js";

describe("BridgeObservationEmitter", () => {
  it("is disabled when observationDir is null", () => {
    const em = new BridgeObservationEmitter(null);
    expect(em.enabled).toBe(false);
    em.emit({ stage: "x", traceId: "t", sessionId: "s", payload: {} }); // no-op, no throw
  });

  it("appends one JSONL line per emit", () => {
    const dir = mkdtempSync(join(tmpdir(), "aoh-obs-"));
    try {
      const em = new BridgeObservationEmitter(dir);
      expect(em.enabled).toBe(true);
      em.emit({ stage: "a", traceId: "trace-1", sessionId: "sess-1", payload: { hi: 1 } });
      em.emit({ stage: "b", traceId: "trace-1", sessionId: "sess-1", payload: { hi: 2 } });
      const files = readdirSync(join(dir, "pi-owui-bridge"));
      expect(files.length).toBe(1);
      const lines = readFileSync(join(dir, "pi-owui-bridge", files[0]!), "utf8").trim().split("\n");
      expect(lines.length).toBe(2);
      const first = JSON.parse(lines[0]!);
      expect(first.stage).toBe("a");
      expect(first.trace_id).toBe("trace-1");
      expect(first.session_id).toBe("sess-1");
      expect(first.payload).toEqual({ hi: 1 });
      expect(first.kind).toBe("agent_event");
      expect(first.source_module).toContain("pi-owui-bridge");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
