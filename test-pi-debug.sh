#!/bin/bash
set -e
TMP=$(mktemp -d)
PIAGENT=$TMP/pi-agent
mkdir -p $PIAGENT $TMP/cwd

cat > $PIAGENT/models.json <<'MJ'
{
  "providers": {
    "aoh-hub": {
      "baseUrl": "http://127.0.0.1:43180/v1",
      "api": "openai-completions",
      "apiKey": "fake-key",
      "compat": {"supportsDeveloperRole": false, "supportsReasoningEffort": false},
      "models": [{"id": "MiniMax-M2"}]
    }
  }
}
MJ

export PI_CODING_AGENT_DIR=$PIAGENT
export AOH_USER_ID=debug AOH_CHAT_ID=debug AOH_TRACE_ID=debug
export AOH_OWUI_BASE_URL=http://127.0.0.1:8080
export AOH_PI_SHARED_SECRET=e2e-secret

cd $TMP/cwd
(echo '{"id":"1","type":"get_state"}'; sleep 2) | timeout 10 node /Users/istale/Documents/pi-agent-obervation/repos/pi/packages/coding-agent/dist/cli.js \
  --mode rpc --no-builtin-tools --no-session \
  --extension /Users/istale/Documents/pi-agent-obervation/repos/pi-owui-bridge/extension/dist/owui-tools.js \
  --provider aoh-hub --model MiniMax-M2 2>&1 | head -30
