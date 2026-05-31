# Pi Workshop Platform

Live in-person workshop platform for ~40 concurrent participants. Each participant gets a sandboxed Docker container running the [pi coding agent](https://pi.dev), accessible via a two-pane browser terminal. Single Linux host, 90-minute session.

---

## Architecture

```
Browser (xterm.js, 2 panes)
       │  WebSocket (session token)
       ▼
Backend (Node/TypeScript)          Docker pool
  email → container map     ──►   warm containers
  WS reverse-proxy                assign on join
       │                                │
       │  (proxied WS)                  ▼
       └───────────────►  container (per participant)
                            tmux: [agent] pi TUI  ← writable
                                   [work]  watch  ← read-only
                            ttyd ×2 (internal network only)
                                   │
                                   ▼
                             OpenAI-compatible API
```

Three components:

| Component | What it does |
|---|---|
| **Container image** (`pi-workshop`) | Runs pi in tmux with two ttyd-served panes. Non-root, tmpfs work dir, no published ports. |
| **Backend** (`backend/`) | HTTP + WebSocket server. Manages the container pool, maps emails to sessions, proxies browser WebSockets to ttyd. |
| **Frontend** (`frontend/index.html`) | Single static HTML file. Join screen + two xterm.js panes + reconnect logic. No build step. |

---

## Repository layout

```
docker/
  Dockerfile        # pi-workshop container image
  entrypoint.sh     # starts tmux + both ttyd instances
fixtures/           # baked into the image; swap for your real task
  AGENTS.md         # pi's system instructions
  SOUL.md           # pi's personality/style
  task.md           # the hands-on task shown to participants
  data/sample.csv   # dataset
backend/
  src/
    index.ts        # HTTP server, WS upgrade routing, startup/shutdown
    sessions.ts     # in-memory email→session map, rate-limiting, reconnect
    pool.ts         # Docker pool: warm, assign, kill, resource limits
    proxy.ts        # WS reverse-proxy implementing ttyd binary protocol
    admin.ts        # admin API route handlers
  .env.example      # copy to .env and fill in
  Dockerfile        # backend container image (for docker compose)
frontend/
  index.html        # single-file UI; xterm.js via CDN
scripts/
  run-one.sh        # run a single container locally (no backend)
  hardening.sh      # iptables egress allowlist (OpenRouter only)
  load-test.sh      # 50-session concurrent load test
admin               # bash CLI: warm / status / reset / tail
docker-compose.yml  # local dev stack (POOL_SIZE=1)
```

---

## Getting started

### Prerequisites

- Docker
- Node 22+ (for running the backend outside Docker)
- `jq` (for the `admin` CLI)

### 1. Build the workshop image

```bash
docker build -t pi-workshop -f docker/Dockerfile .
```

This bakes in the fixtures and pre-installs all Python/Node deps so containers start instantly with no live downloads.

### 2. Try a single container (no backend needed)

The fastest way to verify the image works:

```bash
OPENAI_API_KEY=sk-...  PI_MODEL=gpt-4o-mini  ./scripts/run-one.sh
```

Opens:
- `http://localhost:7681` — agent pane (interactive)
- `http://localhost:7682` — work/activity pane (read-only)

### 3. Run the full local stack

```bash
cp backend/.env.example .env
# Edit .env — set PI_MODEL, OPENAI_API_KEY, OPENAI_BASE_URL
docker compose up
```

`docker-compose.yml` hard-sets `POOL_SIZE=1` so only one container is warmed. Open `http://localhost:3000`, join with `workshop2026`.

### 4. Run the backend directly (production-like)

```bash
cd backend
npm install
cp .env.example .env   # edit as needed
npm start
```

---

## Configuration (`.env`)

| Variable | Required | Description |
|---|---|---|
| `PI_MODEL` | yes | Model ID, e.g. `gpt-4o-mini`, `moonshotai/kimi-k2` |
| `OPENAI_API_KEY` | yes* | API key. Use this or `OPENAI_KEY_FILE`. |
| `OPENAI_KEY_FILE` | yes* | Path to file with one key per line (round-robined across containers). |
| `OPENAI_BASE_URL` | no | API base URL. Default: `https://api.openai.com/v1` |
| `JOIN_CODE` | no | Code participants enter to join. Default: `workshop2026` |
| `ADMIN_TOKEN` | no | Token for admin API/CLI. **Change before a real session.** |
| `POOL_SIZE` | no | Containers to pre-warm. Default: `40` |
| `PORT` | no | Backend port. Default: `3000` |

Works with any OpenAI-compatible API: OpenAI, OpenRouter, Ollama, LM Studio, etc.

---

## Admin CLI

```bash
# Set token once
echo "your-admin-token" > .admin_token

./admin warm 40          # pre-warm N containers
./admin status           # list active sessions
./admin reset user@x.com # kill + fresh container for one participant
./admin tail  user@x.com # stream their activity log
```

---

## Workshop day checklist

```bash
# 1. Create capped API key(s) on your provider dashboard
# 2. Set keys and model in .env / keys.txt
# 3. Build the image
docker build -t pi-workshop -f docker/Dockerfile .

# 4. Apply egress firewall (as root, after network is created)
sudo ./scripts/hardening.sh

# 5. Warm the pool
./admin warm 40

# 6. Verify
./admin status

# 7. After the session — delete the API key(s) on the provider dashboard
```

---

## Security notes

- Containers run non-root with `--cap-drop ALL`, 1 GB RAM, 0.5 CPU, 200 PID limit, and a size-capped tmpfs for the work directory.
- ttyd binds to `0.0.0.0` inside the container but **no ports are published** to the host. Containers sit on an internal `workshop` Docker bridge; only the backend can reach them.
- The egress firewall (`scripts/hardening.sh`) allows only HTTPS to the LLM API. All other outbound traffic from containers is dropped.
- Each participant's WebSocket is authorized by a session token. Tokens are not guessable and are scoped to one container.
- The budget cap on the API key is the hard kill switch for runaway agents.
