#!/usr/bin/env bash
# Run a single pi-workshop container locally for smoke-testing.
# Publishes ttyd ports directly to localhost — no backend needed.
#
# Usage: ./scripts/run-one.sh
#
# Then open:
#   http://localhost:7681  — agent pane (interactive)
#   http://localhost:7682  — work/activity pane (read-only)
#
# Required env vars (or set them here):
#   OPENAI_API_KEY   your API key
#   OPENAI_BASE_URL  API base URL (default: https://api.openai.com/v1)
#   PI_MODEL         model id (e.g. gpt-4o-mini)

set -euo pipefail

IMAGE="${IMAGE:-pi-workshop}"
OPENAI_API_KEY="${OPENAI_API_KEY:?Set OPENAI_API_KEY}"
OPENAI_BASE_URL="${OPENAI_BASE_URL:-https://api.openai.com/v1}"
PI_MODEL="${PI_MODEL:?Set PI_MODEL (e.g. gpt-4o-mini)}"

# Build the image if it doesn't exist yet
if ! docker image inspect "$IMAGE" &>/dev/null; then
  echo "Image '$IMAGE' not found — building..."
  docker build -t "$IMAGE" -f "$(dirname "$0")/../docker/Dockerfile" "$(dirname "$0")/.."
fi

CONTAINER_NAME="pi-workshop-dev"

# Remove any leftover container from a previous run
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

echo ""
echo "Starting container '$CONTAINER_NAME'..."
echo "  Agent pane  → http://localhost:7681"
echo "  Work pane   → http://localhost:7682"
echo ""
echo "Press Ctrl-C to stop."
echo ""

docker run --rm --name "$CONTAINER_NAME" \
  -e OPENAI_API_KEY="$OPENAI_API_KEY" \
  -e OPENAI_BASE_URL="$OPENAI_BASE_URL" \
  -e PI_MODEL="$PI_MODEL" \
  -p 127.0.0.1:7681:7681 \
  -p 127.0.0.1:7682:7682 \
  "$IMAGE"
