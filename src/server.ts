/**
 * pi-owui-bridge — Express server.
 *
 * One per-request agent loop composed of:
 *   composeMessages(skills + system + overlay)
 *   → runAgentLoop(upstream + OWUI tool dispatch)
 *   → optional SSE streaming back
 *   → emit before/after observation events
 *
 * The HTTP surface is OpenAI-compatible so Open WebUI's existing chat
 * forwarder needs only a base-URL change to talk to this service.
 */
import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";

import { getConfig } from "./config.js";
import { runAgentLoop } from "./agent-loop.js";
import { ObservationEmitter } from "./observation.js";
import { applyToMessages, loadOverlays } from "./overlay.js";
import { loadSkills } from "./skills.js";
import { composeMessages } from "./system-prompt.js";
import { ToolClient, type ToolSpec } from "./tool-client.js";
import { UpstreamClient } from "./upstream.js";

interface BridgeContext {
  toolClient: ToolClient;
  upstream: UpstreamClient;
  emitter: ObservationEmitter;
  toolSpecs: ToolSpec[];
  toolSpecsLoadedAt: number;
}

let bridge: BridgeContext | null = null;

export async function createApp(opts?: Partial<BridgeContext>): Promise<express.Express> {
  const cfg = getConfig();
  const toolClient = opts?.toolClient ?? new ToolClient(cfg.owuiBaseUrl, cfg.piSharedSecret);
  const upstream = opts?.upstream ?? new UpstreamClient(cfg.upstreamBaseUrl, cfg.upstreamApiKey, cfg.requestTimeoutMs);
  const emitter = opts?.emitter ?? new ObservationEmitter(cfg.observationDir);

  let toolSpecs: ToolSpec[];
  if (opts?.toolSpecs) {
    toolSpecs = opts.toolSpecs;
  } else {
    try {
      toolSpecs = await toolClient.listToolSpecs();
    } catch (err) {
      console.warn("startup tool discovery failed; continuing with empty tool set:", err);
      toolSpecs = [];
    }
  }

  bridge = { toolClient, upstream, emitter, toolSpecs, toolSpecsLoadedAt: Date.now() };

  const app = express();
  app.use(express.json({ limit: "10mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      tool_count: bridge?.toolSpecs.length ?? 0,
      tool_specs_loaded_at: bridge?.toolSpecsLoadedAt ?? 0,
      observation_enabled: bridge?.emitter.enabled ?? false,
    });
  });

  app.post("/v1/tool-specs/refresh", async (_req, res) => {
    if (!bridge) return res.status(500).json({ error: "not initialised" });
    bridge.toolSpecs = await bridge.toolClient.listToolSpecs();
    bridge.toolSpecsLoadedAt = Date.now();
    res.json({ tool_count: bridge.toolSpecs.length });
  });

  app.post("/v1/chat/completions", async (req: Request, res: Response) => {
    if (!bridge) return res.status(500).json({ error: "not initialised" });
    const userId = (req.header("X-User-Id") ?? "").trim() || "anonymous";
    const chatId = req.header("X-Chat-Id")?.trim() || undefined;
    const messageId = req.header("X-Message-Id")?.trim() || undefined;
    const aohTraceId = `pi-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const sessionId = `owui-chat:${userId}:${chatId ?? "no-chat"}`;
    const wantStream = Boolean(req.body?.stream);

    const skills = loadSkills(cfg.skillsDir, userId);
    const overlays =
      chatId && cfg.observationDir ? loadOverlays(cfg.observationDir, userId, chatId) : [];
    const composed = composeMessages({
      messages: req.body.messages ?? [],
      skills,
      overlays,
    });
    const messages = applyToMessages(composed.messages, overlays);

    bridge.emitter.emit({
      stage: "before_provider_request",
      trace_id: aohTraceId,
      session_id: sessionId,
      payload: {
        owui_user_id: userId,
        owui_chat_id: chatId,
        owui_message_id: messageId,
        model: req.body.model,
        message_count: messages.length,
        overlay: {
          applied: overlays.length,
          annotation_chars: composed.overlayCharCount,
        },
        skills: { applied: skills.length, preamble_chars: composed.skillCharCount, names: skills.map((s) => s.name) },
        stream: wantStream,
      },
    });

    try {
      if (wantStream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("X-Aoh-Trace-Id", aohTraceId);
        // Phase 1: run the non-stream loop, then emit the final assistant
        // message as a single SSE chunk + [DONE]. Phase 2 will switch to
        // true upstream streaming with mid-flight tool dispatch.
        const result = await runAgentLoop({
          initialPayload: { ...req.body, messages },
          toolSpecs: bridge.toolSpecs as Array<Record<string, unknown>>,
          upstream: bridge.upstream,
          toolClient: bridge.toolClient,
          ctx: { userId, chatId, messageId, aohTraceId, maxIterations: cfg.maxToolIterations },
        });
        const final = result.finalResponse.choices?.[0]?.message;
        const chunk = {
          id: result.finalResponse.id,
          choices: [{ index: 0, delta: { content: final?.content ?? "" }, finish_reason: "stop" }],
          pi_adapter: { aoh_trace_id: aohTraceId, iterations: result.iterations },
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        bridge.emitter.emit({
          stage: "agent_loop_completed",
          trace_id: aohTraceId,
          session_id: sessionId,
          payload: {
            owui_chat_id: chatId,
            owui_message_id: messageId,
            iterations: result.iterations,
            tool_call_count: result.toolCallCount,
            stream: true,
          },
        });
        return;
      }
      const result = await runAgentLoop({
        initialPayload: { ...req.body, messages },
        toolSpecs: bridge.toolSpecs as Array<Record<string, unknown>>,
        upstream: bridge.upstream,
        toolClient: bridge.toolClient,
        ctx: { userId, chatId, messageId, aohTraceId, maxIterations: cfg.maxToolIterations },
      });
      bridge.emitter.emit({
        stage: "agent_loop_completed",
        trace_id: aohTraceId,
        session_id: sessionId,
        payload: {
          owui_chat_id: chatId,
          owui_message_id: messageId,
          iterations: result.iterations,
          tool_call_count: result.toolCallCount,
          stream: false,
        },
      });
      res.json({
        ...result.finalResponse,
        pi_adapter: {
          aoh_trace_id: aohTraceId,
          iterations: result.iterations,
          tool_call_count: result.toolCallCount,
          overlay: { applied: overlays.length },
          skills: { applied: skills.length, names: skills.map((s) => s.name) },
        },
      });
    } catch (err) {
      console.error("agent loop failed:", err);
      bridge.emitter.emit({
        stage: "agent_loop_failed",
        trace_id: aohTraceId,
        session_id: sessionId,
        payload: { error: err instanceof Error ? err.message : String(err) },
      });
      res.status(502).json({ error: { message: err instanceof Error ? err.message : String(err) } });
    }
  });

  return app;
}

// CLI entry — `node dist/server.js` or `npm start`
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const cfg = getConfig();
  createApp().then((app) => {
    app.listen(cfg.port, "127.0.0.1", () => {
      console.log(`pi-owui-bridge listening on http://127.0.0.1:${cfg.port}`);
    });
  });
}
