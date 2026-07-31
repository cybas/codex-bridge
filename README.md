# Codex MCP bridge

This bridge delegates project-scoped coding work to the local OpenAI Codex CLI
(`codex`, bundled inside ChatGPT.app). It's the Codex-side counterpart to
`claude-code-bridge` — together they let Claude Code and Codex hand tasks back
and forth, each resuming its own persistent thread/session per workspace.

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
