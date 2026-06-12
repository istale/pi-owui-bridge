/**
 * Stage 12 live smoke: spawn the bridge against a real OWUI tool service
 * (port 8080) and a fake upstream that returns one tool-use turn then a
 * final-text turn. Pi runs as subprocess; the bridge translates.
 */
import http from "node:http";
import { spawn } from "node:child_process";

const OWUI = "http://127.0.0.1:8080";
const UPSTREAM_PORT = 18803;
const BRIDGE_PORT = 19001;

function startServer(port, handler, label) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(port, "127.0.0.1", () => {
      console.log(`${label} on :${port}`);
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

function sseChunks(events) {
  let s = "";
  for (const ev of events) s += `data: ${JSON.stringify(ev)}\n\n`;
  s += "data: [DONE]\n\n";
  return s;
}

let upstreamStep = 0;

const upstream = await startServer(
  UPSTREAM_PORT,
  async (req, res) => {
    if (req.url === "/chat/completions") {
      const body = await readJson(req);
      console.log(`  upstream call #${upstreamStep + 1} stream=${body.stream} msgs=${body.messages?.length}`);
      upstreamStep += 1;
      const chunks = upstreamStep === 1
        ? [
            { id: "u1", choices: [{ index: 0, delta: { role: "assistant" } }] },
            { id: "u1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "list_datasets", arguments: "" } }] } }] },
            { id: "u1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] } }] },
            { id: "u1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
          ]
        : [
            { id: "u2", choices: [{ index: 0, delta: { role: "assistant", content: "Here are your datasets." } }] },
            { id: "u2", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          ];
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(sseChunks(chunks));
      return;
    }
    res.writeHead(404).end();
  },
  "fake upstream",
);

// Start the bridge as subprocess so it gets the env we set.
const env = {
  ...process.env,
  AOH_UPSTREAM_BASE_URL: `http://127.0.0.1:${UPSTREAM_PORT}`,
  AOH_UPSTREAM_API_KEY: "fake-key",
  AOH_UPSTREAM_MODEL: "MiniMax-M2",
  AOH_OWUI_BASE_URL: OWUI,
  AOH_PI_SHARED_SECRET: "e2e-secret",
  AOH_OBSERVATION_DIR: "/Users/istale/.pi/observation",
  AOH_SKILLS_DIR: "/tmp/aoh-e2e-shared/skills",
  AOH_PI_CLI_PATH: "/Users/istale/Documents/pi-agent-obervation/repos/pi/packages/coding-agent/dist/cli.js",
  AOH_PI_EXTENSION_PATH: "/Users/istale/Documents/pi-agent-obervation/repos/pi-owui-bridge/extension/dist/owui-tools.js",
  AOH_BRIDGE_PORT: String(BRIDGE_PORT),
};

const bridge = spawn("node", ["dist/server.js"], { env, stdio: ["ignore", "inherit", "inherit"] });

// Wait for bridge to come up.
for (let i = 0; i < 60; i += 1) {
  try {
    const r = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/healthz`);
    if (r.status === 200) break;
  } catch {
    /* not yet */
  }
  await new Promise((r) => setTimeout(r, 250));
}

const h = await (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/healthz`)).json();
console.log("healthz:", h);

console.log("\nsending chat...");
const resp = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/v1/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-User-Id": "smoke-user", "X-Chat-Id": "smoke-chat" },
  body: JSON.stringify({ model: "MiniMax-M2", messages: [{ role: "user", content: "list my datasets" }] }),
});
const body = await resp.json();
console.log("\nresponse status:", resp.status);
console.log("body:", JSON.stringify(body, null, 2));

bridge.kill();
upstream.close();
console.log("\nbridge upstream_calls_seen:", upstreamStep);
process.exit(body?.choices?.[0]?.message?.content ? 0 : 1);
