#!/usr/bin/env bash
# Smoke test suite: named concurrent LLM sessions to verify the platform.
# Each scenario joins N sessions simultaneously, sends one short prompt,
# and measures first-token and total response latency.
#
# Usage:
#   ./scripts/smoke-test.sh                   # run all scenarios (skips 'full')
#   ./scripts/smoke-test.sh single            # run one named scenario
#   ./scripts/smoke-test.sh classroom full    # run specific scenarios
#   ./scripts/smoke-test.sh --list            # print available scenarios
#
# Named scenarios:
#   single      1 session  — baseline, full stack end-to-end
#   handful     5 sessions — first sign of concurrency pressure
#   classroom  10 sessions — representative workshop slice
#   full       40 sessions — complete workshop simulation (more tokens)
#
# Requires: python3, websocket-client (pip3 install websocket-client)
# Token cost: ~30 tokens/session. classroom ≈ 300 tokens, full ≈ 1200 tokens.

set -euo pipefail

BACKEND_URL="${BACKEND_URL:-http://localhost:3000}"
JOIN_CODE="${JOIN_CODE:-workshop2026}"
ADMIN_TOKEN="${ADMIN_TOKEN:-$(cat .admin_token 2>/dev/null || echo 'change-me-before-session')}"

WS_URL="${BACKEND_URL/http:/ws:}"
WS_URL="${WS_URL/https:/wss:}"

# ---------------------------------------------------------------------------
# Scenario definitions: name, concurrency, description
# ---------------------------------------------------------------------------
declare -A SCENARIO_N
declare -A SCENARIO_DESC
declare -a SCENARIO_ORDER

add_scenario() { # name N description
  SCENARIO_ORDER+=("$1")
  SCENARIO_N["$1"]="$2"
  SCENARIO_DESC["$1"]="$3"
}

add_scenario single    1  "Baseline — one participant, full stack end-to-end"
add_scenario handful   5  "Small group — first sign of concurrency pressure"
add_scenario classroom 10 "Workshop slice — representative concurrent load"
add_scenario full      40 "Full capacity — complete workshop simulation (~1200 tokens)"

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--list" ]]; then
  echo "Available scenarios:"
  for name in "${SCENARIO_ORDER[@]}"; do
    printf "  %-12s  N=%-3s  %s\n" "$name" "${SCENARIO_N[$name]}" "${SCENARIO_DESC[$name]}"
  done
  exit 0
fi

