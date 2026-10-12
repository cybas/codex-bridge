#!/bin/bash
# LaunchAgent entrypoint: Tailscale-bound Codex market relay (no Cloudflare).
set -euo pipefail
export PATH="/Users/vr/.local/bin:/usr/bin:/bin:/opt/homebrew/bin"
ENV_FILE="/Users/vr/.claude/mcp-servers/codex-bridge/relay-agent.local.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "missing $ENV_FILE" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
: "${CODEX_RELAY_MARKET_TOKEN:?}"
export CODEX_MARKET_RELAY_BIND="${CODEX_MARKET_RELAY_BIND:-100.113.193.82}"
export CODEX_MARKET_RELAY_PORT="${CODEX_MARKET_RELAY_PORT:-8788}"
export CODEX_RELAY_CONVERSATION_ID="${CODEX_RELAY_CONVERSATION_ID:-s8-market}"
export CODEX_RELAY_DEFAULT_WORKSPACE="${CODEX_RELAY_DEFAULT_WORKSPACE:-/Users/vr/trader-a2}"
export CODEX_RELAY_WORKSPACES="${CODEX_RELAY_WORKSPACES:-/Users/vr/trader-a2,/Users/vr/symbol_intake,/Users/vr/ta2-dhan-candle,/Users/vr/openalgo}"
export CODEX_RELAY_MARKET_TIMEOUT_MS="${CODEX_RELAY_MARKET_TIMEOUT_MS:-25000}"
export CODEX_RELAY_MARKET_MODEL="${CODEX_RELAY_MARKET_MODEL:-gpt-5.5}"
export CODEX_AGENT_PATH="${CODEX_AGENT_PATH:-/Users/vr/.local/bin/codex}"
cd /Users/vr/.claude/mcp-servers/codex-bridge
exec /usr/bin/python3 market_relay_server.py
