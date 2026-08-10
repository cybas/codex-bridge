const MAX_PROMPT_BYTES = 64 * 1024;
const MAX_TTL_SECONDS = 24 * 60 * 60;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function token(req, name) {
  const value = req.headers.get("authorization") || "";
  const [scheme, supplied] = value.split(" ");
  return scheme?.toLowerCase() === "bearer" && supplied === name;
}

function safeTask(body, env) {
  if (!body || typeof body.prompt !== "string" || !body.prompt.trim()) throw new Error("prompt is required");
  if (new TextEncoder().encode(body.prompt).byteLength > MAX_PROMPT_BYTES) throw new Error("prompt is too large");
  if (typeof body.workspace !== "string" || !env.ALLOWED_WORKSPACES.split(",").includes(body.workspace)) {
    throw new Error("workspace is not allowed");
  }
  if (body.allow_shell || body.network || body.ssh || body.deploy || body.push || body.commit) {
    throw new Error("privileged capabilities must be approved locally, not requested from the web");
  }
  return {
    task_id: crypto.randomUUID(), prompt: body.prompt.trim(), workspace: body.workspace,
    session_name: typeof body.session_name === "string" ? body.session_name.slice(0, 100) : "web-relay",
    new_session: body.new_session === true,
    capabilities: { files_read: true, files_write: true, shell: false, network: false, ssh: false, commit: false, push: false, deploy: false },
    created_at: new Date().toISOString(), expires_at: new Date(Date.now() + Math.min(Number(body.ttl_seconds) || 3600, MAX_TTL_SECONDS) * 1000).toISOString(),
  };
}

function conversationId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(value)) throw new Error("invalid conversation_id");
  return value;
}

async function readJson(req) { try { return await req.json(); } catch { throw new Error("invalid JSON"); } }

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.pathname === "/healthz") return json({ ok: true, service: "codex-task-relay" });
    if (parts[0] !== "v1" || !["tasks", "conversations", "inbox", "messages"].includes(parts[1])) return json({ error: "not found" }, 404);

    if (parts[1] === "conversations") {
      const conversation = conversationId(parts[2]);
      const stub = env.TASK_QUEUE.get(env.TASK_QUEUE.idFromName(`conversation:${conversation}`));
      if (req.method === "POST" && parts.length === 4 && parts[3] === "messages") {
        if (!token(req, env.WEB_TOKEN)) return json({ error: "unauthorized" }, 401);
        const body = await readJson(req);
        if (typeof body.text !== "string" || !body.text.trim() || body.text.length > MAX_PROMPT_BYTES) return json({ error: "text is required and must be <= 64KB" }, 400);
        return stub.fetch("https://queue/message", { method: "POST", body: JSON.stringify({ conversation_id: conversation, direction: "web_to_codex", text: body.text.trim(), reply_to: body.reply_to || null }) });
      }
      if (req.method === "GET" && parts.length === 3) {
        if (!token(req, env.WEB_TOKEN) && !token(req, env.AGENT_TOKEN)) return json({ error: "unauthorized" }, 401);
        return stub.fetch(`https://queue/messages?after=${encodeURIComponent(url.searchParams.get("after") || "0")}`);
      }
      if (req.method === "POST" && parts.length === 4 && parts[3] === "replies") {
        if (!token(req, env.AGENT_TOKEN)) return json({ error: "unauthorized" }, 401);
        const body = await readJson(req);
        if (typeof body.text !== "string" || !body.text.trim() || body.text.length > MAX_PROMPT_BYTES) return json({ error: "text is required and must be <= 64KB" }, 400);
        return stub.fetch("https://queue/message", { method: "POST", body: JSON.stringify({ conversation_id: conversation, direction: "codex_to_web", text: body.text.trim(), reply_to: body.reply_to || null }) });
      }
    }

    if (parts[1] === "inbox" && req.method === "GET") {
      if (!token(req, env.AGENT_TOKEN)) return json({ error: "unauthorized" }, 401);
      const stub = env.TASK_QUEUE.get(env.TASK_QUEUE.idFromName(`conversation:${url.searchParams.get("conversation_id") || "default"}`));
      return stub.fetch(`https://queue/inbox?after=${encodeURIComponent(url.searchParams.get("after") || "0")}`);
    }

    if (parts[1] === "messages" && parts.length === 3 && req.method === "POST" && parts[2] === "ack") {
      if (!token(req, env.AGENT_TOKEN) && !token(req, env.WEB_TOKEN)) return json({ error: "unauthorized" }, 401);
      const body = await readJson(req); const conversation = conversationId(body.conversation_id);
      const stub = env.TASK_QUEUE.get(env.TASK_QUEUE.idFromName(`conversation:${conversation}`));
      return stub.fetch("https://queue/ack", { method: "POST", body: JSON.stringify({ message_id: body.message_id, by: token(req, env.AGENT_TOKEN) ? "codex" : "web" }) });
    }

    // Task routes continue below; the conversation routes above are additive.
    if (parts[1] !== "tasks") return json({ error: "not found" }, 404);

    if (req.method === "POST" && parts.length === 2) {
      if (!token(req, env.WEB_TOKEN)) return json({ error: "unauthorized" }, 401);
      try {
        const task = safeTask(await req.json(), env);
        const stub = env.TASK_QUEUE.get(env.TASK_QUEUE.idFromName("default"));
        return await stub.fetch("https://queue/enqueue", { method: "POST", body: JSON.stringify(task) });
      } catch (e) { return json({ error: e.message }, 400); }
    }

    if (req.method === "GET" && parts.length === 3 && parts[2] === "next") {
      if (!token(req, env.AGENT_TOKEN)) return json({ error: "unauthorized" }, 401);
      const stub = env.TASK_QUEUE.get(env.TASK_QUEUE.idFromName("default"));
      return stub.fetch("https://queue/claim", { method: "POST", headers: { "x-agent": req.headers.get("x-agent") || "local-codex" } });
    }

    if (parts.length === 3 || parts.length === 4) {
      const taskId = parts[2];
      const stub = env.TASK_QUEUE.get(env.TASK_QUEUE.idFromName("default"));
      if (req.method === "GET") {
        if (!token(req, env.WEB_TOKEN) && !token(req, env.AGENT_TOKEN)) return json({ error: "unauthorized" }, 401);
        return stub.fetch(`https://queue/task/${taskId}`);
      }
      if (req.method === "POST" && parts.length === 4 && parts[3] === "result") {
        if (!token(req, env.AGENT_TOKEN)) return json({ error: "unauthorized" }, 401);
        return stub.fetch(`https://queue/task/${taskId}/result`, { method: "POST", body: req.body });
      }
    }
    return json({ error: "method not allowed" }, 405);
  },
};

