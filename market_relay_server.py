#!/usr/bin/env python3
"""Private Tailscale market-analysis relay for S8 → Mac Codex.

Bind only to a Tailscale/private address. No Cloudflare dependency.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

BIND_HOST = os.environ.get("CODEX_MARKET_RELAY_BIND", "")
BIND_PORT = int(os.environ.get("CODEX_MARKET_RELAY_PORT", "8788"))
MARKET_TOKEN = os.environ.get("CODEX_RELAY_MARKET_TOKEN") or os.environ.get("MARKET_TOKEN") or ""
CODEX_BIN = os.environ.get("CODEX_AGENT_PATH", "codex")
WORKSPACE = os.environ.get("CODEX_RELAY_DEFAULT_WORKSPACE", "/Users/vr/trader-a2")
ALLOWED = {
    x.strip()
    for x in (
        os.environ.get(
            "CODEX_RELAY_WORKSPACES",
            "/Users/vr/trader-a2,/Users/vr/symbol_intake,/Users/vr/ta2-dhan-candle,/Users/vr/openalgo",
        )
    ).split(",")
    if x.strip()
}
TIMEOUT_SEC = max(5, int(os.environ.get("CODEX_RELAY_MARKET_TIMEOUT_MS", "25000")) // 1000)
CONVERSATION_DEFAULT = os.environ.get("CODEX_RELAY_CONVERSATION_ID", "s8-market")
MODEL = os.environ.get("CODEX_RELAY_MARKET_MODEL", "gpt-5.5")
SESSION_FILE = Path.home() / ".claude" / "mcp-servers" / "codex-bridge" / "relay-sessions.json"
MAX_BODY = 64 * 1024

WAIT_TIMEOUT = {
    "action": "WAIT",
    "option_symbol": None,
    "option_exchange": None,
    "stop_reference": None,
    "target_reference": None,
    "confidence": 0,
    "rationale": "Codex market reasoning unavailable or timed out",
    "valid_for_seconds": 10,
}
WAIT_COALESCED = {
    **WAIT_TIMEOUT,
    "rationale": "Newer market state superseded this request",
}

if not BIND_HOST:
    raise SystemExit("CODEX_MARKET_RELAY_BIND is required")
if not MARKET_TOKEN:
    raise SystemExit("CODEX_RELAY_MARKET_TOKEN is required")
if WORKSPACE not in ALLOWED:
    raise SystemExit(f"workspace not allowed: {WORKSPACE}")
if not (BIND_HOST.startswith("100.") or BIND_HOST == "127.0.0.1"):
    raise SystemExit(f"refusing non-private bind host: {BIND_HOST}")

_codex_lock = threading.Lock()
_latest_generation = 0
_generation_lock = threading.Lock()


def _load_sessions() -> dict[str, Any]:
    try:
        return json.loads(SESSION_FILE.read_text())
    except Exception:
        return {}


def _save_sessions(sessions: dict[str, Any]) -> None:
    SESSION_FILE.parent.mkdir(parents=True, exist_ok=True)
    SESSION_FILE.write_text(json.dumps(sessions, indent=2))


def _extract_thread_id(output: str) -> str | None:
    for line in output.splitlines():
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "thread.started" and event.get("thread_id"):
            return str(event["thread_id"])
    return None


def _extract_json_object(text: str) -> dict[str, Any] | None:
    raw = text.strip()
    start, end = raw.find("{"), raw.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        value = json.loads(raw[start : end + 1])
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


def _run_codex(prompt: str, conversation_id: str) -> str:
    sessions = _load_sessions()
    session_key = f"market:{conversation_id}"
    existing = sessions.get(session_key) or {}
    thread_id = existing.get("threadId")
    with tempfile.NamedTemporaryFile(prefix="codex-market-", suffix=".txt", delete=False) as handle:
        out_path = Path(handle.name)
    args = [
        CODEX_BIN,
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--ignore-user-config",
        "-s",
        "read-only",
        "-m",
        MODEL,
        "-o",
        str(out_path),
    ]
    if thread_id:
        args.extend(["resume", str(thread_id), prompt])
    else:
        args.extend(["-C", WORKSPACE, prompt])
    try:
        # stdin=DEVNULL is critical; otherwise Codex waits for more prompt input.
        completed = subprocess.run(
            args,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=TIMEOUT_SEC,
            text=True,
        )
        combined = (completed.stdout or "") + "\n" + (completed.stderr or "")
        new_thread = _extract_thread_id(combined) or thread_id
        if new_thread:
            sessions[session_key] = {"threadId": new_thread, "lastUsed": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
            _save_sessions(sessions)
        try:
            return out_path.read_text()
        except Exception:
            parsed = _extract_json_object(combined)
            return json.dumps(parsed or WAIT_TIMEOUT)
    except subprocess.TimeoutExpired:
        return json.dumps(WAIT_TIMEOUT)
    finally:
        out_path.unlink(missing_ok=True)


def _enqueue(job):
    """Serialize Codex turns; stale waiters get WAIT_COALESCED."""
    global _latest_generation
    with _generation_lock:
        _latest_generation += 1
        my_generation = _latest_generation
    with _codex_lock:
        if my_generation != _latest_generation:
            return {"state": "coalesced", "text": json.dumps(WAIT_COALESCED), "latency_ms": 0}
        started = time.monotonic()
        try:
            text = job()
            return {"state": "completed", "text": text, "latency_ms": int((time.monotonic() - started) * 1000)}
        except Exception as exc:  # noqa: BLE001 - fail closed
            return {
                "state": "failed",
                "text": json.dumps({**WAIT_TIMEOUT, "rationale": f"Codex market reasoning unavailable: {exc}"}),
                "latency_ms": int((time.monotonic() - started) * 1000),
            }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"market-relay: {self.address_string()} - {fmt % args}", flush=True)

    def _json(self, status: int, body: dict[str, Any]) -> None:
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _authorized(self) -> bool:
        value = self.headers.get("authorization") or ""
        parts = value.split(" ", 1)
        return len(parts) == 2 and parts[0].lower() == "bearer" and parts[1] == MARKET_TOKEN

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/healthz":
            self._json(
                200,
                {"ok": True, "service": "codex-market-relay-tailscale", "bind": BIND_HOST, "port": BIND_PORT},
            )
            return
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path != "/v1/market/analyze":
            self._json(404, {"error": "not found"})
            return
        if not self._authorized():
            self._json(401, {"error": "unauthorized"})
            return
        length = int(self.headers.get("content-length") or 0)
        if length <= 0 or length > MAX_BODY:
            self._json(400, {"error": "invalid body"})
            return
        try:
            body = json.loads(self.rfile.read(length))
        except json.JSONDecodeError:
            self._json(400, {"error": "invalid JSON"})
            return
        text = body.get("text") if isinstance(body, dict) else None
        if not isinstance(text, str) or not text.strip():
            self._json(400, {"error": "text is required"})
            return
        conversation_id = body.get("conversation_id") if isinstance(body, dict) else None
        if not (isinstance(conversation_id, str) and re.fullmatch(r"[A-Za-z0-9._:-]{1,160}", conversation_id or "")):
            conversation_id = CONVERSATION_DEFAULT
        prompt = (
            "You are a low-latency Indian index-options reasoning engine receiving a complete "
            "point-in-time market snapshot from S8. Do not use tools, edit files, inspect "
            "repositories, or fetch outside data. Reason only from MESSAGE. Follow its requested "
            "JSON schema exactly and output only the final JSON object. If uncertain or data is "
            f"stale/missing, return WAIT.\n\nCONVERSATION: {conversation_id}\n\nMESSAGE:\n{text.strip()}"
        )
        result = _enqueue(lambda: _run_codex(prompt, conversation_id))
        parsed = _extract_json_object(result["text"]) or WAIT_TIMEOUT
        self._json(
            200,
            {
                "state": result["state"],
                "text": json.dumps(parsed, separators=(",", ":")),
                "latency_ms": result["latency_ms"],
                "conversation_id": conversation_id,
                "recommendation": parsed,
                "request_id": str(uuid.uuid4()),
            },
        )


def main() -> None:
    server = ThreadingHTTPServer((BIND_HOST, BIND_PORT), Handler)
    print(f"codex-market-relay listening on http://{BIND_HOST}:{BIND_PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
