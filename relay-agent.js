import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const exec = promisify(execFile);
const relayUrl = process.env.CODEX_RELAY_URL;
const agentToken = process.env.CODEX_RELAY_AGENT_TOKEN;
const codexBin = process.env.CODEX_AGENT_PATH || "codex";
const allowed = new Set((process.env.CODEX_RELAY_WORKSPACES || "/Users/vr/trader-a2,/Users/vr/symbol_intake,/Users/vr/ta2-dhan-candle,/Users/vr/openalgo").split(",").map(x => x.trim()));
const sessionDir = path.join(os.homedir(), ".claude", "mcp-servers", "codex-bridge");
const sessionFile = path.join(sessionDir, "relay-sessions.json");
if (!relayUrl || !agentToken) throw new Error("Set CODEX_RELAY_URL and CODEX_RELAY_AGENT_TOKEN");

async function api(pathname, options = {}) {
  const response = await fetch(`${relayUrl.replace(/\/$/, "")}${pathname}`, { ...options, headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json", ...(options.headers || {}) } });
  const body = await response.json(); if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`); return body;
}

async function loadSessions() {
  try { return JSON.parse(await readFile(sessionFile, "utf8")); }
  catch { return {}; }
}

async function saveSessions(sessions) {
  await mkdir(sessionDir, { recursive: true });
  await writeFile(sessionFile, JSON.stringify(sessions, null, 2));
}

function extractThreadId(output) {
  for (const line of String(output || "").split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "thread.started" && event.thread_id) return event.thread_id;
    } catch {}
  }
  return null;
}

async function runCodexPersistent({ prompt, workspace, sessionKey, sandboxArgs, timeoutMs, model }) {
  const sessions = await loadSessions();
  const existing = sessions[sessionKey];
  const outFile = path.join(os.tmpdir(), `codex-relay-${process.pid}-${Date.now()}.txt`);
  const modelArgs = model ? ["-m", model] : [];
  let args;
  if (existing?.threadId) {
    args = ["exec", "--json", "--skip-git-repo-check", ...sandboxArgs, ...modelArgs, "-o", outFile, "resume", existing.threadId, prompt];
  } else {
    args = ["exec", "--json", "--skip-git-repo-check", ...sandboxArgs, ...modelArgs, "-C", workspace, "-o", outFile, prompt];
  }
  try {
    const { stdout, stderr } = await exec(codexBin, args, { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 });
    const raw = stdout || stderr || "";
    const threadId = extractThreadId(raw) || existing?.threadId;
    if (threadId) {
      sessions[sessionKey] = { threadId, lastUsed: new Date().toISOString() };
      await saveSessions(sessions);
    }
    try { return await readFile(outFile, "utf8"); }
    catch { return raw || "Codex returned no reply"; }
  } finally {
    await unlink(outFile).catch(() => {});
  }
}

async function run(task) {
  if (!allowed.has(task.workspace)) throw new Error(`workspace rejected locally: ${task.workspace}`);
  const prompt = `You are the local Codex coordinator. This task came from the authenticated web relay.\n\nWORKER POLICY: delegate engineering work to the local Cursor MCP bridge when appropriate. Do not use the online VRe bridge. Do not enable shell/network/SSH unless separately approved by the user. Return a concise worker report with STATUS, Scope, Actions performed, Verification, Known issues, and Exact blocker.\n\nTASK:\n${task.prompt}`;
  const args = ["exec", "--json", "--skip-git-repo-check", "-s", "workspace-write", "-c", "sandbox_workspace_write.network_access=false", "-C", task.workspace, prompt];
  try { const { stdout, stderr } = await exec(codexBin, args, { timeout: 60 * 60 * 1000, maxBuffer: 20 * 1024 * 1024 }); return { state: "completed", output: stdout || stderr || "Codex returned no output" }; }
  catch (e) { return { state: "failed", output: e.stdout || e.stderr || e.message }; }
}

async function runConversation(message) {
  const workspace = process.env.CODEX_RELAY_DEFAULT_WORKSPACE;
  if (!allowed.has(workspace)) throw new Error("Set CODEX_RELAY_DEFAULT_WORKSPACE to an explicitly allowed workspace");
  const isMarket = message.direction === "market_to_codex";
  const kind = isMarket ? "market" : "web";
  const sessionKey = `${kind}:${message.conversation_id}`;
  const prompt = isMarket
    ? `You are a low-latency Indian index-options reasoning engine receiving a complete point-in-time market snapshot from S8. Do not use tools, edit files, inspect repositories, or fetch outside data. Reason only from MESSAGE. Follow its requested JSON schema exactly and output only the final JSON object. If uncertain or data is stale/missing, return WAIT.\n\nMESSAGE ID: ${message.message_id}\nCONVERSATION: ${message.conversation_id}\n\nMESSAGE:\n${message.text}`
    : `You are the local Codex coordinator answering a message from a ChatGPT web conversation. Use the local Cursor MCP for engineering work when needed. Do not use the online VRe bridge. Reply directly and clearly; if blocked, state the exact blocker.\n\nMESSAGE ID: ${message.message_id}\nCONVERSATION: ${message.conversation_id}\n\nMESSAGE:\n${message.text}`;
  try {
    return {
      state: "completed",
      text: await runCodexPersistent({
        prompt,
        workspace,
        sessionKey,
        sandboxArgs: isMarket ? ["-s", "read-only"] : ["-s", "workspace-write", "-c", "sandbox_workspace_write.network_access=false"],
        timeoutMs: isMarket ? Number(process.env.CODEX_RELAY_MARKET_TIMEOUT_MS || 20000) : 60 * 60 * 1000,
        model: isMarket ? process.env.CODEX_RELAY_MARKET_MODEL : undefined,
      }),
    };
  } catch (e) {
    if (isMarket) {
      return {
        state: "failed",
        text: JSON.stringify({
          action: "WAIT",
          option_symbol: null,
          option_exchange: null,
          stop_reference: null,
          target_reference: null,
          confidence: 0,
          rationale: "Codex market reasoning unavailable or timed out",
          valid_for_seconds: 10,
        }),
      };
    }
    return { state: "failed", text: e.stdout || e.stderr || e.message };
  }
}

// ponytail: while Codex is busy, only the newest market_to_codex message is
// worth reasoning on; older pending market ticks are ack'd and discarded.
function coalesceInbox(messages) {
  const list = messages || [];
  let latestMarket = null;
  for (const message of list) {
    if (message.direction === "market_to_codex") latestMarket = message;
  }
  const out = [];
  for (const message of list) {
    if (message.direction === "market_to_codex") {
      if (latestMarket && message.message_id === latestMarket.message_id) out.push(message);
      else out.push({ ...message, _coalescedAway: true });
    } else if (["web_to_codex"].includes(message.direction)) {
      out.push(message);
    } else {
      out.push({ ...message, _skip: true });
    }
  }
  return out;
}

const waitMs = Number(process.env.CODEX_RELAY_POLL_MS || 1000);
const once = process.argv.includes("--once");
let cursor = Number(process.env.CODEX_RELAY_MESSAGE_CURSOR || 0);
while (true) {
  if (process.env.CODEX_RELAY_CONVERSATION_ID) {
    const inbox = await api(`/v1/inbox?conversation_id=${encodeURIComponent(process.env.CODEX_RELAY_CONVERSATION_ID)}&after=${cursor}`, { method: "GET" });
    for (const message of coalesceInbox(inbox.messages)) {
      if (message._skip) { cursor = Math.max(cursor, message.sequence); continue; }
      if (message._coalescedAway) {
        await api("/v1/messages/ack", { method: "POST", body: JSON.stringify({ conversation_id: message.conversation_id, message_id: message.message_id }) });
        cursor = Math.max(cursor, message.sequence);
        continue;
      }
      if (!["web_to_codex", "market_to_codex"].includes(message.direction)) { cursor = Math.max(cursor, message.sequence); continue; }
      const result = await runConversation(message);
      const target = message.direction === "market_to_codex" ? "market" : "web";
      await api(`/v1/conversations/${encodeURIComponent(message.conversation_id)}/replies`, { method: "POST", body: JSON.stringify({ text: result.text, reply_to: message.message_id, target }) });
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
