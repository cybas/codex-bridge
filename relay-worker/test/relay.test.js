import test from "node:test";
import assert from "node:assert/strict";
import worker, { TaskQueue } from "../src/index.js";

function state() {
  const data = new Map();
  return { storage: { get: async k => data.get(k), put: async (k, v) => data.set(k, v) } };
}

function env() {
  const queues = new Map();
  return {
    WEB_TOKEN: "web-secret",
    AGENT_TOKEN: "agent-secret",
    MARKET_TOKEN: "market-secret",
    ALLOWED_WORKSPACES: "/tmp/repo",
    TASK_QUEUE: {
      idFromName: name => name,
      get: id => {
        if (!queues.has(id)) {
          const queue = new TaskQueue(state());
          queues.set(id, { fetch: (url, options) => queue.fetch(new Request(url, options)) });
        }
        return queues.get(id);
      },
    },
  };
}

test("conversation messages have ordered cursors and acknowledgements", async () => {
  const queue = new TaskQueue(state());
  const first = await queue.fetch(new Request("https://queue/message", { method: "POST", body: JSON.stringify({ conversation_id: "chat-1", direction: "web_to_codex", text: "hello" }) }));
  const created = await first.json();
  assert.equal(created.sequence, 1);
  const inbox = await queue.fetch(new Request("https://queue/inbox?after=0"));
  assert.equal((await inbox.json()).messages[0].message_id, created.message_id);
  const ack = await queue.fetch(new Request("https://queue/ack", { method: "POST", body: JSON.stringify({ message_id: created.message_id, by: "codex" }) }));
  assert.deepEqual((await ack.json()).acknowledged_by, ["codex"]);
  const empty = await queue.fetch(new Request("https://queue/inbox?after=1"));
  assert.equal((await empty.json()).messages.length, 0);
});

test("market token can submit and read only the market conversation path", async () => {
  const e = env();
  const submitted = await worker.fetch(new Request("https://relay/v1/conversations/s8-market/market", {
    method: "POST",
    headers: { authorization: "Bearer market-secret", "content-type": "application/json" },
    body: JSON.stringify({ text: "snapshot" }),
  }), e);
  assert.equal(submitted.status, 202);
  const created = await submitted.json();
  assert.equal(created.direction, "market_to_codex");

  const denied = await worker.fetch(new Request("https://relay/v1/conversations/s8-market/market", {
    method: "POST",
    headers: { authorization: "Bearer web-secret", "content-type": "application/json" },
    body: JSON.stringify({ text: "nope" }),
  }), e);
  assert.equal(denied.status, 401);

  const reply = await worker.fetch(new Request("https://relay/v1/conversations/s8-market/replies", {
    method: "POST",
    headers: { authorization: "Bearer agent-secret", "content-type": "application/json" },
    body: JSON.stringify({ text: "{\"action\":\"WAIT\"}", reply_to: created.message_id, target: "market" }),
  }), e);
  assert.equal(reply.status, 202);
  assert.equal((await reply.json()).direction, "codex_to_market");

  const read = await worker.fetch(new Request("https://relay/v1/conversations/s8-market?after=1", {
    headers: { authorization: "Bearer market-secret" },
  }), e);
  const body = await read.json();
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].direction, "codex_to_market");
});
