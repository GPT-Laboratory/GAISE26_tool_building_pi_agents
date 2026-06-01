# Quickstart

Three ways to try it locally.

---

## Option A — pi directly (no Docker, no backend)

Fastest way to test fixtures and iterate on the task. Runs pi in your local terminal.

```bash
npm install -g @earendil-works/pi-coding-agent
cp -r fixtures/ ~/pi-workshop-local/
cd ~/pi-workshop-local
pi --model openrouter/moonshotai/kimi-k2.5 --api-key sk-or-v1-...
```

No sandbox. Fine for authoring; not for participants.

---

## Option B — Container only (no backend)

Tests the Docker image and ttyd panes directly in the browser.

```bash
# Build once
docker build -t pi-workshop -f docker/Dockerfile .

# Run (ports published to localhost only)
OPENAI_API_KEY=sk-or-v1-...  PI_MODEL=openrouter/moonshotai/kimi-k2.5  ./scripts/run-one.sh
```

Open:
- `http://localhost:7681` — agent pane (interactive)
- `http://localhost:7682` — activity pane (read-only)

---

## Option C — Full stack, one container

Tests the join flow, browser UI, file upload, and WebSocket proxy end-to-end.

```bash
cp backend/.env.example .env
# Edit .env: set PI_MODEL, OPENAI_API_KEY, OPENAI_BASE_URL

docker build -t pi-workshop -f docker/Dockerfile .       # workshop image (once)
docker network create workshop 2>/dev/null || true        # required before compose up
docker compose up                                         # starts backend with POOL_SIZE=1
```

Open `http://localhost:3000` and join with code `workshop2026`.

`docker-compose.yml` hard-sets `POOL_SIZE=1` so only one container warms up. `frontend/` is
bind-mounted so you can edit `index.html` without rebuilding the backend image.

---

## With a local model (Ollama, LM Studio, etc.)

Add to `.env` (or export before running Option B):

```
OPENAI_BASE_URL=http://host.docker.internal:11434/v1
OPENAI_API_KEY=ollama
PI_MODEL=ollama/llama3.2
```
