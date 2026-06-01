#!/usr/bin/env bash
# Smoke test: N concurrent sessions each sending one real prompt to the LLM.
# Verifies that concurrent sessions work and respond in reasonable time.
#
# Usage: ./scripts/smoke-test.sh [N] [BACKEND_URL] [JOIN_CODE]
#   N            number of concurrent sessions (default: 10)
#   BACKEND_URL  (default: http://localhost:3000)
#   JOIN_CODE    (default: workshop2026)
#
# Requires: python3, websocket-client (pip3 install websocket-client)
#
# Cost estimate: each session sends one short prompt (~20 tokens in, ~10 out).
# 10 sessions ≈ 300 tokens total — negligible on any provider.

set -euo pipefail

N="${1:-10}"
BACKEND_URL="${2:-http://localhost:3000}"
JOIN_CODE="${3:-workshop2026}"

WS_URL="${BACKEND_URL/http:/ws:}"
WS_URL="${WS_URL/https:/wss:}"

echo "=== Pi Workshop Smoke Test ==="
echo "Sessions : $N"
echo "Backend  : $BACKEND_URL"
echo "Join code: $JOIN_CODE"
echo ""

if ! python3 -c "import websocket" 2>/dev/null; then
  echo "Error: websocket-client not installed. Run: pip3 install websocket-client" >&2
  exit 1
fi

TMPDIR_ST="$(mktemp -d)"
trap "rm -rf $TMPDIR_ST" EXIT

cat > "$TMPDIR_ST/session.py" << 'PYEOF'
import sys, json, time, threading
import urllib.request
import websocket

# A prompt that produces a very short, deterministic answer.
# Low token count; works with any model.
PROMPT = "Reply with exactly one word: READY"

# How long to wait for the first output after sending the prompt
FIRST_OUTPUT_TIMEOUT = 60   # seconds (cold model load can be slow)
# How long to wait for output to stop flowing (response complete)
SETTLE_TIMEOUT = 5          # seconds of silence = response done

def run_session(session_id, backend_url, ws_url, join_code):
    result_file = f"/tmp/st_result_{session_id}"
    email = f"smoketest-{session_id}@workshop.test"

    t_start = time.time()

    # --- Join ---
    try:
        data = json.dumps({"email": email, "code": join_code}).encode()
        req = urllib.request.Request(
            f"{backend_url}/join",
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = json.loads(resp.read())
        token = body.get("token")
        if not token:
            open(result_file, "w").write(f"FAIL join: {body}")
            return
    except Exception as e:
        open(result_file, "w").write(f"FAIL join: {e}")
        return

    t_joined = time.time()

    # --- WebSocket ---
    output_buf = []
    first_output = threading.Event()
    last_output_at = [0.0]
    ws_error = [None]
    prompt_sent_at = [0.0]

    def on_message(ws, message):
        if isinstance(message, bytes) and len(message) > 1 and message[0] == 0x30:
            text = message[1:].decode("utf-8", errors="replace")
            output_buf.append(text)
            last_output_at[0] = time.time()
            if not first_output.is_set():
                first_output.set()

    def on_error(ws, error):
        ws_error[0] = str(error)
        first_output.set()

    def on_open(ws):
        # Send resize
        resize = json.dumps({"columns": 200, "rows": 50}).encode()
        ws.send(bytes([0x31]) + resize, websocket.ABNF.OPCODE_BINARY)

    try:
        ws = websocket.WebSocketApp(
            f"{ws_url}/ws/agent/{token}",
            subprotocols=["tty"],
            on_message=on_message,
            on_error=on_error,
            on_open=on_open,
        )
        t = threading.Thread(target=ws.run_forever, kwargs={"ping_interval": 0})
        t.daemon = True
        t.start()

        # Wait for pi's initial TUI to render (first output from the container)
        if not first_output.wait(timeout=FIRST_OUTPUT_TIMEOUT):
            ws.close()
            open(result_file, "w").write("TIMEOUT waiting for pi to start")
            return

        if ws_error[0]:
            open(result_file, "w").write(f"FAIL ws: {ws_error[0]}")
            return

        # Let the TUI settle before typing
        time.sleep(1.5)
        first_output.clear()
        output_buf.clear()

        # --- Send prompt ---
        prompt_sent_at[0] = time.time()
        encoded = PROMPT.encode("utf-8")
        ws.send(bytes([0x30]) + encoded, websocket.ABNF.OPCODE_BINARY)
        # Send Enter
        ws.send(bytes([0x30]) + b"\r", websocket.ABNF.OPCODE_BINARY)

        # Wait for first output after prompt
        if not first_output.wait(timeout=FIRST_OUTPUT_TIMEOUT):
            ws.close()
            open(result_file, "w").write("TIMEOUT waiting for LLM response")
            return

        t_first_response = time.time()

        # Wait for output to settle (no new data for SETTLE_TIMEOUT seconds)
        while True:
            time.sleep(0.5)
            if time.time() - last_output_at[0] >= SETTLE_TIMEOUT:
                break
            if time.time() - prompt_sent_at[0] > FIRST_OUTPUT_TIMEOUT:
                ws.close()
                open(result_file, "w").write("TIMEOUT waiting for response to settle")
                return

        t_done = time.time()
        ws.close()
        t.join(timeout=2)

    except Exception as e:
        open(result_file, "w").write(f"FAIL ws: {e}")
        return

    latency_first = round(t_first_response - prompt_sent_at[0], 2)
    latency_total = round(t_done - prompt_sent_at[0], 2)
    output_preview = "".join(output_buf)[-120:].replace("\n", " ").replace("\r", "").strip()

    open(result_file, "w").write(
        f"OK first={latency_first}s total={latency_total}s preview={output_preview!r}"
    )

if __name__ == "__main__":
    run_session(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4])
