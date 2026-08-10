import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const CODEX_BIN = process.env.CODEX_AGENT_PATH || "codex";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const STATE_DIR = path.join(os.homedir(), ".claude", "mcp-servers", "codex-bridge");
const SESSIONS_FILE = path.join(STATE_DIR, "sessions.json");

async function loadSessions() {
  try {
    return JSON.parse(await readFile(SESSIONS_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function saveSessions(sessions) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

function normWorkspace(workspace) {
  return path.resolve(workspace);
}

function runCodex(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      CODEX_BIN,
      args,
      { timeout: timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: 20 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && !stdout) {
          reject(new Error(stderr || error.message));
          return;
        }
        resolve(stdout || stderr);
      }
    );
    // codex exec falls back to reading stdin if it's left open; close it
    // immediately since prompts are always passed as CLI arguments here.
    child.stdin.end();
  });
}

function extractThreadId(output) {
  for (const line of output.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const evt = JSON.parse(line);
      if (evt.type === "thread.started" && evt.thread_id) return evt.thread_id;
    } catch {
      // ignore non-JSON lines (codex also prints plain-text status lines)
    }
  }
  return null;
}

const server = new Server(
  { name: "codex-bridge", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "codex_delegate",
      description:
        "Delegate a coding task to the local OpenAI Codex CLI (codex) running on this machine, " +
        "in the context of one specific project folder. Each workspace path has its own persistent " +
        "codex thread that is automatically resumed across calls, so codex remembers prior turns " +
        "for that project even if other projects/chats were worked on in between. codex will " +
        "read/edit files in the workspace directory. By default it runs in a sandboxed " +
        "'workspace-write' mode: it CAN run local shell commands and edit files, but only inside " +
        "the workspace directory and with no network access. Full unrestricted shell (network, " +
        "SSH, files outside the workspace) is OFF by default. If that's needed, you MUST first ask " +
        "the user for explicit permission in the current conversation, explain that Codex will be " +
        "able to run commands without further approval and reach the network, and wait for the " +
        "user's answer. Only after the user explicitly approves may you set both allow_shell and " +
        "shell_permission_confirmed to true. Permission is per call: never infer it from an earlier " +
        "task or enable it proactively. Always pass the absolute path of the relevant project " +
        "directory as 'workspace'.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "The task/instructions for codex to carry out.",
          },
          workspace: {
            type: "string",
            description:
              "Absolute path to the project directory this task belongs to. Used both as codex's " +
              "working directory and as the key for which ongoing thread to resume.",
          },
          new_session: {
            type: "boolean",
            description:
              "Set true to abandon any existing thread for this workspace and start a fresh one.",
          },
          allow_shell: {
            type: "boolean",
            default: false,
            description:
              "Opt in to unrestricted local shell, SSH, and network access (codex 'danger-full-access' " +
              "sandbox) for THIS CALL only. Before setting true, the agent must explain the risk and " +
              "receive explicit user permission. Requires shell_permission_confirmed=true.",
          },
          shell_permission_confirmed: {
            type: "boolean",
            default: false,
            description:
              "Set true only after the user explicitly approved unrestricted Codex shell access for " +
              "this call in the current conversation. This is not persistent permission.",
          },
          timeout_ms: {
            type: "number",
            description:
              `Override the default ${DEFAULT_TIMEOUT_MS / 60000}-minute timeout for this call, in ` +
              `milliseconds, up to a hard cap of ${MAX_TIMEOUT_MS / 60000} minutes.`,
          },
          model: {
            type: "string",
            description:
              "Which model codex should use for this call (e.g. 'gpt-5.6-sol', 'o3', 'gpt-5-mini'). " +
              "Omit to use the model configured in ~/.codex/config.toml.",
          },
        },
        required: ["prompt", "workspace"],
      },
    },
    {
      name: "codex_sessions",
      description:
        "List all project workspaces that currently have an active/remembered codex thread, with " +
        "when they were last used. Useful for checking what's in flight across your projects.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "codex_sessions") {
    const sessions = await loadSessions();
    const lines = Object.entries(sessions).map(
      ([ws, s]) => `${ws} — thread ${s.threadId} — last used ${s.lastUsed}`
    );
    return {
      content: [
        {
          type: "text",
          text: lines.length ? lines.join("\n") : "No active sessions yet.",
        },
      ],
    };
  }

  if (name === "codex_delegate") {
    const {
      prompt,
      workspace,
      new_session,
      allow_shell = false,
      shell_permission_confirmed = false,
      timeout_ms,
      model,
    } = args ?? {};
    if (!prompt || !workspace) {
      throw new Error("Both 'prompt' and 'workspace' are required.");
    }
    if (allow_shell && shell_permission_confirmed !== true) {
      throw new Error(
        "Shell access was requested without confirmed user permission. Ask the user for explicit " +
        "permission, wait for approval, then retry with both allow_shell=true and " +
        "shell_permission_confirmed=true."
      );
    }
    const timeoutMs =
      typeof timeout_ms === "number" && timeout_ms > 0
        ? Math.min(timeout_ms, MAX_TIMEOUT_MS)
        : DEFAULT_TIMEOUT_MS;

    const key = normWorkspace(workspace);
    const sessions = await loadSessions();
    const existing = new_session ? null : sessions[key];

    const outFile = path.join(
      os.tmpdir(),
      `codex-bridge-${process.pid}-${Date.now()}.txt`
    );

    const sandboxArgs = allow_shell
      ? ["-s", "danger-full-access", "--dangerously-bypass-approvals-and-sandbox"]
      : ["-s", "workspace-write", "-c", "sandbox_workspace_write.network_access=false"];

    const modelArgs = model ? ["-m", model] : [];

    let cliArgs;
    if (existing?.threadId) {
      cliArgs = [
        "exec",
        "--json",
        "--skip-git-repo-check",
        ...sandboxArgs,
        ...modelArgs,
        "-o",
        outFile,
        "resume",
        existing.threadId,
        prompt,
      ];
    } else {
      cliArgs = [
        "exec",
        "--json",
        "--skip-git-repo-check",
        ...sandboxArgs,
        ...modelArgs,
        "-C",
        key,
        "-o",
        outFile,
        prompt,
      ];
    }

    const output = await runCodex(cliArgs, timeoutMs);
    const threadId = extractThreadId(output);

    if (threadId) {
      sessions[key] = { threadId, lastUsed: new Date().toISOString() };
      await saveSessions(sessions);
    }

    let text;
    try {
      text = await readFile(outFile, "utf8");
    } catch {
      text = output;
    } finally {
      unlink(outFile).catch(() => {});
    }

    return { content: [{ type: "text", text }] };
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
