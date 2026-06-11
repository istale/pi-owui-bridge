/**
 * Drive one HTTP turn through Pi's ``AgentHarness``.
 *
 * This is the "Stage 10" replacement for the self-written loop in
 * ``../agent-loop.ts``. It keeps the loop's external contract (input
 * payload, ``AgentLoopResult`` shape) intact so ``server.ts`` and the
 * tests around it don't need to change.
 *
 * Per-request setup:
 * - InMemorySessionRepo so nothing persists to disk (OWUI owns the
 *   conversation; Pi's session is an ephemeral scratch space for this
 *   turn only).
 * - NodeExecutionEnv pointed at the OS tmp dir so filesystem tools
 *   (which we don't register anyway) won't touch anything meaningful.
 * - AgentHarness seeded with every message OWUI sent us, then
 *   ``prompt`` called with the latest user text to drive the loop.
 */
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

import {
  AgentHarness,
  InMemorySessionRepo,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type {
  AssistantMessage,
  Message as PiAiMessage,
  ToolResultMessage as PiAiToolResult,
} from "@earendil-works/pi-ai";

import type { Message as OwuiMessage } from "../openai-types.js";
import type { ToolClient } from "../tool-client.js";
import type { ToolSpec } from "../tool-client.js";
import type { UpstreamClient } from "../upstream.js";
import { buildHubModel } from "./model.js";
import { buildAgentTools } from "./tools.js";

export interface HarnessRunContext {
  userId: string;
  chatId?: string;
  messageId?: string;
  aohTraceId: string;
  maxIterations: number;
}

export interface HarnessRunResult {
  /** Final assistant message Pi produced after the loop terminated. */
  assistant: AssistantMessage;
  /** Number of model calls the harness ended up making. */
  modelCallCount: number;
  /** Total tool dispatches across the turn. */
  toolCallCount: number;
}

function asPiMessages(messages: OwuiMessage[]): PiAiMessage[] {
  // Convert the OpenAI-format messages OWUI sent us into pi-ai's domain
  // shape. Strip system here — it goes through harness.systemPrompt
  // instead so it can be re-composed on retries. tool_call_id pairing
  // is preserved on toolResult conversions.
  const out: PiAiMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      out.push({
        role: "user",
        content: typeof m.content === "string" ? m.content : "",
        timestamp: Date.now(),
      });
      continue;
    }
    if (m.role === "tool") {
      const toolResult: PiAiToolResult = {
        role: "toolResult",
        toolCallId: m.tool_call_id ?? "",
        toolName: m.name ?? "",
        content: [{ type: "text", text: (m.content as string) ?? "" }],
        isError: false,
        timestamp: Date.now(),
      };
      out.push(toolResult);
      continue;
    }
    if (m.role === "assistant") {
      // We rebuild from text content only; OWUI rarely sends tool_calls
      // back to us mid-history, and AgentHarness regenerates them anyway.
      out.push({
        role: "assistant",
        content: [{ type: "text", text: (m.content as string) ?? "" }],
        api: "openai-completions",
        provider: "aoh-hub",
        model: "unknown",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      } as AssistantMessage);
    }
  }
  return out;
}

function extractSystem(messages: OwuiMessage[]): string {
  const sys = messages.find((m) => m.role === "system");
  if (!sys) return "";
  return typeof sys.content === "string" ? sys.content : "";
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

export async function runWithHarness(opts: {
  messages: OwuiMessage[];
  modelId: string;
  toolSpecs: ToolSpec[];
  toolClient: ToolClient;
  upstream: UpstreamClient;
  ctx: HarnessRunContext;
  hubBaseUrl: string;
  hubApiKey: string;
}): Promise<HarnessRunResult> {
  const sessionRepo = new InMemorySessionRepo();
  const session = await sessionRepo.create();
  const env = new NodeExecutionEnv({ cwd: mkdtempSync(join(tmpdir(), "aoh-harness-")) });
  const model = buildHubModel({ baseUrl: opts.hubBaseUrl, modelId: opts.modelId });
  const tools = buildAgentTools(opts.toolSpecs, opts.toolClient, opts.ctx);

  // Seed the session with the prior turns OWUI sent. ``appendMessage``
  // emits them as session entries so AgentHarness sees the full
  // transcript when building the model context on the first turn.
  const priorMessages = asPiMessages(opts.messages.slice(0, -1));
  for (const m of priorMessages) {
    await session.appendMessage(m);
  }

  const systemPrompt = extractSystem(opts.messages);
  const latestUserText = extractLatestUserText(opts.messages);

  const harness = new AgentHarness({
    env,
    session,
    model,
    tools,
    activeToolNames: tools.map((t) => t.name),
    systemPrompt: systemPrompt || undefined,
    getApiKeyAndHeaders: async () => ({ apiKey: opts.hubApiKey }),
  });

  let modelCallCount = 0;
  let toolCallCount = 0;
  const unsubscribe = harness.subscribe(async (event) => {
    if (event.type === "message_end") {
      const msg = event.message as AssistantMessage;
      if (msg?.role === "assistant") {
        modelCallCount += 1;
        for (const block of msg.content ?? []) {
          if (block.type === "toolCall") toolCallCount += 1;
        }
      }
    }
  });

  let assistant: AssistantMessage | null = null;
  try {
    assistant = await harness.prompt(latestUserText);
  } finally {
    unsubscribe();
  }

  return {
    assistant: assistant ?? {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      api: "openai-completions",
      provider: "aoh-hub",
      model: opts.modelId,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    },
    modelCallCount,
    toolCallCount,
  };
}
