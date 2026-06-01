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
  file upload endpoint                 │
       │                               ▼
       │  (proxied WS)    container (per participant)
       └─────────────►      tmux: [agent] pi TUI    ← writable
                                   [work]  activity ← read-only
                            ttyd ×2 (internal network only)
                                   │
                                   ▼
                             OpenAI-compatible API
```

Three components:

| Component | What it does |
|---|---|
| **Container image** (`pi-workshop`) | Runs pi in tmux with two ttyd-served panes. Non-root, tmpfs work dir, no published ports. |
| **Backend** (`backend/`) | HTTP + WebSocket server. Manages the container pool, maps emails to sessions, proxies browser WebSockets to ttyd, handles file uploads. |
| **Frontend** (`frontend/index.html`) | Single static HTML file. Join screen + two xterm.js panes + reconnect logic + file upload. No build step. |

---

## Repository layout

```
docker/
  Dockerfile          # pi-workshop container image
  entrypoint.sh       # starts tmux + both ttyd instances
fixtures/             # baked into the image; swap for your real task
  AGENTS.md           # pi's system instructions
  SOUL.md             # pi's personality/style
  MEMORY.md           # pi's persistent memory (starts empty)
  task.md             # the hands-on task shown to participants
  data/sample.csv     # dataset
  .pi/extensions/
    activity-log.ts   # pi extension: logs every tool call/result to .activity.log
backend/
  src/
    index.ts          # HTTP server, WS upgrade routing, file upload, startup/shutdown
    sessions.ts       # in-memory email→session map, rate-limiting, reconnect
    pool.ts           # Docker pool: warm, assign, kill, resource limits
    proxy.ts          # WS reverse-proxy implementing ttyd binary protocol
    admin.ts          # admin API route handlers
  .env.example        # copy to .env and fill in
  Dockerfile          # backend container image (for docker compose)
frontend/
  index.html          # single-file UI; xterm.js via CDN
scripts/
  hardening.sh        # iptables egress allowlist (LLM API only)
  load-test.sh        # 50-session concurrent load test
admin                 # bash CLI: warm / status / reset / tail
docker-compose.yml    # local dev stack (POOL_SIZE=1)
```

---

## Two-pane layout

Each participant sees two terminal panes side by side:

**Left — Agent pane (interactive)**
The pi TUI. The participant types here to chat with the agent. pi is invoked as
`pi --model $PI_MODEL --api-key $OPENAI_API_KEY` directly as the tmux window command, so
the invocation and API key are never visible in the terminal scroll buffer.

**Right — Activity pane (read-only)**
A live feed of every tool call and its output, written by the `activity-log.ts` pi extension
to `.activity.log` and tailed by the pane. Shows what the agent is actually doing in
near-real-time without exposing the chat conversation.

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

Bakes in fixtures and pre-installs all Python/Node deps (pandas, duckdb, requests, ripgrep, fd)
so containers start instantly with no live downloads.

### 2. Try a single container (no backend needed)

```bash
OPENAI_API_KEY=sk-...  PI_MODEL=openrouter/moonshotai/kimi-k2.5  ./scripts/run-one.sh
```

Opens two browser tabs:
- `http://localhost:7681` — agent pane (interactive)
- `http://localhost:7682` — activity pane (read-only)

### 3. Run the full local stack

```bash
cp backend/.env.example .env
# Edit .env — set PI_MODEL, OPENAI_API_KEY, OPENAI_BASE_URL
docker compose up
```

`docker-compose.yml` hard-sets `POOL_SIZE=1` so only one container is warmed. `frontend/` is
bind-mounted so you can edit `index.html` without rebuilding. Open `http://localhost:3000` and
join with `workshop2026`.

### 4. Run the backend directly

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
| `PI_MODEL` | yes | Model ID with provider prefix, e.g. `openrouter/moonshotai/kimi-k2.5` |
| `OPENAI_API_KEY` | yes* | API key. Use this or `OPENAI_KEY_FILE`. |
| `OPENAI_KEY_FILE` | yes* | Path to file with one key per line (round-robined across containers). |
| `OPENAI_BASE_URL` | no | API base URL. Default: `https://api.openai.com/v1` |
| `JOIN_CODE` | no | Code participants enter to join. Default: `workshop2026` |
| `ADMIN_TOKEN` | no | Token for admin API/CLI. **Change before a real session.** |
| `POOL_SIZE` | no | Containers to pre-warm. Default: `40` |
| `PORT` | no | Backend port. Default: `3000` |