export class TaskQueue {
  constructor(state) { this.state = state; }
  async fetch(req) {
    const url = new URL(req.url);
    const tasks = (await this.state.storage.get("tasks")) || {};
    const events = (await this.state.storage.get("events")) || [];
    if (req.method === "POST" && url.pathname === "/message") {
      const body = await req.json();
      const event = { message_id: crypto.randomUUID(), sequence: events.length + 1, ...body, created_at: new Date().toISOString(), acknowledged_by: [] };
      events.push(event); await this.state.storage.put("events", events); return json(event, 202);
    }
    if ((req.method === "GET" && (url.pathname === "/messages" || url.pathname === "/inbox"))) {
      const after = Number(url.searchParams.get("after") || 0);
      return json({ messages: events.filter(e => e.sequence > after), cursor: events.length });
    }
    if (req.method === "POST" && url.pathname === "/ack") {
      const body = await req.json(); const event = events.find(e => e.message_id === body.message_id);
      if (!event) return json({ error: "message not found" }, 404);
      if (!event.acknowledged_by.includes(body.by)) event.acknowledged_by.push(body.by);
      await this.state.storage.put("events", events); return json(event);
    }
    if (req.method === "POST" && url.pathname === "/enqueue") {
      const task = await req.json(); tasks[task.task_id] = { ...task, state: "pending" }; await this.state.storage.put("tasks", tasks);
      return json({ task_id: task.task_id, state: "pending" }, 202);
    }
    if (req.method === "POST" && url.pathname === "/claim") {
      const now = Date.now(); const task = Object.values(tasks).find(t => t.state === "pending" && Date.parse(t.expires_at) > now);
      if (!task) return json({ task: null });
      task.state = "claimed"; task.claimed_by = req.headers.get("x-agent") || "local-codex"; task.claimed_at = new Date().toISOString();
      await this.state.storage.put("tasks", tasks); return json({ task });
    }
    const match = url.pathname.match(/^\/task\/([^/]+)(?:\/result)?$/); if (!match) return json({ error: "not found" }, 404);
    const id = match[1]; if (!tasks[id]) return json({ error: "not found" }, 404);
    if (url.pathname.endsWith("/result")) { const result = await req.json(); tasks[id] = { ...tasks[id], ...result, state: result.state || "completed", completed_at: new Date().toISOString() }; await this.state.storage.put("tasks", tasks); return json(tasks[id]); }
    return json(tasks[id]);
  }
}
