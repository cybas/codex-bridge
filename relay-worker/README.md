# Codex task relay

This is a deliberately narrow Cloudflare Worker queue. ChatGPT web can submit
tasks and conversation messages; the authenticated local agent can claim tasks,
read inbound conversation messages, and post replies. The web request cannot
request shell, SSH, network, commit, push, or deployment capabilities.

Conversation endpoints:

```text
POST /v1/conversations/:conversation_id/messages   Web → Codex
POST /v1/conversations/:conversation_id/market     S8 market producer → Codex
GET  /v1/conversations/:conversation_id            Read conversation events
GET  /v1/inbox?conversation_id=...&after=...       Codex receives messages
POST /v1/conversations/:conversation_id/replies    Codex → Web or market producer
POST /v1/messages/ack                              Acknowledge delivery
```

The `after` cursor makes reconnects safe. Every message has a `message_id`,
`sequence`, `direction`, `reply_to`, and acknowledgement list.

Before deployment, set secrets (never put them in `wrangler.jsonc`):

```sh
wrangler secret put WEB_TOKEN
wrangler secret put AGENT_TOKEN
wrangler secret put MARKET_TOKEN
wrangler deploy
```

`MARKET_TOKEN` is intentionally separate from both the web and local-agent
credentials. It can submit `market_to_codex` messages, read the same
conversation and acknowledge `codex_to_market` replies, but it cannot claim
queued engineering tasks or post Codex replies itself.

Put Cloudflare Access in front of the Worker as an additional identity layer.
The local agent should use a separate `AGENT_TOKEN`; rotate all three secrets
independently.

For bidirectional mode, run the local agent with
`CODEX_RELAY_CONVERSATION_ID` and `CODEX_RELAY_DEFAULT_WORKSPACE` set. The
default workspace must be one of the explicit paths in
`CODEX_RELAY_WORKSPACES`.
