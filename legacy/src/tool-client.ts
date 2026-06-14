/**
 * HTTP client for the Open WebUI data-analysis tool service.
 *
 * Exposes two operations the bridge needs at runtime: discover the
 * function specs at startup, and dispatch one tool call per LLM
 * tool_use round. Kept narrow so it can be mocked at the fetch layer
 * in tests.
 */
import { request } from "undici";

export interface ToolSpec {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ToolSpecsResponse {
  tool_spec_version: string;
  tools: ToolSpec[];
}

export interface ToolDispatchResult {
  ok: boolean;
  result?: unknown;
  error_code?: string;
  error_message?: string;
}

export class ToolClient {
  constructor(
    private readonly baseUrl: string,
    private readonly sharedSecret: string,
    private readonly fetcher = request,
  ) {}

  async listToolSpecs(): Promise<ToolSpec[]> {
    const { statusCode, body } = await this.fetcher(
      `${this.baseUrl.replace(/\/$/, "")}/api/v1/data-analysis/tool-specs`,
      {
        method: "GET",
        headers: { "X-Pi-Service-Token": this.sharedSecret, "X-User-Id": "discovery" },
      },
    );
    if (statusCode !== 200) {
      const text = await body.text();
      throw new Error(`tool-specs ${statusCode}: ${text.slice(0, 200)}`);
    }
    const data = (await body.json()) as ToolSpecsResponse;
    return Array.isArray(data.tools) ? data.tools : [];
  }

  async execute(opts: {
    toolName: string;
    args: Record<string, unknown>;
    userId: string;
    chatId?: string;
    messageId?: string;
    aohTraceId?: string;
  }): Promise<ToolDispatchResult> {
    const headers: Record<string, string> = {
      "X-Pi-Service-Token": this.sharedSecret,
      "X-User-Id": opts.userId,
      "Content-Type": "application/json",
    };
    if (opts.chatId) headers["X-Chat-Id"] = opts.chatId;
    if (opts.messageId) headers["X-Message-Id"] = opts.messageId;
    if (opts.aohTraceId) headers["X-Aoh-Trace-Id"] = opts.aohTraceId;

    try {
      const { statusCode, body } = await this.fetcher(
        `${this.baseUrl.replace(/\/$/, "")}/api/v1/data-analysis/tools/${encodeURIComponent(opts.toolName)}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ args: opts.args }),
        },
      );
      const text = await body.text();
      if (statusCode >= 400) {
        let detail = text;
        try {
          detail = JSON.parse(text).detail ?? text;
        } catch {
          /* keep raw */
        }
        return { ok: false, error_code: `HTTP${statusCode}`, error_message: String(detail).slice(0, 800) };
      }
      const parsed = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null) {
        return { ok: false, error_code: "ToolResponseShape", error_message: "non-object response" };
      }
      return parsed as ToolDispatchResult;
    } catch (err) {
      return {
        ok: false,
        error_code: "ToolTransportError",
        error_message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
