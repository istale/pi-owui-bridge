/**
 * Tool-using agent loop.
 *
 * Two backends are available behind a single function: the
 * "self" loop in this file (kept as a fallback / comparison point)
 * and the AgentHarness-driven loop in ``./pi-harness/runtime.ts``
 * which dispatches through Pi's runtime so upstream provider/streaming
 * fixes flow in via ``npm update``.
 *
 * Pick at process start via ``AOH_RUNTIME=harness`` (default) or
 * ``AOH_RUNTIME=self``.
 */
import type { AssistantMessage, Message, ToolCall } from "./openai-types.js";
import { runWithHarness } from "./pi-harness/runtime.js";
import { runWithCodingAgent } from "./coding-agent-runtime.js";
import type { ToolClient } from "./tool-client.js";
import type { ToolSpec } from "./tool-client.js";
import type { UpstreamClient, UpstreamRequest } from "./upstream.js";

export interface AgentLoopContext {
  userId: string;
  chatId?: string;
  messageId?: string;
  aohTraceId: string;
  maxIterations: number;
}

export interface AgentLoopResult {
  finalResponse: Awaited<ReturnType<UpstreamClient["chatCompletion"]>>;
  iterations: number;
  toolCallCount: number;
}

function stringifyToolResult(result: { ok: boolean; result?: unknown; error_code?: string; error_message?: string }): string {
  if (result.ok) {
    return JSON.stringify(result.result ?? {});
  }
  return JSON.stringify({ error: result.error_code ?? "ToolError", message: result.error_message ?? "" });
}

export type RuntimeMode = "coding-agent" | "harness" | "self";

/**
 * Three backends behind one ``runAgentLoop`` entry point. Pick at process
 * start via ``AOH_RUNTIME``:
 *
 * - ``coding-agent`` (default): full pi-coding-agent AgentSession. Bridge
 *   is the communication layer only; the loop, tools, skills, sessions
 *   all come from Pi. Upstream Pi improvements flow in via npm update.
 * - ``harness``: lower-level pi-agent-core AgentHarness. Skips
 *   pi-coding-agent's skill loader / project trust / file-tool defaults
 *   but still rides on pi-ai for the model call.
 * - ``self``: the original self-written OpenAI HTTP loop. Kept as a
 *   fallback / A-B comparison only.
 */
export function resolveRuntime(envValue: string | undefined = process.env.AOH_RUNTIME): RuntimeMode {
  const v = (envValue ?? "").trim().toLowerCase();
  if (v === "self") return "self";
  if (v === "harness") return "harness";
  return "coding-agent";
}

export interface AgentLoopRunOptions {
  initialPayload: UpstreamRequest;
  toolSpecs: Array<Record<string, unknown>>;
  upstream: UpstreamClient;
  toolClient: ToolClient;
  ctx: AgentLoopContext;
  /** Upstream baseUrl and apiKey are needed by the AgentHarness runtime path
   *  (it constructs its own Pi Model object pointed at Hub). Optional so
   *  callers using ``self`` mode don't have to supply them. */
  upstreamBaseUrl?: string;
  upstreamApiKey?: string;
  /** Override the runtime — useful for tests. Defaults to env. */
  runtime?: RuntimeMode;
}

export async function runAgentLoop(opts: AgentLoopRunOptions): Promise<AgentLoopResult> {
  const runtime = opts.runtime ?? resolveRuntime();
  if (runtime === "coding-agent") return runAgentLoopCodingAgent(opts);
  if (runtime === "harness") return runAgentLoopHarness(opts);
  return runAgentLoopSelf(opts);
}

