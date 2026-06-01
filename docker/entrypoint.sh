#!/bin/bash
set -e

# Copy seed fixtures to writable work dir (work dir is tmpfs at runtime)
if [ ! -d /home/agent/work ]; then
  mkdir -p /home/agent/work
fi
cp -r /home/agent/work-seed/. /home/agent/work/

# Lock down files pi should follow but never modify.
# MEMORY.md is intentionally left writable — pi updates it between turns.
chmod 444 /home/agent/work/SOUL.md
chmod 444 /home/agent/work/AGENTS.md
chmod 444 /home/agent/work/task.md

# Run pi directly as the tmux window command (not via send-keys) so the
# invocation and API key are never visible in the terminal scroll buffer.
tmux new-session -d -s s -n agent \
  bash -c "cd /home/agent/work && exec pi --model \"${PI_MODEL}\" --api-key \"${OPENAI_API_KEY}\""

# Brief pause so pi can initialize before ttyd attaches
sleep 2

# Work window: live activity log (written by the activity-log.ts pi extension)
tmux new-window -t s -n work \
  bash -c "cd /home/agent/work && touch .activity.log && exec tail -f .activity.log"

# Create grouped (linked) sessions so each ttyd client has independent window focus.
# Without this, whichever ttyd attaches last sets the active window for ALL clients,
# causing both panes to show the same window.
tmux new-session -d -s agent-view -t s
tmux new-session -d -s work-view  -t s
tmux select-window -t agent-view:agent
tmux select-window -t work-view:work

# ttyd for agent pane (writable) — bind 0.0.0.0 so backend can reach over Docker network
# Do NOT publish ports; container is on internal workshop network only
ttyd --writable -p 7681 -t fontSize=14 tmux attach-session -t agent-view &
TTYD_AGENT_PID=$!

# ttyd for work pane (read-only — no --writable flag)
ttyd -p 7682 -t fontSize=14 tmux attach-session -t work-view &
TTYD_WORK_PID=$!

# Keep PID 1 alive; SIGTERM propagates to children via trap
trap 'kill $TTYD_AGENT_PID $TTYD_WORK_PID 2>/dev/null; tmux kill-server 2>/dev/null; exit 0' TERM INT

wait
