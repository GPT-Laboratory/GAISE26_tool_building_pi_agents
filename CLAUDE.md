# CLAUDE.md — GAISE26 Pi Workshop Platform

## Context

A live, in-person workshop platform for **~30 concurrent participants** (warm-start 40). Each participant gets their own sandboxed container running the **pi coding agent** (https://pi.dev), driven from a two-pane web UI. Workship has one ~90-minute slot and the actual hands-on is shorter, no second chances: **reliability and recoverability beat features. Build the boring, robust version.**

Single-host deployment ("monster Linux server"). No public users — only people in the room given a join code.

**KISS is a hard constraint.** Every moving part is a thing that can fail live. Do not add layers that aren't pulling their weight.

## Non-negotiables (do not cut)

1. **Container isolation**: a hostile/runaway agent in one container cannot affect the host, the backend, or other containers.
2. **Capped, disposable LLM keys**: containers get a throwaway OpenRouter key with a hard usage cap, created before the session and deleted after. The cap is the budget control; deleting the key is the kill switch. No proxy layer.
3. **Warm pool**: 40 containers pre-started before doors open. Dynamically cold start during the session if these run out.
4. **Reconnection**: a participant who drops (WiFi flap, IP change, reload) reconnects by email to the *same* running container with state intact.
5. **Admin recovery**: operator can list sessions and reset any one participant (fresh container) without disturbing the others.
6. **Terminal isolation**: web terminals are reachable only through the backend, authorized by session token. Container terminal ports are never publicly exposed.

## Architecture

```
 Browser (xterm.js, 2 panes)
        │  WSS (session token)
        ▼
 Backend router  ──────────────►  Pool manager (Docker)
   email→container map                │ warm 60, assign, health, kill
   WS proxy by token                  ▼
        │                       ┌─────────────────────────┐
        │   (proxied WS)        │ container (per participant)
        └──────────────────────►│  tmux: [agent] pi TUI    │
                                │        [work]  read-only │
                                │  ttyd ×2 (loopback only)  │
                                └───────────┬──────────────┘
                                            │ OpenAI-compatible, capped key
                                            ▼
                                        OpenRouter
```

Three components. The LLM key is just an env var pointing straight at OpenRouter.

## Tech choices (decided — do not re-litigate)

- **Containers**: Docker, one image `pi-workshop`.
- **In-container terminals**: `tmux` + two `ttyd` instances bound to `127.0.0.1` only.
- **LLM**: pi talks directly to OpenRouter via its OpenAI-compatible endpoint, using a capped throwaway key given when container is initialized.
- **Backend**: Node (TypeScript). HTTP + WebSocket. In-memory session map (short-lived session; no DB). WS reverse-proxy to container ttyd.
- **Frontend**: static single page, `xterm.js` via CDN, served by the backend. No build step, no framework.
- **Admin**: a small CLI (`./admin`) + OpenRouter's own usage dashboard for spend. Multiple batches of OpenRouter keys in a file to avoid every container to use the same key.

---

## Component 1 — Container image `pi-workshop`

- Base: slim Linux with Node (for pi), Python 3, `tmux`, `ttyd`.
- Install pi globally (`@earendil-works/pi-coding-agent`).
- **Pre-bake hands-on dependencies** so agent-built tools run with zero live installs: `pandas`, `duckdb`, `sqlite3` (cli + python), `requests`, plus build tools. Add whatever the fixture task needs.
- **Pre-seed the working dir** (`/home/agent/work`): the data fixture, an `AGENTS.md`, `SOUL.md` and `MEMORY.md` for pi, any skill files. (Fixture content is provided separately; the image just expects it at a known path.)
- **Two-pane layout** via one tmux session `s`:
  - window `agent`: pi interactive TUI. Served by `ttyd --writable` → where the participant chats.
  - window `work`: **read-only** live view of pi's activity. Simple version: `watch -n 1 -t 'ls -la; echo; tail -n 60 .activity.log 2>/dev/null'`. Optional upgrade if time allows: a tiny pi extension that streams each tool call to `.activity.log` (cleaner, and a live nod to "pi extends itself"). Served by `ttyd` **without** `--writable`.
- ttyd instances bind to `127.0.0.1` on fixed internal ports; only the backend reaches them over the Docker network.
- **Env contract** (set by pool manager at `docker run`):
  - `OPENAI_BASE_URL` → OpenRouter's OpenAI-compatible endpoint
  - `OPENAI_API_KEY` → the capped throwaway key
  - `PI_MODEL` → the chosen model id (Kimi2.5 or GLM4.7)
- Run as **non-root**; `--read-only` rootfs with a writable mount only for `/home/agent/workXX` + runtime dirs, where XX is the container number.
- Entrypoint: start tmux with both windows + both ttyd instances; keep PID 1 alive; clean shutdown on stop.

## Component 2 — Backend router

- **Join flow**: participant submits email + the join code shown on screen. Validate code (rate-limit attempts). If active sessions ≥ pool size, reject with a clear "room is full" message. Otherwise create or look up the session by email.
- **Session map** (in memory): `email → { sessionToken, containerId, createdAt, lastSeen }`. Email is just an identifier (no verification — fine for a workshop).
- **Reconnection**: same email returns the same container and token; reattaching to the running tmux restores state for free.
- **WS proxy**: two WebSocket routes (agent = read/write, work = read-only), each authorized by session token, proxied to that container's ttyd. **Containers are never addressed directly by the browser.**
- **Pool manager** (Docker API): warm 60 containers on startup; assign one per join and **never reclaim** (nobody leaves a 90-min session); destroy all on shutdown. No autoscaler and **no background health loop** — validate a container is up at assignment time; recover any problem via the reset button. (Expect >60? Warm more up front.)
- **Admin API** (token-protected): list sessions; **reset** a participant (kill + fresh container, same email); tail a session's activity log to help someone stuck.

## Component 3 — Frontend (static + xterm.js)

- **Join screen**: email field + join-code field + Go.
- **Workspace**: two xterm.js panes — left = agent (interactive), right = work (read-only, observe + scroll).
- **Connection states** (explicit, so 50 people aren't confused): connecting / connected / agent working / disconnected–reconnecting / room full.
- **Reset button**: "Restart my agent" → admin reset for that email.
- Assume laptops; panes legible and scrollable.

---

## Security & resource constraints (per container)

- Non-root user; `--cap-drop ALL` (add back only what pi/tmux need); no Docker socket mounted.
- `--memory` (e.g. 1g), `--cpus`, `--pids-limit`; work dir is a **size-capped tmpfs** (no separate disk-quota plumbing).
- **Egress allowlist: OpenRouter only.** Deny all other outbound. (Deps are pre-baked, so no live PyPI/npm is needed.)
- ttyd bound to loopback inside the container; reachable only via the backend.
- Containers are ephemeral; destroyed at session end.

## Operations / admin

- Before session: create the capped throwaway OpenRouter key(s); set `PI_MODEL`.
- `./admin warm N=40` — pre-start the pool.
- `./admin status` — sessions + container health. Spend is watched on OpenRouter's dashboard.
- `./admin reset <email>` — kill + fresh container for one participant.
- `./admin tail <email>` — watch a participant's activity log to help them.
- *Optional:* a **read-only spectator URL** onto the operator's own driver session, for anyone who can't connect. Cut if time is short — same ttyd mechanism, so cheap to add later.
- After session: **delete the key(s)**.

## Build order

0. Container image: pi runs in tmux, two panes work locally, deps pre-baked. Verify by hand.
1. Point a local pi at OpenRouter with a capped key; confirm hitting the cap fails cleanly.
2. Backend: single-container assign + WS proxy of both panes by token; one browser end-to-end.
3. Frontend: join screen + two panes + connection states + reset.
4. Pool manager: warm 60, reconnect-by-email, health, admin API + CLI.
5. Hardening: caps, egress allowlist, non-root, loopback ttyd, terminal-isolation check.
6. **Load test** (write this as a script): simulate 50 concurrent sessions each running a realistic agent task. Confirm (a) host CPU/RAM/PIDs hold, and (b) **a single capped key sustains the concurrency without OpenRouter rate-limit 429s**. If it 429s, split across a handful of keys — no proxy. Size the host from the result.

## Definition of done (must all pass)

- 50 concurrent simulated sessions complete the fixture task within acceptable latency; host stays healthy.
- A single capped key sustains the concurrency without cascading 429s (or it's split across a few keys).
- Killing WiFi to one client and reconnecting (same email) restores that session with state intact.
- A deliberately runaway agent is bounded by the key cap, and the operator can recover that participant via container reset without touching the other 49.
- One participant's terminal cannot be reached or observed using another's token.
- Cold first prompt from the warm pool is effectively instant.

## Out of scope

- Real authentication, email verification, persistence beyond the live session, multi-host scaling, billing, autoscaling. Single host, single session, then delete the keys and tear it all down.
