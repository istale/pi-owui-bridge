/**
 * Thin HTTP clients used by every scenario.
 *
 * Kept ESM-only and dependency-free (uses global ``fetch``) so the
 * runner is a single ``node e2e/run.mjs`` invocation with no install.
 */

function url(base, path) {
  return `${base.replace(/\/$/, "")}${path}`;
}

export class BridgeClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
  }
  async healthz() {
    const r = await fetch(url(this.baseUrl, "/healthz"));
    return { status: r.status, body: await r.json() };
  }
  async chat({ userId, chatId, messageId, model, messages, stream = false }) {
    const r = await fetch(url(this.baseUrl, "/v1/chat/completions"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-User-Id": userId,
        ...(chatId ? { "X-Chat-Id": chatId } : {}),
        ...(messageId ? { "X-Message-Id": messageId } : {}),
      },
      body: JSON.stringify({ model, messages, stream }),
    });
    const text = await r.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: r.status, body };
  }
  async refreshToolSpecs() {
    const r = await fetch(url(this.baseUrl, "/v1/tool-specs/refresh"), { method: "POST" });
    return { status: r.status, body: await r.json() };
  }
}

export class HubClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
  }
  async healthz() {
    const r = await fetch(url(this.baseUrl, "/healthz"));
    return { status: r.status, body: await r.json().catch(() => null) };
  }
  async setChatMark(userId, chatId, idx, mark) {
    const r = await fetch(url(this.baseUrl, `/api/chats/${userId}/${chatId}/messages/${idx}/mark`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mark }),
    });
    return { status: r.status, body: await r.json() };
  }
  async getChatOverlay(userId, chatId) {
    const r = await fetch(url(this.baseUrl, `/api/chats/${userId}/${chatId}/overlay`));
    return { status: r.status, body: await r.json() };
  }
  async payloadInspect(traceId) {
    const r = await fetch(url(this.baseUrl, `/api/assertions/payload-inspect/${traceId}`));
    return { status: r.status, body: await r.json() };
  }
}

export class OwuiClient {
  constructor(baseUrl, sharedSecret) {
    this.baseUrl = baseUrl;
    this.sharedSecret = sharedSecret;
  }
  async healthz() {
    const r = await fetch(url(this.baseUrl, "/health"));
    return { status: r.status, body: await r.json().catch(() => null) };
  }
  async toolSpecs() {
    const r = await fetch(url(this.baseUrl, "/api/v1/data-analysis/tool-specs"), {
      headers: { "X-Pi-Service-Token": this.sharedSecret, "X-User-Id": "e2e" },
    });
    return { status: r.status, body: await r.json() };
  }
  async eventsByTrace(traceId) {
    const r = await fetch(url(this.baseUrl, `/api/v1/data-analysis/events/by-trace/${traceId}`), {
      headers: { "X-Pi-Service-Token": this.sharedSecret, "X-User-Id": "e2e" },
    });
    return { status: r.status, body: await r.json() };
  }
}
