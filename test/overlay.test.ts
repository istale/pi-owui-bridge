import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  applyToMessages,
  buildAnnotation,
  HIDDEN_TOMBSTONE,
  loadOverlays,
  overlayPath,
} from "../src/overlay.js";

function makeTmp(): string {
  const dir = join(tmpdir(), `bridge-overlay-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeSnap(dir: string, user: string, chat: string, overlays: unknown[]): void {
  const p = overlayPath(dir, user, chat);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify({ user_id: user, chat_id: chat, schema_version: 1, overlays }));
}

describe("overlay loader", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) {
      const d = dirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  it("returns empty when no file exists", () => {
    const d = makeTmp();
    dirs.push(d);
    expect(loadOverlays(d, "alice", "c")).toEqual([]);
  });

  it("returns records on valid file", () => {
    const d = makeTmp();
    dirs.push(d);
    writeSnap(d, "alice", "c", [{ index: 0, mark: "stale", note: null }]);
    expect(loadOverlays(d, "alice", "c")).toEqual([{ index: 0, mark: "stale", note: null }]);
  });

  it("ignores garbage entries", () => {
    const d = makeTmp();
    dirs.push(d);
    writeSnap(d, "alice", "c", [
      { index: 0, mark: "stale" },
      "not-a-dict",
      { index: 1 },
      { mark: "x" },
    ]);
    const out = loadOverlays(d, "alice", "c");
    expect(out).toHaveLength(1);
    expect(out[0].index).toBe(0);
  });

  it("honours kill switch", () => {
    const d = makeTmp();
    dirs.push(d);
    writeSnap(d, "alice", "c", [{ index: 0, mark: "stale" }]);
    process.env.AOH_OVERLAY_DISABLE = "1";
    try {
      expect(loadOverlays(d, "alice", "c")).toEqual([]);
    } finally {
      delete process.env.AOH_OVERLAY_DISABLE;
    }
  });
});

describe("buildAnnotation", () => {
  it("groups by mark and includes notes", () => {
    const ann = buildAnnotation([
      { index: 1, mark: "stale", note: "wrong filter" },
      { index: 3, mark: "hidden", note: null },
      { index: 7, mark: "background", note: "old fyi" },
    ]);
    expect(ann).toContain("user has annotated");
    expect(ann).toContain("STALE — overruled:");
    expect(ann).toContain("turn 1: wrong filter");
    expect(ann).toContain("BACKGROUND — keep but deprioritise:");
    expect(ann).toContain("HIDDEN — content elided");
  });

  it("returns empty for no overlays", () => {
    expect(buildAnnotation([])).toBe("");
  });
});

describe("applyToMessages", () => {
  it("replaces hidden non-system content with tombstone", () => {
    const out = applyToMessages(
      [
        { role: "user", content: "u0" },
        { role: "assistant", content: null, tool_calls: [] },
        { role: "tool", tool_call_id: "abc", content: "real result" },
      ],
      [{ index: 2, mark: "hidden", note: null }],
    );
    expect(out[2].content).toBe(HIDDEN_TOMBSTONE);
    expect(out[2].tool_call_id).toBe("abc");
  });

  it("leaves system messages alone even if hidden", () => {
    const out = applyToMessages(
      [{ role: "system", content: "sys" }],
      [{ index: 0, mark: "hidden", note: null }],
    );
    expect(out[0].content).toBe("sys");
  });

  it("only acts on hidden marks", () => {
    const out = applyToMessages(
      [{ role: "user", content: "u" }],
      [{ index: 0, mark: "stale", note: null }],
    );
    expect(out[0].content).toBe("u");
  });
});
