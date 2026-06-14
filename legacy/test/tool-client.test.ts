import { describe, expect, it } from "vitest";

import { ToolClient } from "../src/tool-client.js";

function makeFetcher(handler: (url: string, opts: any) => { statusCode: number; body: any }) {
  return async (url: string, opts: any) => {
    const r = handler(url, opts);
    return {
      statusCode: r.statusCode,
      body: {
        text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)),
        json: async () => (typeof r.body === "string" ? JSON.parse(r.body) : r.body),
      },
    } as any;
  };
}

describe("ToolClient.listToolSpecs", () => {
  it("returns the tools array on 200", async () => {
    const fetcher = makeFetcher((url, opts) => {
      expect(url).toContain("/tool-specs");
      expect(opts.headers["X-Pi-Service-Token"]).toBe("shh");
      return { statusCode: 200, body: { schema_version: 1, tool_spec_version: "v1", tools: [{ name: "a" }, { name: "b" }] } };
    });
    const cli = new ToolClient("http://owui.test", "shh", fetcher);
    const specs = await cli.listToolSpecs();
    expect(specs).toHaveLength(2);
  });

  it("throws on non-200", async () => {
    const fetcher = makeFetcher(() => ({ statusCode: 503, body: "not configured" }));
    const cli = new ToolClient("http://owui.test", "shh", fetcher);
    await expect(cli.listToolSpecs()).rejects.toThrow(/503/);
  });
});

describe("ToolClient.execute", () => {
  it("passes headers and serialises args", async () => {
    let seenHeaders: Record<string, string> = {};
    let seenBody = "";
    const fetcher = makeFetcher((_url, opts) => {
      seenHeaders = opts.headers;
      seenBody = opts.body;
      return { statusCode: 200, body: { ok: true, result: { x: 1 } } };
    });
    const cli = new ToolClient("http://owui.test", "shh", fetcher);
    const out = await cli.execute({
      toolName: "query_dataset",
      args: { dataset_id: "d", query: "SELECT 1" },
      userId: "alice",
      chatId: "c1",
      messageId: "m1",
      aohTraceId: "trace-1",
    });
    expect(seenHeaders["X-User-Id"]).toBe("alice");
    expect(seenHeaders["X-Chat-Id"]).toBe("c1");
    expect(seenHeaders["X-Aoh-Trace-Id"]).toBe("trace-1");
    expect(JSON.parse(seenBody)).toEqual({ args: { dataset_id: "d", query: "SELECT 1" } });
    expect(out).toEqual({ ok: true, result: { x: 1 } });
  });

  it("maps 4xx into ok:false structured error", async () => {
    const fetcher = makeFetcher(() => ({ statusCode: 401, body: { detail: "no token" } }));
    const cli = new ToolClient("http://owui.test", "shh", fetcher);
    const out = await cli.execute({ toolName: "list_datasets", args: {}, userId: "alice" });
    expect(out.ok).toBe(false);
    expect(out.error_code).toBe("HTTP401");
    expect(out.error_message).toBe("no token");
  });

  it("returns structured error on transport failure", async () => {
    const fetcher = async () => {
      throw new Error("conn refused");
    };
    const cli = new ToolClient("http://owui.test", "shh", fetcher as any);
    const out = await cli.execute({ toolName: "list_datasets", args: {}, userId: "alice" });
    expect(out.ok).toBe(false);
    expect(out.error_code).toBe("ToolTransportError");
  });

  it("omits optional headers when unset", async () => {
    let seen: Record<string, string> = {};
    const fetcher = makeFetcher((_url, opts) => {
      seen = opts.headers;
      return { statusCode: 200, body: { ok: true } };
    });
    const cli = new ToolClient("http://owui.test", "shh", fetcher);
    await cli.execute({ toolName: "list_datasets", args: {}, userId: "alice" });
    expect(seen["X-Chat-Id"]).toBeUndefined();
    expect(seen["X-Aoh-Trace-Id"]).toBeUndefined();
  });
});
