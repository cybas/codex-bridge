import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const relayUrl = process.env.CODEX_RELAY_URL;
const agentToken = process.env.CODEX_RELAY_AGENT_TOKEN;
const codexBin = process.env.CODEX_AGENT_PATH || "codex";
const allowed = new Set((process.env.CODEX_RELAY_WORKSPACES || "/Users/vr/trader-a2,/Users/vr/symbol_intake,/Users/vr/ta2-dhan-candle,/Users/vr/openalgo").split(",").map(x => x.trim()));
if (!relayUrl || !agentToken) throw new Error("Set CODEX_RELAY_URL and CODEX_RELAY_AGENT_TOKEN");

async function api(path, options = {}) {
  const response = await fetch(`${relayUrl.replace(/\/$/, "")}${path}`, { ...options, headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json", ...(options.headers || {}) } });
  const body = await response.json(); if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`); return body;
}

async function run(task) {
  if (!allowed.has(task.workspace)) throw new Error(`workspace rejected locally: ${task.workspace}`);
  const prompt = `You are the local Codex coordinator. This task came from the authenticated web relay.\n\nWORKER POLICY: delegate engineering work to the local Cursor MCP bridge when appropriate. Do not use the online VRe bridge. Do not enable shell/network/SSH unless separately approved by the user. Return a concise worker report with STATUS, Scope, Actions performed, Verification, Known issues, and Exact blocker.\n\nTASK:\n${task.prompt}`;
  const args = ["exec", "--json", "--skip-git-repo-check", "-s", "workspace-write", "-c", "sandbox_workspace_write.network_access=false", "-C", task.workspace, prompt];
  try { const { stdout, stderr } = await exec(codexBin, args, { timeout: 60 * 60 * 1000, maxBuffer: 20 * 1024 * 1024 }); return { state: "completed", output: stdout || stderr || "Codex returned no output" }; }
  catch (e) { return { state: "failed", output: e.stdout || e.stderr || e.message }; }
}

async function runConversation(message) {
  if (!allowed.has(process.env.CODEX_RELAY_DEFAULT_WORKSPACE)) throw new Error("Set CODEX_RELAY_DEFAULT_WORKSPACE to an explicitly allowed workspace");
  const workspace = process.env.CODEX_RELAY_DEFAULT_WORKSPACE;
  const prompt = `You are the local Codex coordinator answering a message from a ChatGPT web conversation. Use the local Cursor MCP for engineering work when needed. Do not use the online VRe bridge. Reply directly and clearly; if blocked, state the exact blocker.\n\nMESSAGE ID: ${message.message_id}\nCONVERSATION: ${message.conversation_id}\n\nMESSAGE:\n${message.text}`;
  const args = ["exec", "--json", "--skip-git-repo-check", "-s", "workspace-write", "-c", "sandbox_workspace_write.network_access=false", "-C", workspace, prompt];
  try { const { stdout, stderr } = await exec(codexBin, args, { timeout: 60 * 60 * 1000, maxBuffer: 20 * 1024 * 1024 }); return { state: "completed", text: stdout || stderr || "Codex returned no reply" }; }
  catch (e) { return { state: "failed", text: e.stdout || e.stderr || e.message }; }
}

const waitMs = Number(process.env.CODEX_RELAY_POLL_MS || 5000);
const once = process.argv.includes("--once");
let cursor = Number(process.env.CODEX_RELAY_MESSAGE_CURSOR || 0);
while (true) {
  if (process.env.CODEX_RELAY_CONVERSATION_ID) {
    const inbox = await api(`/v1/inbox?conversation_id=${encodeURIComponent(process.env.CODEX_RELAY_CONVERSATION_ID)}&after=${cursor}`, { method: "GET" });
    for (const message of inbox.messages || []) {
      if (message.direction !== "web_to_codex") { cursor = Math.max(cursor, message.sequence); continue; }
      const result = await runConversation(message);
      await api(`/v1/conversations/${encodeURIComponent(message.conversation_id)}/replies`, { method: "POST", body: JSON.stringify({ text: result.text, reply_to: message.message_id }) });
      await api("/v1/messages/ack", { method: "POST", body: JSON.stringify({ conversation_id: message.conversation_id, message_id: message.message_id }) });
      cursor = Math.max(cursor, message.sequence);
      if (once) break;
    }
    if (once) break;
  }
  const next = await api("/v1/tasks/next", { method: "GET", headers: { "x-agent": process.env.CODEX_RELAY_AGENT_ID || "local-codex" } });
  if (next.task) { const result = await run(next.task); await api(`/v1/tasks/${next.task.task_id}/result`, { method: "POST", body: JSON.stringify(result) }); if (once) break; }
  else { if (once) break; await new Promise(resolve => setTimeout(resolve, waitMs)); }
}