PYEOF

echo "Sending prompt to $N concurrent sessions: \"$( python3 -c "print('Reply with exactly one word: READY')")\""
echo "Waiting for responses (up to 60s per session)..."
echo ""

START_TIME="$(date +%s)"
rm -f /tmp/st_result_*

seq 1 "$N" | xargs -P "$N" -I{} python3 "$TMPDIR_ST/session.py" {} "$BACKEND_URL" "$WS_URL" "$JOIN_CODE"

END_TIME="$(date +%s)"
ELAPSED=$((END_TIME - START_TIME))

OK=0; FAIL=0; TIMEOUT=0
LATENCIES=()

for i in $(seq 1 "$N"); do
  f="/tmp/st_result_${i}"
  if [[ -f "$f" ]]; then
    result="$(cat "$f")"
    if [[ "$result" == OK* ]]; then
      ((OK++))
      # Extract first-token latency for summary
      lat=$(echo "$result" | grep -oP 'first=\K[0-9.]+')
      LATENCIES+=("$lat")
      echo "  [session $i] $result"
    elif [[ "$result" == TIMEOUT* ]]; then
      ((TIMEOUT++))
      echo "  [session $i] TIMEOUT: $result"
    else
      ((FAIL++))
      echo "  [session $i] FAIL: $result"
    fi
  else
    ((FAIL++))
    echo "  [session $i] FAIL: no result"
  fi
done

echo ""
echo "=== Results (wall time: ${ELAPSED}s) ==="
echo "  OK      : $OK / $N"
echo "  TIMEOUT : $TIMEOUT / $N"
echo "  FAIL    : $FAIL / $N"

if [[ ${#LATENCIES[@]} -gt 0 ]]; then
  # Min/max of first-token latencies using python
  python3 - "${LATENCIES[@]}" << 'PYEOF'
import sys
vals = [float(x) for x in sys.argv[1:]]
print(f"  First-token latency: min={min(vals):.2f}s  max={max(vals):.2f}s  avg={sum(vals)/len(vals):.2f}s")
PYEOF
fi

echo ""
echo "=== Host resources ==="
echo "Load average : $(cut -d' ' -f1-3 /proc/loadavg)"
free -h | grep Mem:

echo ""
if [[ $FAIL -gt 0 || $TIMEOUT -gt 0 ]]; then
  echo "Smoke test FAILED: $((FAIL + TIMEOUT)) session(s) did not complete."
  exit 1
else
  echo "Smoke test PASSED."
fi
