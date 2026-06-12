/**
 * pi-owui-bridge: pure communication layer.
 *
 * Translates the OpenAI ``/v1/chat/completions`` HTTP contract Open WebUI
 * speaks into Pi's stdin/stdout RPC, and vice versa. There is no agent
 * loop in this repo — Pi runs the loop in a subprocess per (user_id,
 * chat_id). The extension at ``./extension/owui-tools.ts`` teaches that
 * Pi about Open WebUI's HTTP tool surface.
 */
import express from "express";

import { getConfig } from "./config.js";
import { BridgeObservationEmitter } from "./observation-emit.js";
import type { Message as OwuiMessage } from "./openai-types.js";
import { PiPool, makeTraceId } from "./pi-process.js";

interface AppDeps {
  pool: PiPool;
  emitter: BridgeObservationEmitter;
}

function extractLatestUserText(messages: OwuiMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") {
      const c = messages[i].content;
      return typeof c === "string" ? c : "";
    }
  }
  return "";
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      pi_processes: deps.pool.size(),
    });
  });

  app.post("/v1/chat/completions", async (req, res) => {
    const userId = (req.header("X-User-Id") ?? "").trim() || "anonymous";
    const chatId = (req.header("X-Chat-Id") ?? "").trim() || `oneshot-${makeTraceId()}`;
    const aohTraceId = makeTraceId();
    const wantStream = Boolean(req.body?.stream);

    const messages = (req.body?.messages ?? []) as OwuiMessage[];
    const userText = extractLatestUserText(messages);
    if (!userText) {
      res.status(400).json({ error: { message: "no user message in payload" } });
      return;
    }

    const pi = deps.pool.acquire({ userId, chatId, aohTraceId });
    const sessionId = `owui-chat:${userId}:${chatId}`;

    // Collect events into a final response. Pi may emit several
    // ``message_end`` events across the turn (one per LLM call); we keep
    // only the last assistant text, then resolve on ``agent_end``.
    let finalText = "";
    let modelCalls = 0;
    let toolCalls = 0;

    const done = new Promise<void>((resolve, reject) => {
      const timeoutMs = 5 * 60_000;
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`pi turn timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const unsubscribe = pi.onEvent((event) => {
        const type = event.type as string | undefined;
        if (type === "before_provider_payload") {
          // Re-key this event under OUR aoh_trace_id so the hub's
          // /api/assertions/payload-inspect/<trace> endpoint can answer
          // "what did the model actually see for this turn?". Pi emits
          // the same shape on its own observation channel under its
          // internal trace id; this emit is the bridge-side mirror.
          deps.emitter.emit({
            stage: "before_provider_payload",
            traceId: aohTraceId,
            sessionId,
            payload: { model: event.model, payload: event.payload },
          });
        } else if (type === "message_end") {
          const message = event.message as
            | { role?: string; content?: Array<{ type: string; text?: string }> }
            | undefined;
          if (message?.role === "assistant") {
            modelCalls += 1;
            for (const block of message.content ?? []) {
              if (block.type === "toolCall") toolCalls += 1;
              if (block.type === "text" && block.text) finalText = block.text;
            }
          }
        } else if (type === "agent_end") {
          clearTimeout(timer);
          unsubscribe();
          resolve();
        }
      });
    });

    try {
      // Refresh the trace-id sidecar so this turn's OWUI tool calls
      // stamp the correct id even when the Pi process was spawned
      // earlier (and pinned the previous turn's id in env).
      pi.setActiveTraceId(aohTraceId);
      pi.send({ type: "prompt", message: userText });
      await done;
    } catch (err) {
      console.error("turn failed:", err);
      res.status(502).json({ error: { message: err instanceof Error ? err.message : String(err) } });
      return;
    }

    const piMeta = {
      aoh_trace_id: aohTraceId,
      pi_pool_size: deps.pool.size(),
      iterations: modelCalls,
      tool_call_count: toolCalls,
    };

    if (wantStream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("X-Aoh-Trace-Id", aohTraceId);
      res.write(
        `data: ${JSON.stringify({
          id: `pi-${aohTraceId}`,
          choices: [{ index: 0, delta: { content: finalText }, finish_reason: "stop" }],
          pi_adapter: piMeta,
        })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    res.json({
      id: `pi-${aohTraceId}`,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: finalText },
          finish_reason: "stop",
        },
      ],
      pi_adapter: piMeta,
    });
  });

  return app;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const cfg = getConfig();
  const pool = new PiPool(cfg);
  pool.start();
  const emitter = new BridgeObservationEmitter(cfg.observationDir);
  const app = createApp({ pool, emitter });
  app.listen(cfg.port, "127.0.0.1", () => {
    console.log(`pi-owui-bridge (RPC subprocess mode) listening on http://127.0.0.1:${cfg.port}`);
  });
  process.on("SIGTERM", () => {
    pool.stop();
    process.exit(0);
  });
}
