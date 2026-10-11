# codex-bridge

An MCP server that lets Claude Code (or any MCP client) hand off coding tasks
to the local OpenAI Codex CLI (`codex`, bundled inside ChatGPT.app), running in
a specific project workspace. Each workspace gets its own persistent Codex
thread that automatically resumes across calls.

It's the Codex-side counterpart to [`cursor-agent-bridge`](https://github.com/cybas/cursor-agent-bridge)
— together they let Claude Code, Cursor, and Codex hand tasks back and forth,
each resuming its own persistent thread/session per workspace.

## Setup

```json
{
  "mcpServers": {
    "codex-bridge": {
      "command": "node",
      "args": ["/path/to/codex-bridge/index.js"]
    }
  }
}
```

Requires the `codex` CLI installed and on `PATH`.

## Tools

- **codex_delegate** — send a prompt + workspace path to Codex, resuming that
  workspace's thread if one exists.
- **codex_sessions** — list all workspaces with an active/remembered thread
  and when they were last used.

## Optional ChatGPT web task relay

`relay-worker/` is a separate, authenticated Cloudflare queue for submitting
tasks from ChatGPT web. `relay-agent.js` runs locally on the Mac, claims one
queued task, invokes the local Codex CLI, and posts the result back. Codex can
then use the existing local stdio Cursor MCP; the web relay never invokes
Cursor directly and cannot grant shell, SSH, network, commit, push, or deploy
capabilities.

Run the local agent only after configuring the Worker secrets and URL:

```sh
CODEX_RELAY_URL=https://your-worker.example \
CODEX_RELAY_AGENT_TOKEN='value-from-wrangler-secret' \
node relay-agent.js
```

For the first smoke test, use `node relay-agent.js --once` and submit a
read-only task. Keep `CODEX_RELAY_WORKSPACES` restricted to explicit absolute
paths; do not use `/Users/vr` as a broad execution allowlist.

## Market wake path

The relay also supports a narrow S8-to-Codex market channel. Configure a
separate Cloudflare Worker secret named `MARKET_TOKEN`. A market producer posts
to:

```text
POST /v1/conversations/<id>/market
```

using `Authorization: Bearer <MARKET_TOKEN>`. The local `relay-agent.js`
processes `market_to_codex` messages in a read-only Codex sandbox, keeps a
persistent Codex thread per market conversation, and returns
`codex_to_market` replies. The market token can read that conversation and ack
its replies but cannot claim tasks, post agent replies, or request privileged
shell/network/SSH capabilities.

Useful Mac settings:

```bash
CODEX_RELAY_CONVERSATION_ID=s8-market
CODEX_RELAY_DEFAULT_WORKSPACE=/Users/vr/trader-a2
CODEX_RELAY_MARKET_TIMEOUT_MS=20000
# Optional: CODEX_RELAY_MARKET_MODEL=<a Codex model available to your account>
```

The market path is intentionally reasoning-only. The producer supplies the
point-in-time market payload; Codex is instructed not to use tools, fetch
outside data, or edit files for those messages. While a Codex market turn is
busy, newer `market_to_codex` messages supersede older pending ones (worker
marks stale ticks coalesced; the Mac agent acks and skips them).

## How it works

## Sandbox and shell permission

File editing plus sandboxed local shell (no network, restricted to the
workspace directory) is the default mode, via Codex's `workspace-write`
sandbox. Full unrestricted shell/network/SSH access is disabled unless the
caller opts in for an individual tool call.

A calling Claude or GPT agent must:

1. Explain that enabling shell mode lets Codex run local and remote commands
   without further approval, with network access.
2. Ask the user for explicit permission in the current conversation and wait.
3. Set both `allow_shell: true` and `shell_permission_confirmed: true` only
   after approval.

Permission is per call and must not be inferred from an earlier task. When
enabled, the bridge runs Codex with `-s danger-full-access
--dangerously-bypass-approvals-and-sandbox`.

## Timeout

Each ordinary bridge call defaults to a 10-minute timeout. Any calling AI can
raise this per call via the `timeout_ms` parameter, up to a hard cap of 60
minutes. Market relay calls default to 20 seconds so an unavailable or slow
Codex turn fails closed before the next 1-minute market cycle.

Clients that already loaded the MCP server must restart or reconnect it to
see schema or implementation changes.
