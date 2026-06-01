#!/usr/bin/env python3
"""
Client-side smoke test — runs from any machine with network access to the server.
No Docker, no admin access needed.

Usage:
    pip install websocket-client
    python3 client-smoke-test.py --url http://SERVER_IP --n 10

Arguments:
    --url       Backend URL (default: http://localhost:3000)
    --n         Number of concurrent sessions (default: 10)
    --code      Join code (default: workshop2026)
    --prefix    Email prefix for test accounts (default: clienttest)
    --timeout   Seconds to wait for LLM response (default: 60)
"""

import argparse
import json
import sys
import time
import threading
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    import websocket
except ImportError:
    print("Error: websocket-client not installed. Run: pip install websocket-client")
    sys.exit(1)

PROMPT = "Reply with exactly one word: READY"
SETTLE_TIMEOUT = 5   # seconds of silence = response done


def run_session(session_id, prefix, backend_url, ws_url, join_code, response_timeout):
    """Run one session end-to-end. Returns a result dict."""
    email = f"{prefix}-{session_id}@workshop.test"
    t_start = time.monotonic()
    result = {"id": session_id, "email": email}

    # Stagger slightly to avoid thundering herd on /join
    time.sleep(session_id * 0.1)

    # --- Join ---
    t_join_start = time.monotonic()
    try:
        data = json.dumps({"email": email, "code": join_code}).encode()
        req = urllib.request.Request(
            f"{backend_url}/join", data=data,
            headers={"Content-Type": "application/json"}, method="POST"
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = json.loads(resp.read())
        token = body.get("token")
        if not token:
            result["status"] = "FAIL"
            result["error"] = f"join rejected: {body}"
            return result
    except urllib.error.HTTPError as e:
        result["status"] = "FAIL"
        result["error"] = f"join HTTP {e.code}: {e.read().decode()}"
        return result
    except Exception as e:
        result["status"] = "FAIL"
        result["error"] = f"join error: {e}"
        return result

    result["join_ms"] = round((time.monotonic() - t_join_start) * 1000)

    # --- WebSocket ---
    output_chunks = []
    first_output = threading.Event()
    last_output_at = [0.0]
    ws_error = [None]
    prompt_sent_at = [None]

    def on_message(ws, message):
        if isinstance(message, bytes) and len(message) > 1 and message[0] == 0x30:
            output_chunks.append(message[1:].decode("utf-8", errors="replace"))
            last_output_at[0] = time.monotonic()
            if not first_output.is_set():
                first_output.set()

    def on_error(ws, error):
        ws_error[0] = str(error)
        first_output.set()

    def on_open(ws):
        resize = json.dumps({"columns": 200, "rows": 50}).encode()
        ws.send(bytes([0x31]) + resize, websocket.ABNF.OPCODE_BINARY)

    t_ws_start = time.monotonic()
    try:
        ws = websocket.WebSocketApp(
            f"{ws_url}/ws/agent/{token}",
            subprotocols=["tty"],
            on_message=on_message, on_error=on_error, on_open=on_open,
        )
        t = threading.Thread(target=ws.run_forever, kwargs={"ping_interval": 0})
        t.daemon = True
        t.start()

        # Wait for pi TUI to render
        if not first_output.wait(timeout=response_timeout):
            ws.close()
            result["status"] = "TIMEOUT"
            result["error"] = "pi did not start"
            return result

        if ws_error[0]:
            result["status"] = "FAIL"
            result["error"] = f"ws error: {ws_error[0]}"
            return result

        result["connect_ms"] = round((time.monotonic() - t_ws_start) * 1000)

        # Let TUI settle, then send prompt
        time.sleep(1.5)
        first_output.clear()
        output_chunks.clear()

        prompt_sent_at[0] = time.monotonic()
        ws.send(bytes([0x30]) + PROMPT.encode(), websocket.ABNF.OPCODE_BINARY)
        ws.send(bytes([0x30]) + b"\r",           websocket.ABNF.OPCODE_BINARY)

        # Wait for first response token
        if not first_output.wait(timeout=response_timeout):
            ws.close()
            result["status"] = "TIMEOUT"
            result["error"] = "no LLM response"
            return result

        result["first_token_ms"] = round((time.monotonic() - prompt_sent_at[0]) * 1000)

        # Wait for response to settle
        deadline = time.monotonic() + response_timeout
        while True:
            time.sleep(0.3)
            if time.monotonic() - last_output_at[0] >= SETTLE_TIMEOUT:
                break
            if time.monotonic() > deadline:
                ws.close()
                result["status"] = "TIMEOUT"
                result["error"] = "response did not settle"
                return result

        result["total_ms"] = round((time.monotonic() - prompt_sent_at[0]) * 1000)
        result["preview"] = "".join(output_chunks)[-80:].replace("\n", " ").replace("\r", "").strip()
        result["status"] = "OK"

        ws.close()
        t.join(timeout=2)

    except Exception as e:
        result["status"] = "FAIL"
        result["error"] = str(e)

    return result


def main():
    parser = argparse.ArgumentParser(description="Pi workshop client smoke test")
    parser.add_argument("--url",     default="http://localhost:3000", help="Backend URL")
    parser.add_argument("--n",       type=int, default=10,            help="Concurrent sessions")
    parser.add_argument("--code",    default="workshop2026",          help="Join code")
    parser.add_argument("--prefix",  default="clienttest",            help="Email prefix")
    parser.add_argument("--timeout", type=int, default=60,            help="Response timeout (s)")
    args = parser.parse_args()

    backend_url = args.url.rstrip("/")
    ws_url = backend_url.replace("http://", "ws://").replace("https://", "wss://")

    print(f"=== Pi Workshop Client Smoke Test ===")
    print(f"Server   : {backend_url}")
    print(f"Sessions : {args.n}")
    print(f"Prompt   : {PROMPT!r}")
    print()

    t_wall_start = time.monotonic()
    results = []

    with ThreadPoolExecutor(max_workers=args.n) as pool:
        futures = {
            pool.submit(run_session, i, args.prefix, backend_url, ws_url, args.code, args.timeout): i
            for i in range(1, args.n + 1)
        }
        for future in as_completed(futures):
            r = future.result()
            status = r["status"]
            sid = r["id"]
            if status == "OK":
                print(f"  [{sid:>2}] OK  "
                      f"join={r.get('join_ms','?')}ms  "
                      f"connect={r.get('connect_ms','?')}ms  "
                      f"first_token={r.get('first_token_ms','?')}ms  "
                      f"total={r.get('total_ms','?')}ms  "
                      f"reply={r.get('preview','')!r}")
            else:
                print(f"  [{sid:>2}] {status}  {r.get('error','')}")
            results.append(r)

    wall_s = time.monotonic() - t_wall_start

    ok      = [r for r in results if r["status"] == "OK"]
    fail    = [r for r in results if r["status"] == "FAIL"]
    timeout = [r for r in results if r["status"] == "TIMEOUT"]

    print()
    print(f"=== Results  (wall time: {wall_s:.1f}s) ===")
    print(f"  OK      : {len(ok)} / {args.n}")
    print(f"  TIMEOUT : {len(timeout)} / {args.n}")
    print(f"  FAIL    : {len(fail)} / {args.n}")

    if ok:
        def stats(vals):
            return f"min={min(vals)}ms  avg={int(sum(vals)/len(vals))}ms  max={max(vals)}ms"

        joins   = [r["join_ms"]        for r in ok if "join_ms"        in r]
        conns   = [r["connect_ms"]     for r in ok if "connect_ms"     in r]
        firsts  = [r["first_token_ms"] for r in ok if "first_token_ms" in r]
        totals  = [r["total_ms"]       for r in ok if "total_ms"       in r]

        print()
        print("  Timing across OK sessions:")
        if joins:   print(f"    Join          : {stats(joins)}")
        if conns:   print(f"    WS connect    : {stats(conns)}")
        if firsts:  print(f"    First token   : {stats(firsts)}")
        if totals:  print(f"    Total response: {stats(totals)}")

    print()
    if fail or timeout:
        print(f"FAILED: {len(fail)+len(timeout)} session(s) did not complete.")
        sys.exit(1)
    else:
        print("PASSED.")


if __name__ == "__main__":
    main()
