#!/bin/bash
# LaunchAgent entrypoint for the S8 market Codex relay agent.
set -euo pipefail
export PATH="/Users/vr/.local/bin:/opt/homebrew/bin:/opt/homebrew/opt/node@20/bin:/usr/bin:/bin"
ENV_FILE="/Users/vr/.claude/mcp-servers/codex-bridge/relay-agent.local.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "missing $ENV_FILE" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
: "${CODEX_RELAY_URL:?}"
: "${CODEX_RELAY_AGENT_TOKEN:?}"
export CODEX_RELAY_CONVERSATION_ID="${CODEX_RELAY_CONVERSATION_ID:-s8-market}"
export CODEX_RELAY_DEFAULT_WORKSPACE="${CODEX_RELAY_DEFAULT_WORKSPACE:-/Users/vr/trader-a2}"
export CODEX_RELAY_WORKSPACES="${CODEX_RELAY_WORKSPACES:-/Users/vr/trader-a2,/Users/vr/symbol_intake,/Users/vr/ta2-dhan-candle,/Users/vr/openalgo}"
export CODEX_RELAY_MARKET_TIMEOUT_MS="${CODEX_RELAY_MARKET_TIMEOUT_MS:-20000}"
export CODEX_RELAY_POLL_MS="${CODEX_RELAY_POLL_MS:-500}"
export CODEX_AGENT_PATH="${CODEX_AGENT_PATH:-/Users/vr/.local/bin/codex}"
cd /Users/vr/.claude/mcp-servers/codex-bridge
exec /opt/homebrew/bin/node relay-agent.js