Works with any OpenAI-compatible API: OpenAI, OpenRouter, Ollama, LM Studio, etc.

**Model ID format:** pi routes by provider prefix. Be explicit to avoid ambiguity:
- `openrouter/moonshotai/kimi-k2.5`
- `openrouter/google/gemini-2.5-pro`
- `openai/gpt-4o-mini`

---

## File uploads

The UI includes an "Upload file" button that copies any file (up to 20 MB) directly into the
participant's `data/` folder inside their container. The backend writes files via `docker exec`
+ stdin rather than `docker cp`, because the work directory is a tmpfs mount and `docker cp`
silently succeeds without actually writing through to tmpfs.

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

# 4. Warm the pool
./admin warm 40

# 5. (Optional) Apply egress firewall — as root, after the workshop network exists
sudo ./scripts/hardening.sh

# 6. Verify
./admin status

# 7. After the session — delete the API key(s) on the provider dashboard
```

---

## Security notes

- Containers run non-root with `--cap-drop ALL`, 1 GB RAM, 0.5 CPU, 200 PID limit, and a
  size-capped tmpfs for the work directory.
- ttyd binds to `0.0.0.0` inside the container but **no ports are published** to the host.
  Containers sit on an internal `workshop` Docker bridge; only the backend can reach them.
- The egress firewall (`scripts/hardening.sh`) allows only HTTPS to the LLM API. All other
  outbound traffic from containers is dropped.
- Each participant's WebSocket is authorized by a session token. Tokens are not guessable and
  are scoped to one container.
- The budget cap on the API key is the hard kill switch for runaway agents.

---

## Customizing the task

Edit the files in `fixtures/` before building the image:

| File | Purpose |
|---|---|
| `AGENTS.md` | pi's system prompt — describes the agent's role and working directory |
| `SOUL.md` | pi's style/personality |
| `task.md` | The task card in pi's context |
| `data/` | Drop any datasets here; reference them in `AGENTS.md` and `task.md` |
| `.pi/extensions/activity-log.ts` | Logs tool calls/results to `.activity.log`; edit to change what the activity pane shows |

Then rebuild:
```bash
docker build -t pi-workshop -f docker/Dockerfile .
```

---

## Danger zone: run pi without any infrastructure

If you want to try pi with the workshop fixtures on your own machine — no Docker, no backend,
no browser — run it directly. Useful for testing fixtures, authoring tasks, or demoing as a
facilitator.

> **Warning:** there is no sandbox. Do not use this path for untrusted participants.

### Prerequisites

- Node 22+
- An API key for an OpenAI-compatible provider

### Steps

```bash
# 1. Install pi globally
npm install -g @earendil-works/pi-coding-agent

# 2. Copy the fixtures to a working directory
cp -r fixtures/ ~/pi-workshop-local/

# 3. Run pi from that directory
cd ~/pi-workshop-local
pi --model openrouter/moonshotai/kimi-k2.5 --api-key sk-or-v1-...
```

pi auto-discovers the `.pi/extensions/activity-log.ts` extension and logs tool activity to
`.activity.log`. Watch it in a second terminal:

```bash
tail -f ~/pi-workshop-local/.activity.log
```

### With a local model (Ollama)

```bash
# Start Ollama separately, then:
cd ~/pi-workshop-local
pi --model ollama/llama3.2 --api-key ollama
```

### What you lose vs. the full platform

| Feature | Full platform | Direct pi |
|---|---|---|
| Browser terminal | xterm.js in browser | Your local terminal |
| Participant isolation | Docker sandbox | None — runs on your host |
| Activity pane | Separate read-only browser pane | `tail -f .activity.log` manually |
| File upload button | Yes | Drop files into `data/` manually |
| Reconnect / session recovery | Yes | N/A |
| Resource limits (RAM, CPU, PIDs) | Yes (Docker cgroups) | None |
