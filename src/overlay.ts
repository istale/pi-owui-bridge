/**
 * Read overlay snapshots written by the hub and translate them into the
 * mixed-mode prompt mutation: an Anthropic-style annotation prepended
 * to the system prompt, and tombstones replacing hidden content while
 * keeping tool_call_id intact.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const HIDDEN_TOMBSTONE =
  "[content elided by user; see annotation in system prompt for context]";

export interface OverlayRecord {
  index: number;
  mark: string;
  note?: string | null;
}

export interface Message {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  [k: string]: unknown;
}

export function overlayPath(observationDir: string, userId: string, chatId: string): string {
  return join(observationDir, "overlays", "chats", userId, `${chatId}.json`);
}

export function loadOverlays(
  observationDir: string | null,
  userId: string,
  chatId: string,
): OverlayRecord[] {
  if (!observationDir) return [];
  if (process.env.AOH_OVERLAY_DISABLE === "1") return [];
  let raw: string;
  try {
    raw = readFileSync(overlayPath(observationDir, userId, chatId), "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const overlays = (parsed as { overlays?: unknown[] }).overlays;
  if (!Array.isArray(overlays)) return [];
  return overlays.flatMap((ov) => {
    if (!ov || typeof ov !== "object") return [];
    const o = ov as { index?: unknown; mark?: unknown; note?: unknown };
    if (typeof o.index !== "number" || typeof o.mark !== "string") return [];
    return [{ index: o.index, mark: o.mark, note: typeof o.note === "string" ? o.note : null }];
  });
}

export function buildAnnotation(overlays: OverlayRecord[]): string {
  if (overlays.length === 0) return "";
  const byMark = new Map<string, OverlayRecord[]>();
  for (const ov of overlays) {
    const list = byMark.get(ov.mark) ?? [];
    list.push(ov);
    byMark.set(ov.mark, list);
  }
  const lines: string[] = ["The user has annotated this conversation."];
  const headings: Record<string, string> = {
    stale: "STALE — overruled:",
    background: "BACKGROUND — keep but deprioritise:",
    hidden: "HIDDEN — content elided, retain only the gist:",
  };
  for (const mark of ["stale", "background", "hidden"]) {
    const items = byMark.get(mark);
    if (!items) continue;
    lines.push(headings[mark]);
    for (const ov of items) {
      const note = ov.note ? `: ${ov.note}` : "";
      lines.push(`  - turn ${ov.index}${note}`);
    }
  }
  return lines.join("\n");
}

export function applyToMessages(messages: Message[], overlays: OverlayRecord[]): Message[] {
  if (overlays.length === 0) return messages;
  const hidden = new Set(overlays.filter((o) => o.mark === "hidden").map((o) => o.index));
  if (hidden.size === 0) return messages;
  return messages.map((m, i) => {
    if (!hidden.has(i) || m.role === "system") return m;
    return { ...m, content: HIDDEN_TOMBSTONE };
  });
}
