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

Each call defaults to a 10-minute timeout. Any calling AI can raise this per
call via the `timeout_ms` parameter, up to a hard cap of 60 minutes.

Clients that already loaded the MCP server must restart or reconnect it to
see schema or implementation changes.
