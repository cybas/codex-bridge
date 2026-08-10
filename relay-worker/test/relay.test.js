import test from "node:test";
import assert from "node:assert/strict";
import { TaskQueue } from "../src/index.js";

function state() {
  const data = new Map();
  return { storage: { get: async k => data.get(k), put: async (k, v) => data.set(k, v) } };
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
