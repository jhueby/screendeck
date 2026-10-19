#!/usr/bin/env python3
"""Minimal streaming Ollama chat REPL for Screendeck sessions.

Talks straight to the Ollama HTTP API (/api/chat) so no `ollama` CLI is needed
on this host. Keeps conversation history in-process and streams tokens.

Usage:  OLLAMA_HOST=http://host:11434 ollama-chat.py <model>
"""
import os
import sys
import json
import urllib.request

HOST = os.environ.get("OLLAMA_HOST", "http://192.168.1.21:11434").rstrip("/")
MODEL = sys.argv[1] if len(sys.argv) > 1 else "qwen2.5:7b"

C_HEAD = "\033[1m"
C_PROMPT = "\033[36m"
C_ERR = "\033[31m"
C_OFF = "\033[0m"


def stream(messages):
    """POST the conversation, stream the assistant reply, return it as text."""
    body = json.dumps({"model": MODEL, "messages": messages, "stream": True}).encode()
    req = urllib.request.Request(
        HOST + "/api/chat", data=body, headers={"Content-Type": "application/json"}
    )
    parts = []
    with urllib.request.urlopen(req, timeout=600) as r:
        for line in r:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if d.get("error"):
                raise RuntimeError(d["error"])
            tok = (d.get("message") or {}).get("content", "")
            if tok:
                sys.stdout.write(tok)
                sys.stdout.flush()
                parts.append(tok)
            if d.get("done"):
                break
    print()
    return "".join(parts)


def main():
    global MODEL
    print(f"{C_HEAD}Ollama{C_OFF} · {MODEL} @ {HOST}")
    print("Type a message. /exit quits · /reset clears history · /model <name> switches.\n")
    msgs = []
    while True:
        try:
            user = input(f"{C_PROMPT}› {C_OFF}")
        except (EOFError, KeyboardInterrupt):
            print()
            break
        u = user.strip()
        if u in ("/exit", "/quit"):
            break
        if u == "/reset":
            msgs = []
            print("(history cleared)\n")
            continue
        if u.startswith("/model "):
            MODEL = u.split(None, 1)[1].strip()
            print(f"(model → {MODEL})\n")
            continue
        if not u:
            continue
        msgs.append({"role": "user", "content": u})
        try:
            reply = stream(msgs)
            msgs.append({"role": "assistant", "content": reply})
        except Exception as e:
            print(f"{C_ERR}[error: {e}]{C_OFF}")
            msgs.pop()  # drop the turn that failed so history stays clean
        print()


if __name__ == "__main__":
    main()
