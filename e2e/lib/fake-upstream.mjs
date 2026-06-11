/**
 * Fake upstream LLM scripted with stable responses.
 *
 * Mounts on an ephemeral port and returns canned chat completions in a
 * specific order so scenarios are deterministic. Scenarios pre-load the
 * script through the ``/_script`` admin endpoint.
 */
import { createServer } from "node:http";

export async function startFakeUpstream() {
  let script = [];
  let cursor = 0;
  const received = [];

  const srv = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/_script") {
      const body = await readJson(req);
      script = Array.isArray(body) ? body : [];
      cursor = 0;
      received.length = 0;
      res.writeHead(200).end();
      return;
    }
    if (req.method === "GET" && req.url === "/_received") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(received));
      return;
    }
    if (req.method === "POST" && req.url === "/chat/completions") {
      const body = await readJson(req);
      received.push(body);
      const item = cursor < script.length ? script[cursor] : script[script.length - 1];
      cursor += 1;
      // Pi's streamSimple always sends ``stream: true``; respond in SSE
      // form for those calls. The legacy self loop sets stream: false and
      // gets a single JSON body. Detect from the request body itself.
      if (body?.stream === true) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        for (const chunk of toSseChunks(item)) {
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(item));
      return;
    }
    res.writeHead(404).end();
  });

  const port = await new Promise((r) => {
    srv.listen(0, "127.0.0.1", () => r(srv.address().port));
  });
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => srv.close(r)),
  };
}

/**
 * Convert a non-streaming OpenAI chat completion into a series of
 * streaming chunks. The Pi runtime aggregates these into one final
 * AssistantMessage, so we don't need fine-grained deltas — one chunk
 * carrying the whole content plus a [DONE] is enough.
 */
function toSseChunks(item) {
  const choice = item?.choices?.[0];
  const msg = choice?.message ?? {};
  const out = [];
  if (msg.content) {
    out.push({
      id: item.id ?? "u",
      choices: [{ index: 0, delta: { role: "assistant", content: msg.content } }],
    });
  }
  if (Array.isArray(msg.tool_calls)) {
    for (let i = 0; i < msg.tool_calls.length; i += 1) {
      const tc = msg.tool_calls[i];
      out.push({
        id: item.id ?? "u",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: i,
                  id: tc.id,
                  type: tc.type ?? "function",
                  function: { name: tc.function?.name ?? "", arguments: tc.function?.arguments ?? "" },
                },
              ],
            },
          },
        ],
      });
    }
  }
  const finish = choice?.finish_reason ?? "stop";
  out.push({ id: item.id ?? "u", choices: [{ index: 0, delta: {}, finish_reason: finish }] });
  return out;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}
