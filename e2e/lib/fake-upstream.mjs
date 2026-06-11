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
