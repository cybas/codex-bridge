import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverPath = path.join(root, "market-relay-server.js");

async function withServer(env, fn) {
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let booted = false;
  const boot = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server boot timeout")), 5000);
    child.stdout.on("data", (buf) => {
      if (String(buf).includes("listening")) {
        booted = true;
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", (buf) => {
      if (!booted) {
        clearTimeout(timer);
        reject(new Error(String(buf)));
      }
    });
    child.on("exit", (code) => {
      if (!booted) {
        clearTimeout(timer);
        reject(new Error(`server exited ${code}`));
      }
    });
  });
  try {
    await boot;
    await fn();
  } finally {
    child.kill("SIGTERM");
    await sleep(100);
  }
}

test("market relay rejects missing auth and serves healthz", async () => {
  const bind = "127.0.0.1";
  const port = 18788;
  const token = "test-market-token";
  await withServer(
    {
      CODEX_MARKET_RELAY_BIND: bind,
      CODEX_MARKET_RELAY_PORT: String(port),
      CODEX_RELAY_MARKET_TOKEN: token,
      CODEX_RELAY_DEFAULT_WORKSPACE: "/Users/vr/trader-a2",
      CODEX_AGENT_PATH: "/usr/bin/false",
    },
    async () => {
      const health = await fetch(`http://${bind}:${port}/healthz`);
      assert.equal(health.status, 200);
      const denied = await fetch(`http://${bind}:${port}/v1/market/analyze`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      });
      assert.equal(denied.status, 401);
      const bad = await fetch(`http://${bind}:${port}/v1/market/analyze`, {
        method: "POST",
        headers: { authorization: "Bearer wrong", "content-type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      });
      assert.equal(bad.status, 401);
    },
  );
});

test("market relay fails closed to WAIT when Codex binary fails", async () => {
  const bind = "127.0.0.1";
  const port = 18789;
  const token = "test-market-token";
  await withServer(
    {
      CODEX_MARKET_RELAY_BIND: bind,
      CODEX_MARKET_RELAY_PORT: String(port),
      CODEX_RELAY_MARKET_TOKEN: token,
      CODEX_RELAY_DEFAULT_WORKSPACE: "/Users/vr/trader-a2",
      CODEX_RELAY_MARKET_TIMEOUT_MS: "2000",
      CODEX_AGENT_PATH: "/usr/bin/false",
    },
    async () => {
      const ok = await fetch(`http://${bind}:${port}/v1/market/analyze`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ text: "POINT_IN_TIME_STATE:{}", conversation_id: "s8-market" }),
      });
      assert.equal(ok.status, 200);
      const body = await ok.json();
      assert.equal(body.recommendation.action, "WAIT");
      assert.match(body.recommendation.rationale, /unavailable|timed out|superseded/i);
    },
  );
});
