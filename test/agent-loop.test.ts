import { describe, expect, it } from "vitest";

import { runAgentLoop } from "../src/agent-loop.js";

function fakeUpstream(scripted: any[]) {
  let n = 0;
  return {
    chatCompletion: async (body: any) => {
      const next = scripted[n] ?? scripted[scripted.length - 1];
      n += 1;
      return typeof next === "function" ? next(body) : next;
    },
  } as any;
}

function fakeToolClient(handler: (call: any) => any) {
  return {
    execute: async (call: any) => handler(call),
  } as any;
}

function assistantWithToolCall(name: string, args: any, id = "c1") {
  return {
    id: "u",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}

function assistantFinal(text: string) {
  return {
    id: "u",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  };
}

describe("runAgentLoop", () => {
  it("returns immediately when no tool calls", async () => {
    const upstream = fakeUpstream([assistantFinal("hello")]);
    const out = await runAgentLoop({
      initialPayload: { model: "m", messages: [{ role: "user", content: "hi" }] },
      toolSpecs: [],
      upstream,
      toolClient: fakeToolClient(() => ({ ok: true, result: {} })),
      ctx: { userId: "alice", aohTraceId: "tr-1", maxIterations: 5 },
    });
    expect(out.iterations).toBe(1);
    expect(out.toolCallCount).toBe(0);
    expect(out.finalResponse.choices[0].message.content).toBe("hello");
  });

  it("dispatches a tool then continues", async () => {
    let toolHits = 0;
    const upstream = fakeUpstream([
      assistantWithToolCall("list_datasets", {}),
      (body: any) => {
        const lastRole = body.messages[body.messages.length - 1].role;
        expect(lastRole).toBe("tool");
        return assistantFinal("done");
      },
    ]);
    const toolClient = fakeToolClient((call) => {
      toolHits += 1;
      expect(call.toolName).toBe("list_datasets");
      expect(call.aohTraceId).toBe("tr-2");
      return { ok: true, result: { items: ["d1"] } };
    });
    const out = await runAgentLoop({
      initialPayload: { model: "m", messages: [{ role: "user", content: "go" }] },
      toolSpecs: [{ name: "list_datasets", parameters: { type: "object", properties: {} } }],
      upstream,
      toolClient,
      ctx: { userId: "alice", aohTraceId: "tr-2", maxIterations: 5 },
    });
    expect(toolHits).toBe(1);
    expect(out.iterations).toBe(2);
    expect(out.toolCallCount).toBe(1);
    expect(out.finalResponse.choices[0].message.content).toBe("done");
  });

  it("surfaces tool failure as a tool message error envelope", async () => {
    const upstream = fakeUpstream([
      assistantWithToolCall("query_dataset", { dataset_id: "x" }),
      (body: any) => {
        const last = body.messages[body.messages.length - 1];
        expect(last.role).toBe("tool");
        expect(last.content).toContain("ValueError");
        return assistantFinal("recovered");
      },
    ]);
    const out = await runAgentLoop({
      initialPayload: { model: "m", messages: [{ role: "user", content: "go" }] },
      toolSpecs: [{ name: "query_dataset", parameters: { type: "object" } }],
      upstream,
      toolClient: fakeToolClient(() => ({ ok: false, error_code: "ValueError", error_message: "no such dataset" })),
      ctx: { userId: "alice", aohTraceId: "tr-3", maxIterations: 5 },
    });
    expect(out.finalResponse.choices[0].message.content).toBe("recovered");
  });

  it("substitutes an error envelope when arguments fail to parse", async () => {
    const upstream = fakeUpstream([
      {
        id: "u",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              tool_calls: [{ id: "c", type: "function", function: { name: "list_datasets", arguments: "{not-json" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      (body: any) => {
        const last = body.messages[body.messages.length - 1];
        expect(last.content).toContain("InvalidToolArguments");
        return assistantFinal("ok");
      },
    ]);
    const toolClient = fakeToolClient(() => {
      throw new Error("must not be called on parse failure");
    });
    const out = await runAgentLoop({
      initialPayload: { model: "m", messages: [] },
      toolSpecs: [{ name: "list_datasets", parameters: {} }],
      upstream,
      toolClient,
      ctx: { userId: "alice", aohTraceId: "tr-4", maxIterations: 5 },
    });
    expect(out.finalResponse.choices[0].message.content).toBe("ok");
  });

  it("respects maxIterations", async () => {
    const upstream = fakeUpstream([assistantWithToolCall("list_datasets", {})]);
    const out = await runAgentLoop({
      initialPayload: { model: "m", messages: [] },
      toolSpecs: [{ name: "list_datasets", parameters: {} }],
      upstream,
      toolClient: fakeToolClient(() => ({ ok: true, result: {} })),
      ctx: { userId: "alice", aohTraceId: "tr-5", maxIterations: 3 },
    });
    expect(out.iterations).toBe(3);
  });
});