async function runAgentLoopCodingAgent(opts: AgentLoopRunOptions): Promise<AgentLoopResult> {
  if (!opts.upstreamBaseUrl || !opts.upstreamApiKey) {
    throw new Error("coding-agent runtime requires upstreamBaseUrl + upstreamApiKey");
  }
  const out = await runWithCodingAgent({
    messages: (opts.initialPayload.messages ?? []) as Message[],
    modelId: (opts.initialPayload.model as string) ?? "MiniMax-M2",
    toolSpecs: opts.toolSpecs as unknown as ToolSpec[],
    toolClient: opts.toolClient,
    ctx: opts.ctx,
    hubBaseUrl: opts.upstreamBaseUrl,
    hubApiKey: opts.upstreamApiKey,
  });
  const finalText = (out.assistant.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");
  return {
    finalResponse: {
      id: `cca-${opts.ctx.aohTraceId}`,
      choices: [
        {
          index: 0,
          message: { role: "assistant" as const, content: finalText },
          finish_reason: out.assistant.stopReason ?? "stop",
        },
      ],
    },
    iterations: out.modelCallCount,
    toolCallCount: out.toolCallCount,
  };
}

async function runAgentLoopHarness(opts: AgentLoopRunOptions): Promise<AgentLoopResult> {
  if (!opts.upstreamBaseUrl || !opts.upstreamApiKey) {
    throw new Error("harness runtime requires upstreamBaseUrl + upstreamApiKey");
  }
  const messages = (opts.initialPayload.messages ?? []) as Message[];
  const out = await runWithHarness({
    messages,
    modelId: (opts.initialPayload.model as string) ?? "MiniMax-M2",
    toolSpecs: opts.toolSpecs as unknown as ToolSpec[],
    toolClient: opts.toolClient,
    upstream: opts.upstream,
    ctx: opts.ctx,
    hubBaseUrl: opts.upstreamBaseUrl,
    hubApiKey: opts.upstreamApiKey,
  });

  // Shape the result like the existing OpenAI chat completion response so
  // callers (server.ts, e2e scenarios) can treat both runtimes identically.
  const finalText = (out.assistant.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");
  const finalResponse = {
    id: `harness-${opts.ctx.aohTraceId}`,
    choices: [
      {
        index: 0,
        message: { role: "assistant" as const, content: finalText },
        finish_reason: out.assistant.stopReason ?? "stop",
      },
    ],
  };
  return { finalResponse, iterations: out.modelCallCount, toolCallCount: out.toolCallCount };
}

async function runAgentLoopSelf(opts: AgentLoopRunOptions): Promise<AgentLoopResult> {
  const payload: UpstreamRequest = { ...opts.initialPayload, messages: [...(opts.initialPayload.messages ?? [])] };
  if (opts.toolSpecs.length > 0) {
    payload.tools = opts.toolSpecs.map((spec) => ({ type: "function", function: spec }));
    payload.tool_choice = payload.tool_choice ?? "auto";
  }

  let toolCallCount = 0;
  let iterations = 0;
  let last: Awaited<ReturnType<UpstreamClient["chatCompletion"]>> | null = null;

  while (iterations < opts.ctx.maxIterations) {
    iterations += 1;
    last = await opts.upstream.chatCompletion(payload);
    const message = last.choices?.[0]?.message;
    const toolCalls = (message as AssistantMessage | undefined)?.tool_calls ?? [];

    if (toolCalls.length === 0) return { finalResponse: last, iterations, toolCallCount };

    payload.messages.push(message as Message);
    for (const tc of toolCalls as ToolCall[]) {
      toolCallCount += 1;
      let args: Record<string, unknown> = {};
      let result: { ok: boolean; result?: unknown; error_code?: string; error_message?: string };
      try {
        args = JSON.parse(tc.function?.arguments ?? "{}");
      } catch (err) {
        result = {
          ok: false,
          error_code: "InvalidToolArguments",
          error_message: err instanceof Error ? err.message : String(err),
        };
        payload.messages.push({
          role: "tool",
          tool_call_id: tc.id,
          name: tc.function?.name,
          content: stringifyToolResult(result),
        });
        continue;
      }
      result = await opts.toolClient.execute({
        toolName: tc.function.name,
        args,
        userId: opts.ctx.userId,
        chatId: opts.ctx.chatId,
        messageId: opts.ctx.messageId,
        aohTraceId: opts.ctx.aohTraceId,
      });
      payload.messages.push({
        role: "tool",
        tool_call_id: tc.id,
        name: tc.function.name,
        content: stringifyToolResult(result),
      });
    }
  }
  return { finalResponse: last!, iterations, toolCallCount };
}
