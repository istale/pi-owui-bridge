/**
 * Live smoke: spin up two fake servers (OWUI + upstream), start the
 * bridge, exercise /healthz and /v1/chat/completions, then exit.
 * Run with: node test/live-smoke.mjs
 */
import http from "node:http";
import { createApp } from "../dist/server.js";
import { ToolClient } from "../dist/tool-client.js";
import { UpstreamClient } from "../dist/upstream.js";
import { ObservationEmitter } from "../dist/observation.js";

const OWUI_PORT = 18801;
const UPSTREAM_PORT = 18802;
const BRIDGE_PORT = 19001;

function startServer(port, handler, label) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(port, "127.0.0.1", () => {
      console.log(`${label} listening on :${port}`);
      resolve(srv);
    });
  });
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

const upstreamSeen = [];
let step = 0;

const owuiServer = await startServer(
  OWUI_PORT,
  async (req, res) => {
    if (req.url === "/api/v1/data-analysis/tool-specs") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          schema_version: 1,
          tool_spec_version: "smoke-v1",
          tools: [
            { name: "list_datasets", description: "list", parameters: { type: "object", properties: {} } },
          ],
        }),
      );
      return;
    }
    if (req.url?.startsWith("/api/v1/data-analysis/tools/list_datasets")) {
      const body = await readJson(req);
      console.log("  OWUI tool hit:", body);
      console.log("  with X-Aoh-Trace-Id:", req.headers["x-aoh-trace-id"]);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: { items: ["dataset-a", "dataset-b"] } }));
      return;
    }
    res.writeHead(404).end();
  },
  "fake OWUI",
);

const upstreamServer = await startServer(
  UPSTREAM_PORT,
  async (req, res) => {
    if (req.url === "/chat/completions") {
      const body = await readJson(req);
      upstreamSeen.push(body);
      step += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      if (step === 1) {
        res.end(
          JSON.stringify({
            id: "u1",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  tool_calls: [
                    { id: "c1", type: "function", function: { name: "list_datasets", arguments: "{}" } },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          }),
        );
      } else {
        res.end(
          JSON.stringify({
            id: "u2",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "Here are your datasets: dataset-a, dataset-b." },
                finish_reason: "stop",
              },
            ],
          }),
        );
      }
      return;
    }
    res.writeHead(404).end();
  },
  "fake upstream",
);

// Build bridge with explicit clients pointed at the fakes (skip env loading)
const toolClient = new ToolClient(`http://127.0.0.1:${OWUI_PORT}`, "smoke-secret");
const upstream = new UpstreamClient(`http://127.0.0.1:${UPSTREAM_PORT}`, "k", 30000);
const emitter = new ObservationEmitter(null);

// createApp() reads getConfig() — set env so it doesn't throw
process.env.AOH_UPSTREAM_BASE_URL = `http://127.0.0.1:${UPSTREAM_PORT}`;
process.env.AOH_UPSTREAM_API_KEY = "k";
process.env.AOH_OWUI_BASE_URL = `http://127.0.0.1:${OWUI_PORT}`;
process.env.AOH_PI_SHARED_SECRET = "smoke-secret";

const app = await createApp({ toolClient, upstream, emitter, toolSpecs: undefined });
const bridgeServer = app.listen(BRIDGE_PORT, "127.0.0.1");
await new Promise((r) => bridgeServer.on("listening", r));
console.log(`bridge listening on :${BRIDGE_PORT}`);

// 1. /healthz
{
  const r = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/healthz`);
  const j = await r.json();
  console.log("/healthz:", j);
  if (j.tool_count !== 1) throw new Error(`expected tool_count=1, got ${j.tool_count}`);
}

// 2. /v1/chat/completions
{
  const r = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-User-Id": "alice", "X-Chat-Id": "smoke-chat" },
    body: JSON.stringify({ model: "x", messages: [{ role: "user", content: "list my datasets" }] }),
  });
  const j = await r.json();
  console.log("\nadapter response:");
  console.log("  status:", r.status);
  console.log("  final:", j.choices?.[0]?.message?.content);
  console.log("  pi_adapter:", j.pi_adapter);
  if (r.status !== 200) throw new Error("non-200 response");
  if (j.pi_adapter?.iterations !== 2) throw new Error(`expected 2 iterations, got ${j.pi_adapter?.iterations}`);
  if (j.pi_adapter?.tool_call_count !== 1) throw new Error(`expected 1 tool call`);
  if (!j.choices?.[0]?.message?.content?.includes("dataset")) throw new Error("missing dataset mention");
}

// 3. Second upstream call should have the tool message threaded
const secondMessages = upstreamSeen[1].messages;
console.log("\nsecond upstream call roles:", secondMessages.map((m) => m.role));
if (!secondMessages.some((m) => m.role === "tool")) throw new Error("expected tool message in second call");

bridgeServer.close();
owuiServer.close();
upstreamServer.close();
console.log("\nSTAGE 8 LIVE SMOKE: PASS");
