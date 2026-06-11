/**
 * Tool-using agent loop.
 *
 * Phase 1 implementation: direct OpenAI-compatible HTTP calls. Phase 2
 * (follow-up commit) will swap the body of ``runAgentLoop`` with an
 * ``AgentHarness`` from ``@earendil-works/pi-agent-core`` so we ride
 * upstream Pi improvements; all surrounding wiring (tool client,
 * overlay, skills, observation) stays as-is.
 */
import type { AssistantMessage, Message, ToolCall } from "./openai-types.js";
import type { ToolClient } from "./tool-client.js";
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

export async function runAgentLoop(opts: {
  initialPayload: UpstreamRequest;
  toolSpecs: Array<Record<string, unknown>>;
  upstream: UpstreamClient;
  toolClient: ToolClient;
  ctx: AgentLoopContext;
}): Promise<AgentLoopResult> {
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
