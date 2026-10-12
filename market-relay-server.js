#!/usr/bin/env node
/**
 * Private Tailscale market-analysis relay for S8 → Mac Codex.
 * Bind only to a Tailscale/private address. No Cloudflare dependency.
 */
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const exec = promisify(execFile);
const bindHost = process.env.CODEX_MARKET_RELAY_BIND || "";
const bindPort = Number(process.env.CODEX_MARKET_RELAY_PORT || 8788);
const marketToken = process.env.CODEX_RELAY_MARKET_TOKEN || process.env.MARKET_TOKEN || "";
const codexBin = process.env.CODEX_AGENT_PATH || "codex";
const workspace = process.env.CODEX_RELAY_DEFAULT_WORKSPACE || "/Users/vr/trader-a2";
const allowed = new Set(
  (process.env.CODEX_RELAY_WORKSPACES || "/Users/vr/trader-a2,/Users/vr/symbol_intake,/Users/vr/ta2-dhan-candle,/Users/vr/openalgo")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean),
);
const timeoutMs = Number(process.env.CODEX_RELAY_MARKET_TIMEOUT_MS || 25000);
const conversationDefault = process.env.CODEX_RELAY_CONVERSATION_ID || "s8-market";
const sessionDir = path.join(os.homedir(), ".claude", "mcp-servers", "codex-bridge");
const sessionFile = path.join(sessionDir, "relay-sessions.json");
const maxBodyBytes = 64 * 1024;

if (!bindHost) throw new Error("CODEX_MARKET_RELAY_BIND is required (Tailscale/private IP only)");
if (!marketToken) throw new Error("CODEX_RELAY_MARKET_TOKEN (or MARKET_TOKEN) is required");
if (!allowed.has(workspace)) throw new Error(`workspace not allowed: ${workspace}`);
if (!bindHost.startsWith("100.") && bindHost !== "127.0.0.1") {
  // Tailscale CGNAT is 100.x; localhost allowed for unit tests only.
  throw new Error(`refusing non-private bind host: ${bindHost}`);
}

const WAIT_TIMEOUT = JSON.stringify({
  action: "WAIT",
  option_symbol: null,
  option_exchange: null,
  stop_reference: null,
  target_reference: null,
  confidence: 0,
  rationale: "Codex market reasoning unavailable or timed out",
  valid_for_seconds: 10,
});

const WAIT_COALESCED = JSON.stringify({
  action: "WAIT",
  option_symbol: null,
  option_exchange: null,
  stop_reference: null,
  target_reference: null,
  confidence: 0,
  rationale: "Newer market state superseded this request",
  valid_for_seconds: 10,
});

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function authorized(req) {
  const value = req.headers.authorization || "";
  const [scheme, supplied] = value.split(" ");
  return scheme?.toLowerCase() === "bearer" && supplied === marketToken;
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBodyBytes) throw new Error("body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function loadSessions() {
  try {
    return JSON.parse(await readFile(sessionFile, "utf8"));
  } catch {
    return {};
  }
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

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function runCodexMarket({ prompt, conversationId }) {
  const sessions = await loadSessions();
  const sessionKey = `market:${conversationId}`;
  const existing = sessions[sessionKey];
  const outFile = path.join(os.tmpdir(), `codex-market-${process.pid}-${Date.now()}.txt`);
  const sandboxArgs = ["-s", "read-only"];
  const modelArgs = process.env.CODEX_RELAY_MARKET_MODEL ? ["-m", process.env.CODEX_RELAY_MARKET_MODEL] : [];
  let args;
  // --ignore-user-config avoids MCP servers in ~/.codex/config.toml hanging the
  // market path (Cloudflare MCP OAuth stalls). Auth still uses CODEX_HOME.
  const baseArgs = ["exec", "--json", "--skip-git-repo-check", "--ignore-user-config", ...sandboxArgs, ...modelArgs];
  if (existing?.threadId) {
    args = [...baseArgs, "-o", outFile, "resume", existing.threadId, prompt];
  } else {
    args = [...baseArgs, "-C", workspace, "-o", outFile, prompt];
  }
  try {
    // stdin must be ignored; otherwise Codex waits for more prompt input forever.
    const { stdout, stderr } = await exec(codexBin, args, {
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const raw = stdout || stderr || "";
    const threadId = extractThreadId(raw) || existing?.threadId;
    if (threadId) {
      sessions[sessionKey] = { threadId, lastUsed: new Date().toISOString() };
      await saveSessions(sessions);
    }
    try {
      return await readFile(outFile, "utf8");
    } catch {
      return raw || WAIT_TIMEOUT;
    }
  } finally {
    await unlink(outFile).catch(() => {});
  }
}

// Serialize Codex turns; stale waiters receive WAIT when a newer request arrives.
let queue = Promise.resolve();
let latestGeneration = 0;

function enqueueMarket(job) {
  const myGeneration = ++latestGeneration;
  return new Promise((resolve) => {
    queue = queue.then(async () => {
      if (myGeneration !== latestGeneration) {
        resolve({ state: "coalesced", text: WAIT_COALESCED, latency_ms: 0 });
        return;
      }
      const started = Date.now();
      try {
        const text = await job();
        resolve({ state: "completed", text, latency_ms: Date.now() - started });
      } catch (err) {
        resolve({
          state: "failed",
          text: WAIT_TIMEOUT,
          latency_ms: Date.now() - started,
          error: String(err?.message || err),
        });
      }
    });
  });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${bindHost}:${bindPort}`);
    if (req.method === "GET" && url.pathname === "/healthz") {
      return json(res, 200, { ok: true, service: "codex-market-relay-tailscale", bind: bindHost, port: bindPort });
    }
    if (req.method === "POST" && url.pathname === "/v1/market/analyze") {
      if (!authorized(req)) return json(res, 401, { error: "unauthorized" });
      let body;
      try {
        body = await readBody(req);
      } catch {
        return json(res, 400, { error: "invalid JSON" });
      }
      if (typeof body.text !== "string" || !body.text.trim()) {
        return json(res, 400, { error: "text is required" });
      }
      const conversationId =
        typeof body.conversation_id === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(body.conversation_id)
          ? body.conversation_id
          : conversationDefault;
      const prompt =
        `You are a low-latency Indian index-options reasoning engine receiving a complete point-in-time market snapshot from S8. ` +
        `Do not use tools, edit files, inspect repositories, or fetch outside data. Reason only from MESSAGE. ` +
        `Follow its requested JSON schema exactly and output only the final JSON object. If uncertain or data is stale/missing, return WAIT.\n\n` +
        `CONVERSATION: ${conversationId}\n\nMESSAGE:\n${body.text.trim()}`;
      const result = await enqueueMarket(() => runCodexMarket({ prompt, conversationId }));
      const parsed = extractJsonObject(result.text);
      return json(res, 200, {
        state: result.state,
        text: parsed ? JSON.stringify(parsed) : result.text,
        latency_ms: result.latency_ms,
        conversation_id: conversationId,
        recommendation: parsed,
      });
    }
    return json(res, 404, { error: "not found" });
  } catch (err) {
    return json(res, 500, { error: "internal error", detail: String(err?.message || err) });
  }
});

server.listen(bindPort, bindHost, () => {
  console.log(`codex-market-relay listening on http://${bindHost}:${bindPort}`);
});
