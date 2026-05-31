#!/bin/bash
set -e

# Copy seed fixtures to writable work dir (work dir is tmpfs at runtime)
if [ ! -d /home/agent/work ]; then
  mkdir -p /home/agent/work
fi
cp -r /home/agent/work-seed/. /home/agent/work/

# Start tmux session with agent window
tmux new-session -d -s s -n agent

# Launch pi in agent window
tmux send-keys -t s:agent \
  "cd /home/agent/work && OPENAI_BASE_URL=\"${OPENAI_BASE_URL}\" OPENAI_API_KEY=\"${OPENAI_API_KEY}\" PI_MODEL=\"${PI_MODEL}\" pi" \
  C-m

# Brief pause so pi can initialize before ttyd attaches
sleep 2

# Create work window with live activity view
tmux new-window -t s -n work
tmux send-keys -t s:work \
  "cd /home/agent/work && watch -n 1 -t 'ls -la; echo; tail -n 60 .activity.log 2>/dev/null'" \
  C-m

# ttyd for agent pane (writable) — bind 0.0.0.0 so backend can reach over Docker network
# Do NOT publish ports; container is on internal workshop network only
ttyd --writable -p 7681 -t fontSize=14 tmux attach-session -t s:agent &
TTYD_AGENT_PID=$!

# ttyd for work pane (read-only — no --writable flag)
ttyd -p 7682 -t fontSize=14 tmux attach-session -t s:work &
TTYD_WORK_PID=$!

# Keep PID 1 alive; SIGTERM propagates to children via trap
trap 'kill $TTYD_AGENT_PID $TTYD_WORK_PID 2>/dev/null; tmux kill-server 2>/dev/null; exit 0' TERM INT

wait
