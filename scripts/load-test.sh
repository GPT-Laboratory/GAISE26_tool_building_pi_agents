#!/usr/bin/env bash
# Load test: simulate N concurrent workshop sessions.
# Each session: join → WebSocket connect → send keystroke → receive output → report.
#
# Usage: ./scripts/load-test.sh [N] [BACKEND_URL] [JOIN_CODE]
#   N            number of concurrent sessions (default: 50)
#   BACKEND_URL  (default: http://localhost:3000)
#   JOIN_CODE    (default: workshop2026)
#
# Requires: python3, websocket-client (pip3 install websocket-client)

set -euo pipefail

N="${1:-50}"
BACKEND_URL="${2:-http://localhost:3000}"
JOIN_CODE="${3:-workshop2026}"

WS_URL="${BACKEND_URL/http:/ws:}"
WS_URL="${WS_URL/https:/wss:}"

echo "=== Pi Workshop Load Test ==="
echo "Sessions : $N"
echo "Backend  : $BACKEND_URL"
echo "Join code: $JOIN_CODE"
echo ""

# Check dependencies
if ! python3 -c "import websocket" 2>/dev/null; then
  echo "Error: websocket-client not installed. Run: pip3 install websocket-client" >&2
  exit 1
fi

TMPDIR_LT="$(mktemp -d)"
trap "rm -rf $TMPDIR_LT" EXIT

# Write the per-session Python script
cat > "$TMPDIR_LT/session.py" << 'PYEOF'
import sys, json, time, threading, struct
import urllib.request, urllib.error
import websocket

def run_session(session_id, backend_url, ws_url, join_code):
    result_file = f"/tmp/lt_result_{session_id}"
    email = f"loadtest-{session_id}@workshop.test"

    # Step 1: Join
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
        token = body["token"]
    except Exception as e:
        open(result_file, "w").write(f"FAIL join: {e}")
        return

    # Step 2: WebSocket connect + receive output
    messages_received = 0
    got_output = threading.Event()
    error_msg = None

    def on_message(ws, message):
        nonlocal messages_received
        if isinstance(message, bytes) and len(message) > 0 and message[0] == 0x01:
            messages_received += 1
            if messages_received >= 3:
                got_output.set()

    def on_error(ws, error):
        nonlocal error_msg
        error_msg = str(error)
        got_output.set()

    def on_open(ws):
        # Send a resize message (type 0x01)
        resize = json.dumps({"columns": 80, "rows": 24}).encode()
        pkt = bytes([0x01]) + resize
        ws.send(pkt, websocket.ABNF.OPCODE_BINARY)
        # Send Enter keystroke (type 0x00)
        pkt2 = bytes([0x00]) + b"\r"
        ws.send(pkt2, websocket.ABNF.OPCODE_BINARY)

    try:
        ws_target = f"{ws_url}/ws/agent/{token}"
        ws = websocket.WebSocketApp(
            ws_target,
            subprotocols=["tty"],
            header={"origin": backend_url},
            on_message=on_message,
            on_error=on_error,
            on_open=on_open,
        )
        t = threading.Thread(target=ws.run_forever, kwargs={"ping_interval": 0})
        t.daemon = True
        t.start()
        got_output.wait(timeout=20)
        ws.close()
        t.join(timeout=2)
    except Exception as e:
        open(result_file, "w").write(f"FAIL ws: {e}")
        return

    if error_msg:
        open(result_file, "w").write(f"FAIL ws error: {error_msg}")
    elif messages_received >= 3:
        open(result_file, "w").write(f"OK msgs={messages_received}")
    else:
        open(result_file, "w").write(f"TIMEOUT msgs={messages_received}")

if __name__ == "__main__":
    run_session(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4])
PYEOF

echo "Starting $N sessions…"
START_TIME="$(date +%s)"

# Clean up any old result files
rm -f /tmp/lt_result_*

# Launch sessions in parallel
seq 1 "$N" | xargs -P "$N" -I{} python3 "$TMPDIR_LT/session.py" {} "$BACKEND_URL" "$WS_URL" "$JOIN_CODE"

END_TIME="$(date +%s)"
ELAPSED=$((END_TIME - START_TIME))

# Collect results
OK=0; FAIL=0; TIMEOUT=0
for i in $(seq 1 "$N"); do
  f="/tmp/lt_result_${i}"
  if [[ -f "$f" ]]; then
    result="$(cat "$f")"
    if [[ "$result" == OK* ]]; then
      ((OK++))
    elif [[ "$result" == TIMEOUT* ]]; then
      ((TIMEOUT++))
      echo "  TIMEOUT session $i: $result"
    else
      ((FAIL++))
      echo "  FAIL session $i: $result"
    fi
  else
    ((FAIL++))
    echo "  FAIL session $i: no result file"
  fi
done

echo ""
echo "=== Results (${ELAPSED}s) ==="
echo "  OK      : $OK / $N"
echo "  TIMEOUT : $TIMEOUT / $N"
echo "  FAIL    : $FAIL / $N"
echo ""

# Host resource snapshot
echo "=== Host resources ==="
echo "Load average: $(cat /proc/loadavg | cut -d' ' -f1-3)"
echo "Memory:"
free -h | grep -E 'Mem:|Swap:'
echo ""

if [[ $FAIL -gt 0 || $TIMEOUT -gt 0 ]]; then
  echo "Load test FAILED: $((FAIL + TIMEOUT)) session(s) did not complete."
  exit 1
else
  echo "Load test PASSED: all $OK sessions completed successfully."
fi
