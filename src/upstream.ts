/**
 * OpenAI-compatible upstream wrapper.
 *
 * Thin async ``fetch`` shim sized for both the non-streaming and SSE
 * paths. Pi's ``streamSimple`` (from ``@earendil-works/pi-ai``) is a
 * possible drop-in here in a follow-up — keeping this isolated makes
 * the swap a one-file change.
 */
import { request } from "undici";

import type { Message, ToolMessage } from "./openai-types.js";

export interface UpstreamRequest {
  model: string;
  messages: Message[];
  tools?: Array<{ type: "function"; function: Record<string, unknown> }>;
  tool_choice?: unknown;
  stream?: boolean;
  [k: string]: unknown;
}

export interface NonStreamResponse {
  id: string;
  choices: Array<{
    index: number;
    message: ToolMessage;
    finish_reason: string;
  }>;
  [k: string]: unknown;
}

export class UpstreamClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs: number,
    private readonly fetcher = request,
  ) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, "")}${path}`;
  }

  async chatCompletion(body: UpstreamRequest): Promise<NonStreamResponse> {
    const { statusCode, body: respBody } = await this.fetcher(this.url("/chat/completions"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...body, stream: false }),
      bodyTimeout: this.timeoutMs,
      headersTimeout: this.timeoutMs,
    });
    const text = await respBody.text();
    if (statusCode !== 200) {
      throw new Error(`upstream ${statusCode}: ${text.slice(0, 400)}`);
    }
    return JSON.parse(text) as NonStreamResponse;
  }

  async streamChatCompletion(body: UpstreamRequest): Promise<AsyncIterable<string>> {
    const { statusCode, body: respBody } = await this.fetcher(this.url("/chat/completions"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ ...body, stream: true }),
      bodyTimeout: this.timeoutMs,
      headersTimeout: this.timeoutMs,
    });
    if (statusCode !== 200) {
      const errText = await respBody.text();
      throw new Error(`upstream ${statusCode}: ${errText.slice(0, 400)}`);
    }
    return iterateSseLines(respBody);
  }
}

async function* iterateSseLines(body: AsyncIterable<Buffer>): AsyncIterable<string> {
  let buffered = "";
  for await (const chunk of body) {
    buffered += chunk.toString("utf8");
    let idx: number;
    while ((idx = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, idx).replace(/\r$/, "");
      buffered = buffered.slice(idx + 1);
      if (line.length > 0) yield line;
    }
  }
  if (buffered.length > 0) yield buffered;
}
