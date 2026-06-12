/**
 * Pi extension: register Open WebUI's 5 data-analysis tools.
 *
 * Loaded into a Pi RPC subprocess by ``pi --extension`` at spawn time.
 * On session start we discover the OWUI tool specs (one HTTP GET) and
 * call ``pi.registerTool`` for each so the model sees them at LLM-call
 * time. Per-tool ``execute`` callbacks shell out to OWUI over HTTP with
 * the headers our service-to-service contract requires.
 *
 * Every per-(user, chat) Pi process gets its own instance of this
 * extension, so the per-request identity (X-User-Id, X-Chat-Id,
 * X-Aoh-Trace-Id) is fixed at spawn time via env vars set by the
 * bridge. We do NOT re-read env per request — a Pi RPC process is
 * single-tenant for its whole lifetime.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type Json = unknown;

const env = (name: string, fallback = ""): string => (process.env[name] ?? fallback).trim();

const OWUI_BASE = env("AOH_OWUI_BASE_URL");
const SHARED_SECRET = env("AOH_PI_SHARED_SECRET");
const PINNED_USER_ID = env("AOH_USER_ID", "anonymous");
const PINNED_CHAT_ID = env("AOH_CHAT_ID");
const PINNED_TRACE_ID = env("AOH_TRACE_ID");

interface ToolSpec {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

async function discoverToolSpecs(): Promise<ToolSpec[]> {
  if (!OWUI_BASE) return [];
  const resp = await fetch(`${OWUI_BASE.replace(/\/$/, "")}/api/v1/data-analysis/tool-specs`, {
    headers: { "X-Pi-Service-Token": SHARED_SECRET, "X-User-Id": "discovery" },
  });
  if (!resp.ok) return [];
  const body = (await resp.json()) as { tools?: ToolSpec[] };
  return Array.isArray(body.tools) ? body.tools : [];
}

async function callOwuiTool(name: string, args: Record<string, unknown>): Promise<Json> {
  const headers: Record<string, string> = {
    "X-Pi-Service-Token": SHARED_SECRET,
    "X-User-Id": PINNED_USER_ID,
    "Content-Type": "application/json",
  };
  if (PINNED_CHAT_ID) headers["X-Chat-Id"] = PINNED_CHAT_ID;
  if (PINNED_TRACE_ID) headers["X-Aoh-Trace-Id"] = PINNED_TRACE_ID;
  try {
    const resp = await fetch(
      `${OWUI_BASE.replace(/\/$/, "")}/api/v1/data-analysis/tools/${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ args }),
      },
    );
    const text = await resp.text();
    if (resp.status >= 400) {
      let detail = text;
      try {
        detail = (JSON.parse(text) as { detail?: unknown }).detail as string ?? text;
      } catch {
        /* keep raw */
      }
      return { ok: false, error_code: `HTTP${resp.status}`, error_message: String(detail).slice(0, 800) };
    }
    try {
      return JSON.parse(text);
    } catch (err) {
      return { ok: false, error_code: "ToolResponseParseError", error_message: String(err) };
    }
  } catch (err) {
    return { ok: false, error_code: "ToolTransportError", error_message: err instanceof Error ? err.message : String(err) };
  }
}

function stringifyToolResult(result: Json): string {
  const r = result as { ok?: boolean; result?: unknown; error_code?: string; error_message?: string };
  if (r?.ok === true) return JSON.stringify(r.result ?? {});
  return JSON.stringify({ error: r?.error_code ?? "ToolError", message: r?.error_message ?? "" });
}

export default function owuiToolsExtension(pi: ExtensionAPI): void {
  // Pi extensions can't do async work in their factory function. The
  // ``session_start`` hook lets us await tool discovery, then register
  // each tool definition with whatever JSON schema OWUI advertised.
  pi.on("session_start", async () => {
    const specs = await discoverToolSpecs();
    for (const spec of specs) {
      pi.registerTool({
        name: spec.name,
        label: spec.name,
        description: spec.description ?? `Open WebUI tool: ${spec.name}`,
        // OWUI advertises plain JSON Schema; TypeBox's Type.Any is a no-op
        // schema we use to satisfy the static type while keeping runtime
        // validation deferred to OWUI itself.
        parameters: Type.Any(),
        async execute(_toolCallId, params) {
          const result = await callOwuiTool(spec.name, (params as Record<string, unknown>) ?? {});
          return {
            content: [{ type: "text", text: stringifyToolResult(result) }],
            details: result as Record<string, unknown>,
          };
        },
      });
    }
  });
}
