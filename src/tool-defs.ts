/**
 * Adapt OWUI tool specs to pi-coding-agent's ``ToolDefinition`` interface.
 *
 * AgentHarness (pi-agent-core) and AgentSession (pi-coding-agent) consume
 * slightly different tool shapes — the agent-core version is
 * ``AgentTool`` (execute returns ``AgentToolResult``), the coding-agent
 * version is ``ToolDefinition`` (execute returns a similar shape but the
 * type parameters differ at the static level). At runtime both are JSON
 * Schema objects; we hand the same JSON spec to the type parameter slot
 * with an ``unknown`` cast so TypeScript doesn't trip over TypeBox's
 * Static<> inference.
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";

import type { PerRequestToolContext } from "./pi-harness/tools.js";
import type { ToolClient, ToolSpec } from "./tool-client.js";

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

export function buildAgentSessionTools(
  specs: ToolSpec[],
  toolClient: ToolClient,
  ctx: PerRequestToolContext,
): ToolDefinition[] {
  return specs.map((spec) => {
    const def: ToolDefinition = {
      name: spec.name,
      label: spec.name,
      description: spec.description ?? `Open WebUI tool: ${spec.name}`,
      parameters: spec.parameters as unknown as TSchema,
      execute: async (_toolCallId: string, params: unknown) => {
        const result = await toolClient.execute({
          toolName: spec.name,
          args: (params as Record<string, unknown>) ?? {},
          userId: ctx.userId,
          chatId: ctx.chatId,
          messageId: ctx.messageId,
          aohTraceId: ctx.aohTraceId,
        });
        return {
          content: [{ type: "text", text: stringifyToolResult(result) }],
          details: result,
        };
      },
    };
    return def;
  });
}
