/**
 * Adapt OWUI's HTTP-backed tool service to Pi's ``AgentTool`` interface.
 *
 * Each spec coming from ``GET /api/v1/data-analysis/tool-specs`` is a JSON
 * Schema. Pi's ``AgentTool.parameters`` is typed as TypeBox ``TSchema`` —
 * at runtime that just means a plain JSON Schema object, so we pass it
 * through with a cast (compile-time fidelity isn't useful here since the
 * shape is only known at runtime anyway).
 *
 * The ``execute`` callback delegates back to ``ToolClient`` so the actual
 * dispatch path (auth + headers + aoh_trace_id stamping) stays in one
 * place shared with the legacy Phase-1 loop.
 */
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TSchema } from "@sinclair/typebox";

import type { ToolClient } from "../tool-client.js";

export interface PerRequestToolContext {
  userId: string;
  chatId?: string;
  messageId?: string;
  aohTraceId: string;
}

export interface SpecLike {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

function stringifyToolResult(result: {
  ok: boolean;
  result?: unknown;
  error_code?: string;
  error_message?: string;
}): string {
  if (result.ok) return JSON.stringify(result.result ?? {});
  return JSON.stringify({
    error: result.error_code ?? "ToolError",
    message: result.error_message ?? "",
  });
}

/**
 * Build a list of AgentTools the harness will register for one request.
 *
 * The closure captures ``ctx`` so each tool execution can stamp
 * ``aoh_trace_id`` + ``X-User-Id`` without the harness having to know
 * about either.
 */
export function buildAgentTools(
  specs: SpecLike[],
  toolClient: ToolClient,
  ctx: PerRequestToolContext,
): AgentTool[] {
  return specs.map((spec) => {
    const tool: AgentTool = {
      name: spec.name,
      label: spec.name,
      description: spec.description ?? `Open WebUI tool: ${spec.name}`,
      parameters: spec.parameters as unknown as TSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
      ): Promise<AgentToolResult<unknown>> => {
        const result = await toolClient.execute({
          toolName: spec.name,
          args: (params as Record<string, unknown>) ?? {},
          userId: ctx.userId,
          chatId: ctx.chatId,
          messageId: ctx.messageId,
          aohTraceId: ctx.aohTraceId,
        });
        // AgentTool.execute is required to throw on failure rather than encode
        // the error in content. We deliberately do NOT throw: surfacing the
        // error envelope as a text content block lets the model see the
        // failure mode and decide how to recover, which is the same UX the
        // OWUI tool middleware delivers in-process.
        return {
          content: [{ type: "text", text: stringifyToolResult(result) }],
          details: result,
        };
      },
    };
    return tool;
  });
}