if [[ $# -gt 0 ]]; then
  # Run only named scenarios
  RUN_SCENARIOS=("$@")
else
  # Default: all except 'full' (saves tokens)
  RUN_SCENARIOS=("single" "handful" "classroom")
fi

# Validate names
for name in "${RUN_SCENARIOS[@]}"; do
  if [[ -z "${SCENARIO_N[$name]+x}" ]]; then
    echo "Error: unknown scenario '$name'. Run with --list to see options." >&2
    exit 1
  fi
done

# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------
if ! python3 -c "import websocket" 2>/dev/null; then
  echo "Error: websocket-client not installed. Run: pip3 install websocket-client" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Kill all running pi-workshop containers (stale from previous runs)
cleanup_containers() {
  local ids
  ids="$(docker ps -q --filter ancestor=pi-workshop 2>/dev/null || true)"
  if [[ -n "$ids" ]]; then
    local count
    count=$(echo "$ids" | wc -w)
    echo "  Removing $count stale pi-workshop container(s)…"
    echo "$ids" | xargs docker rm -f >/dev/null 2>&1 || true
  fi
}

# Warm N containers via admin API and wait until they show up in docker ps
warm_containers() {
  local n="$1"
  echo "  Warming $n container(s)…"
  curl -sf -X POST "$BACKEND_URL/admin/warm" \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"count\": $n}" >/dev/null 2>&1 || true

  # Poll until N containers are running (up to 120s)
  local deadline=$(( $(date +%s) + 120 ))
  while true; do
    local running
    running=$(docker ps -q --filter ancestor=pi-workshop 2>/dev/null | wc -w)
    if [[ "$running" -ge "$n" ]]; then
      echo "  $running container(s) ready."
      break
    fi
    if [[ $(date +%s) -ge $deadline ]]; then
      echo "  Warning: only $running/$n containers ready after 120s — proceeding anyway."
      break
    fi
    sleep 2
  done
}

# Wait for backend HTTP to be up
wait_for_backend() {
  echo -n "  Waiting for backend…"
  local deadline=$(( $(date +%s) + 30 ))
  until curl -sf "$BACKEND_URL/" >/dev/null 2>&1; do
    if [[ $(date +%s) -ge $deadline ]]; then
      echo " timeout."
      echo "Error: backend at $BACKEND_URL is not responding." >&2
      exit 1
    fi
    echo -n "."
    sleep 1
  done
  echo " up."
}

# ---------------------------------------------------------------------------
# Per-session Python worker (written once, reused across scenarios)
# ---------------------------------------------------------------------------
TMPDIR_ST="$(mktemp -d)"
trap "rm -rf $TMPDIR_ST" EXIT

cat > "$TMPDIR_ST/session.py" << 'PYEOF'
import sys, json, time, threading
import urllib.request
import websocket

PROMPT = "Reply with exactly one word: READY"
FIRST_OUTPUT_TIMEOUT = 60
SETTLE_TIMEOUT = 5

def run_session(session_id, prefix, backend_url, ws_url, join_code):
    result_file = f"/tmp/st_result_{prefix}_{session_id}"
    email = f"{prefix}-{session_id}@workshop.test"

    # Stagger joins slightly so they don't all hit the backend at the same ms.
    # (In real use each participant has their own IP; the rate limit is per-IP.)
    time.sleep(int(session_id) * 0.1)

    # Join
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
            open(result_file, "w").write(f"FAIL join: {body}")
            return
    except Exception as e:
        open(result_file, "w").write(f"FAIL join: {e}")
        return

    # WebSocket
    output_buf = []
    first_output = threading.Event()
    last_output_at = [0.0]
    ws_error = [None]
    prompt_sent_at = [0.0]

    def on_message(ws, message):
        if isinstance(message, bytes) and len(message) > 1 and message[0] == 0x30:
            output_buf.append(message[1:].decode("utf-8", errors="replace"))
            last_output_at[0] = time.time()
            if not first_output.is_set():
                first_output.set()

    def on_error(ws, error):
        ws_error[0] = str(error)
        first_output.set()

    def on_open(ws):
        resize = json.dumps({"columns": 200, "rows": 50}).encode()
        ws.send(bytes([0x31]) + resize, websocket.ABNF.OPCODE_BINARY)

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
        if not first_output.wait(timeout=FIRST_OUTPUT_TIMEOUT):
            ws.close()
            open(result_file, "w").write("TIMEOUT waiting for pi to start")
            return
        if ws_error[0]:
            open(result_file, "w").write(f"FAIL ws: {ws_error[0]}")
            return

        time.sleep(1.5)
        first_output.clear()
        output_buf.clear()

        # Send prompt
        prompt_sent_at[0] = time.time()
        ws.send(bytes([0x30]) + PROMPT.encode("utf-8"), websocket.ABNF.OPCODE_BINARY)
        ws.send(bytes([0x30]) + b"\r", websocket.ABNF.OPCODE_BINARY)

        # Wait for first response token
        if not first_output.wait(timeout=FIRST_OUTPUT_TIMEOUT):
            ws.close()
            open(result_file, "w").write("TIMEOUT waiting for LLM response")
            return

        t_first = time.time()

        # Wait for response to settle
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

    preview = "".join(output_buf)[-120:].replace("\n", " ").replace("\r", "").strip()
    open(result_file, "w").write(
        f"OK first={round(t_first - prompt_sent_at[0], 2)}s"
        f" total={round(t_done - prompt_sent_at[0], 2)}s"
        f" preview={preview!r}"
    )

if __name__ == "__main__":
    run_session(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5])
PYEOF

# ---------------------------------------------------------------------------
# Run scenarios
# ---------------------------------------------------------------------------
echo "=== Pi Workshop Smoke Test Suite ==="
echo "Backend  : $BACKEND_URL"
echo "Scenarios: ${RUN_SCENARIOS[*]}"
echo ""

wait_for_backend

SUITE_OK=0
SUITE_FAIL=0
declare -a SUMMARY_LINES

for SCENARIO in "${RUN_SCENARIOS[@]}"; do
  N="${SCENARIO_N[$SCENARIO]}"
  DESC="${SCENARIO_DESC[$SCENARIO]}"
  PREFIX="smoke-${SCENARIO}"

  echo "--- $SCENARIO (N=$N) ---"
  echo "  $DESC"

  # Clean up stale containers from any previous run
  cleanup_containers

  # Warm enough containers for this scenario
  warm_containers "$N"

  # Clean up any leftover result files for this scenario
  rm -f /tmp/st_result_${PREFIX}_*

  echo "  Sending prompt to $N session(s) concurrently…"
  SCENARIO_START="$(date +%s)"

  seq 1 "$N" | xargs -P "$N" -I{} \
    python3 "$TMPDIR_ST/session.py" {} "$PREFIX" "$BACKEND_URL" "$WS_URL" "$JOIN_CODE"

  SCENARIO_END="$(date +%s)"
  ELAPSED=$(( SCENARIO_END - SCENARIO_START ))

  # Collect results
  OK=0; FAIL=0; TIMEOUT=0
  LATENCIES=()
  for i in $(seq 1 "$N"); do
    f="/tmp/st_result_${PREFIX}_${i}"
    if [[ -f "$f" ]]; then
      result="$(cat "$f")"
      if [[ "$result" == OK* ]]; then
        ((OK++))
        lat=$(echo "$result" | grep -oP 'first=\K[0-9.]+' || echo "0")
        LATENCIES+=("$lat")
        echo "    [session $i] $result"
      elif [[ "$result" == TIMEOUT* ]]; then
        ((TIMEOUT++))
        echo "    [session $i] TIMEOUT: $result"
      else
        ((FAIL++))
        echo "    [session $i] $result"
      fi
    else
      ((FAIL++))
      echo "    [session $i] FAIL: no result"
    fi
  done

  # Latency summary
  LAT_LINE=""
  if [[ ${#LATENCIES[@]} -gt 0 ]]; then
    LAT_LINE=$(python3 - "${LATENCIES[@]}" <<'PYEOF'
import sys
vals = [float(x) for x in sys.argv[1:]]
print(f"first-token min={min(vals):.2f}s avg={sum(vals)/len(vals):.2f}s max={max(vals):.2f}s")
PYEOF
)
  fi

  if [[ $((FAIL + TIMEOUT)) -eq 0 ]]; then
    STATUS="PASS"
    ((SUITE_OK++))
  else
    STATUS="FAIL"
    ((SUITE_FAIL++))
  fi

  RESULT_LINE="  [$STATUS] $SCENARIO (N=$N, ${ELAPSED}s wall) — $OK/$N ok"
  [[ -n "$LAT_LINE" ]] && RESULT_LINE+="  |  $LAT_LINE"
  SUMMARY_LINES+=("$RESULT_LINE")
  echo ""
  echo "$RESULT_LINE"

  # Clean up this scenario's containers before the next run
  echo "  Cleaning up containers…"
  cleanup_containers
  echo ""
done

# ---------------------------------------------------------------------------
# Suite summary
# ---------------------------------------------------------------------------
echo "=== Suite Summary ==="
for line in "${SUMMARY_LINES[@]}"; do
  echo "$line"
done
echo ""
echo "Host resources at end:"
echo "  Load average : $(cut -d' ' -f1-3 /proc/loadavg)"
free -h | grep Mem: | awk '{printf "  Memory       : %s used / %s total\n", $3, $2}'
echo ""

if [[ $SUITE_FAIL -gt 0 ]]; then
  echo "Suite FAILED: $SUITE_FAIL scenario(s) had errors."
  exit 1
else
  echo "Suite PASSED: all ${#RUN_SCENARIOS[@]} scenario(s) completed successfully."
fi
