/**
 * Pi extension: register Open WebUI's 5 data-analysis tools.
 *
 * Loaded into a Pi RPC subprocess by ``pi --extension`` at spawn time.
 * On session start we discover the OWUI tool specs (one HTTP GET) and
 * call ``pi.registerTool`` for each so the model sees them at LLM-call
 * time. Per-tool ``execute`` callbacks shell out to OWUI over HTTP with
 * the headers our service-to-service contract requires.
 *
 * Every per-(user, chat) Pi process is single-tenant: X-User-Id and
 * X-Chat-Id are pinned at spawn from env, but X-Aoh-Trace-Id is read
 * fresh from a sidecar file (<cwd>/.aoh-current-trace-id) on every
 * tool execute() so per-turn trace correlation works even when the
 * Pi process spans multiple OWUI chat completions.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type Json = unknown;

const env = (name: string, fallback = ""): string => (process.env[name] ?? fallback).trim();

const OWUI_BASE = env("AOH_OWUI_BASE_URL");
const SHARED_SECRET = env("AOH_PI_SHARED_SECRET");
const PINNED_USER_ID = env("AOH_USER_ID", "anonymous");
const PINNED_CHAT_ID = env("AOH_CHAT_ID");
const SPAWN_TRACE_ID = env("AOH_TRACE_ID");
const OBSERVATION_DIR = env("AOH_OBSERVATION_DIR");
const SESSION_ID = `owui-chat:${PINNED_USER_ID}:${PINNED_CHAT_ID || "no-chat"}`;

let observationPath: string | null = null;
if (OBSERVATION_DIR) {
  try {
    const dir = join(OBSERVATION_DIR, "pi-owui-bridge");
    mkdirSync(dir, { recursive: true });
    observationPath = join(dir, `ext-${process.pid}.jsonl`);
  } catch {
    observationPath = null;
  }
}
let observationSeq = 0;

function emitObservation(stage: string, payload: unknown): void {
  if (!observationPath) return;
  observationSeq += 1;
  const record = {
    kind: "agent_event",
    trace_id: currentTraceId(),
    session_id: SESSION_ID,
    event_seq: observationSeq,
    stage,
    source_module: "pi-owui-bridge/owui-tools-extension",
    ts: new Date().toISOString(),
    payload,
  };
  try {
    appendFileSync(observationPath, JSON.stringify(record) + "\n", "utf8");
  } catch {
    /* observation must never break the agent */
  }
}
/**
 * Sidecar file the bridge writes before each prompt round so this
 * extension can stamp the *current* turn's trace id on OWUI HTTP
 * calls. Falls back to the spawn-time env var when missing (e.g.
 * when the process is exercised outside the bridge).
 */
const TRACE_ID_PATH = join(process.cwd(), ".aoh-current-trace-id");

function currentTraceId(): string {
  try {
    return readFileSync(TRACE_ID_PATH, "utf8").trim() || SPAWN_TRACE_ID;
  } catch {
    return SPAWN_TRACE_ID;
  }
}

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
  const traceId = currentTraceId();
  if (traceId) headers["X-Aoh-Trace-Id"] = traceId;
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
  pi.on("session_start", async () => {
    const specs = await discoverToolSpecs();
    for (const spec of specs) {
      pi.registerTool({
        name: spec.name,
        label: spec.name,
        description: spec.description ?? `Open WebUI tool: ${spec.name}`,
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

  // Mirror the wire-level payload going to the model under our
  // aoh_trace_id. This is what the hub's
  // /api/assertions/payload-inspect/<trace> endpoint reads, so
  // overlay-stale / skill-inject scenarios can verify whether STALE
  // / skill text actually reached the LLM request body.
  // The pi.on overload union lists this event but using its concrete
  // typed handler shape; we don't need the result/return-value contract,
  // so we go through the looser ``unknown`` cast to attach the listener.
  // pi-coding-agent exposes the post-build LLM payload as
  // ``before_provider_request`` (not ``before_provider_payload``, which
  // is internal to pi-agent-core).
  pi.on("before_provider_request", async (event) => {
    emitObservation("before_provider_payload", { payload: event.payload });
  });
}
