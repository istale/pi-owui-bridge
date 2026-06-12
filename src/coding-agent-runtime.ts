/**
 * Drive one HTTP turn through pi-coding-agent's ``AgentSession``.
 *
 * Architectural intent: the bridge is the *communication layer only*. The
 * agent runtime (model loop, tool execution, skill loading, compaction,
 * session lifecycle) lives in ``@earendil-works/pi-coding-agent``. When
 * upstream Pi adds a feature we want, we get it from
 * ``npm update @earendil-works/pi-coding-agent`` — not by porting.
 *
 * Per-request setup:
 * - Fresh AgentSession for each HTTP turn (no cross-request state).
 * - cwd / agentDir / sessionDir are all under one tmp dir we delete in a
 *   ``finally`` block. Pi insists on writing session JSONL on disk;
 *   pointing that disk at tmp makes it a no-op for us.
 * - ``noTools: "builtin"`` disables bash/read/edit/write — Pi was built
 *   for coding, but our domain (manufacturing data analysis) must not
 *   touch the user's filesystem.
 * - Our 5 OWUI tools are registered as ``customTools`` (see
 *   ``./tool-defs.ts``) so the model sees the same function specs OWUI
 *   would surface in-process.
 * - Skills are loaded from ``$AOH_SKILLS_DIR/<user>/`` and turned into a
 *   ``systemPrompt`` prefix; we do not symlink them into Pi's cwd because
 *   that would mix our per-user skill tree with Pi's project-skill model.
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  AuthStorage,
  createAgentSession,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Message as PiAiMessage } from "@earendil-works/pi-ai";

import { buildHubModel } from "./pi-harness/model.js";
import { buildAgentSessionTools } from "./tool-defs.js";
import type { Message as OwuiMessage } from "./openai-types.js";
import type { ToolClient, ToolSpec } from "./tool-client.js";

export interface CodingAgentRunContext {
  userId: string;
  chatId?: string;
  messageId?: string;
  aohTraceId: string;
}

export interface CodingAgentRunResult {
  assistant: AssistantMessage;
  modelCallCount: number;
  toolCallCount: number;
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

function formatHistoryAsContext(messages: OwuiMessage[]): string {
  // We don't have an easy way to seed pi-coding-agent's session tree from
  // OpenAI-format history (the underlying Session expects pi-ai AgentMessage
  // shapes and a parent chain). For now we render the prior turns into the
  // system prompt as a transcript. This is lossy for tool_calls but matches
  // what most chat UIs expect at the request boundary.
  const prior = messages.slice(0, -1).filter((m) => m.role !== "system");
  if (prior.length === 0) return "";
  const lines: string[] = ["", "## Prior conversation", ""];
  for (const m of prior) {
    if (m.role === "user") lines.push(`User: ${typeof m.content === "string" ? m.content : ""}`);
    else if (m.role === "assistant") lines.push(`Assistant: ${typeof m.content === "string" ? m.content : ""}`);
    else if (m.role === "tool") lines.push(`Tool result: ${typeof m.content === "string" ? m.content : ""}`);
  }
  return lines.join("\n");
}

export async function runWithCodingAgent(opts: {
  messages: OwuiMessage[];
  modelId: string;
  toolSpecs: ToolSpec[];
  toolClient: ToolClient;
  ctx: CodingAgentRunContext;
  hubBaseUrl: string;
  hubApiKey: string;
}): Promise<CodingAgentRunResult> {
  const baseTmp = join(tmpdir(), `aoh-cca-${randomUUID().slice(0, 8)}`);
  const cwd = join(baseTmp, "cwd");
  const agentDir = join(baseTmp, "pi-agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });

  const model = buildHubModel({ baseUrl: opts.hubBaseUrl, modelId: opts.modelId });
  const customTools = buildAgentSessionTools(opts.toolSpecs, opts.toolClient, opts.ctx);

  const composedSystem = [extractSystem(opts.messages), formatHistoryAsContext(opts.messages)]
    .filter((s) => s)
    .join("\n\n");
  const latestUserText = extractLatestUserText(opts.messages);

  // Use an in-memory AuthStorage so nothing lands on disk and we control
  // exactly which key the agent sees for our synthetic 'aoh-hub' provider.
  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey(model.provider, opts.hubApiKey);

  const options: CreateAgentSessionOptions = {
    cwd,
    agentDir,
    model,
    authStorage,
    noTools: "builtin", // hide read/bash/edit/write
    customTools,
  };

  let modelCallCount = 0;
  let toolCallCount = 0;
  let lastAssistantText = "";

  try {
    const { session } = await createAgentSession(options);

    if (composedSystem) {
      // pi-coding-agent's createAgentSession composes its own system prompt
      // out of model defaults + skills + active tools. We add ours by
      // appending an "Additional context" preamble through the session's
      // setBaseSystemPromptOverride hook if available; otherwise we tack
      // it onto the user prompt.
      const setter = (session as unknown as { setSystemPromptOverride?: (s: string) => void }).setSystemPromptOverride;
      if (typeof setter === "function") {
        setter.call(session, composedSystem);
      }
    }

    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_end") {
        const m = event.message as PiAiMessage | undefined;
        if (m?.role === "assistant") {
          modelCallCount += 1;
          const msg = m as AssistantMessage;
          for (const block of msg.content ?? []) {
            if (block.type === "toolCall") toolCallCount += 1;
            if (block.type === "text") lastAssistantText = block.text;
          }
        }
      }
    });

    try {
      const promptText = composedSystem
        ? `${composedSystem}\n\n---\n\n${latestUserText}`
        : latestUserText;
      await session.prompt(promptText, { source: "interactive" });
    } finally {
      unsubscribe();
    }

    const assistant: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: lastAssistantText }],
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
    };
    return { assistant, modelCallCount, toolCallCount };
  } finally {
    rmSync(baseTmp, { recursive: true, force: true });
  }
}
