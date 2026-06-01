# Task Planning Guide for GAISE26 Pi Workshop

This document is written for an AI assistant helping to design, refine, or extend the hands-on tasks for the GAISE26 workshop. It describes the participant environment, constraints, current tasks, and how to add new material.

---

## What participants experience

Each participant gets a private Docker container accessed via a two-pane browser terminal at `https://pi.aistico.com`:

- **Left pane (agent)** — interactive chat with the `pi` coding agent. Participants type here, pi responds, writes code, runs it, and shows results inline.
- **Right pane (work)** — read-only live log of pi's tool calls (what it is actually doing behind the scenes). Educational — shows file writes, shell commands, etc.

There is no IDE, no file browser, no Jupyter. Everything happens through conversational interaction with pi in the terminal. Pi can write files, run Python/shell, and read results — it is a fully capable agent in a sandboxed Linux environment.

Session length: ~60–90 minutes of hands-on time. Participants have varying technical backgrounds (assume GAISE conference audience: statistics educators, data scientists, some programmers, some not).

---

## Container environment

### OS and shell
- Debian slim base, non-root user `agent`
- Working directory: `/home/agent/work` (tmpfs, max 256 MB, wiped on container reset)
- Home: `/home/agent`

### Pre-installed tools (no internet needed)
| Tool | Use |
|------|-----|
| Python 3 + pip | scripting |
| pandas | dataframes |
| duckdb | in-process SQL on files |
| sqlite3 (cli + python) | lightweight databases |
| requests | HTTP calls (only OpenRouter reachable) |
| numpy, scipy | if needed for numerical tasks |
| ripgrep (`rg`) | fast file search |
| fd | fast file find |
| tmux | terminal multiplexing (transparent to participant) |
| Node.js 22 | JavaScript runtime |
| curl, wget | HTTP (only OpenRouter reachable) |
| build-essential | compiling C/C++ if needed |

### What is NOT available
- PyPI / npm during the session (no live internet except OpenRouter)
- Docker, root access, persistent disk
- A display / matplotlib GUI — plots must be text-based, saved as files, or described

### Egress firewall
Containers can only reach `openrouter.ai`. All other outbound traffic is blocked. **Tasks must not require downloading data or packages at runtime.**

### LLM
- Model: `openrouter/moonshotai/kimi-k2.5` (or configured substitute)
- Each container uses a capped OpenRouter key (~$0.10–0.50 budget). Pi makes direct API calls; there is no proxy.
- Token cost matters for task design. Avoid tasks that require many long back-and-forth exchanges or large context (e.g. don't ask pi to read a 10 MB CSV line by line).

---

## File structure inside the container

```
/home/agent/work/           ← participant's working directory (tmpfs)
├── AGENTS.md               ← pi's system prompt / role definition (editable)
├── SOUL.md                 ← pi's personality/style guidance (editable)
├── MEMORY.md               ← pi's persistent memory across turns (editable, starts empty)
├── task.md                 ← the hands-on task sheet shown/described to participants
└── data/
    ├── sample.csv          ← main dataset (10 rows: id, name, value, category)
    └── pr107.tsp           ← TSP instance (107 cities, TSPLIB format)
```

**All files are editable by pi and by the participant.** On container reset, everything is restored from the seed image — fresh start.

Pi reads `AGENTS.md`, `SOUL.md`, and `MEMORY.md` at startup only. Editing them mid-session has no effect until the container is reset.

---

## How tasks are delivered

There is no automatic task injection. The participant:
1. Reads `task.md` (pi can display it: `cat task.md`)
2. Works through it by chatting with pi
3. Can go off-script whenever they like

`AGENTS.md` shapes pi's role and capabilities. `SOUL.md` shapes pi's tone and teaching style. Together they frame every interaction.

**To add a new task or change the theme**, edit:
- `fixtures/task.md` — the task sheet
- `fixtures/AGENTS.md` — if the role needs to change (e.g. "data analyst" vs "optimization assistant")
- `fixtures/SOUL.md` — if the tone needs to change
- `fixtures/data/` — add any data files the task needs

Rebuild the Docker image (`docker build -t pi-workshop -f docker/Dockerfile .`) to bake in changes. Running containers are unaffected until reset.

---

## Current tasks (as of GAISE26)

These four tasks are embedded in `task.md` or described in the workshop slide deck:

### 1. Modify SOUL.md — "teach pi to be you"
Participants edit `SOUL.md` to change pi's personality (e.g. more formal, more playful, a different domain expert). Then they reset their container and notice the change. Teaches: agents are shaped by their prompts; behavior is a design choice.

### 2. Data exploration — `sample.csv`
Classic stats workflow guided by pi:
- Explore structure (rows, columns, types)
- Summarize (min, max, mean of `value`)
- Group by `category`, compute averages
- Filter rows above the mean
- Bonus: describe a bar chart

Teaches: how an LLM agent writes and executes code, how to iterate, how to read agent-generated Python.

### 3. TSP — `pr107.tsp`
Participants ask pi to solve the 107-city Travelling Salesman Problem in `data/pr107.tsp` (TSPLIB format). Pi must parse the file, implement a heuristic (nearest-neighbour, 2-opt, etc.), and report the tour length. Teaches: agent as an algorithm developer; open-ended problem solving.

### 4. Upload your own data — build a custom tool
Participant uploads a CSV from their own work via the "upload" button in the browser UI (POST /upload → docker exec + stdin → `/home/agent/work/data/<filename>`). They then ask pi to build a tool (a Python script or shell command) tailored to their data. Teaches: the agent as a personal analyst; bringing real problems to the agent.

---

## What makes a good workshop task

- **Self-contained**: all required data is in `fixtures/data/` or uploadable. No live downloads.
- **Conversational entry point**: starts with one natural sentence ("Ask pi to..."). No setup steps.
- **Layered difficulty**: a basic version anyone can do in 10 min + an extension for faster participants.
- **Shows agent value**: the task should be noticeably easier with pi than without. Avoid trivial one-liners.
- **Token-efficient**: a full task run should stay under ~2000 tokens total (model input + output). Avoid large context windows.
- **Recoverable**: if a participant gets stuck or breaks something, container reset restores everything. Tasks should not require state that survives a reset.
- **Platform-agnostic content**: the learning objective should make sense even if run as Plan C (pi locally on a laptop). Infrastructure is just delivery.

---

## How to add new material

### Add a data file
Drop it in `fixtures/data/`. Reference it in `task.md` by its filename. Rebuild the image.

### Add a new task variant
Edit `fixtures/task.md`. The file is markdown — use headers and numbered lists. Keep it under one screen of text so participants aren't overwhelmed. You can include multiple tasks with a "choose your own" structure.

### Change pi's role
Edit `fixtures/AGENTS.md`. This is pi's system prompt. Keep it short (under 20 lines). Specify: what the agent is, what it prefers to use (tools, language), where files live, any constraints.

### Add a pi extension (advanced)
The file `fixtures/.pi/extensions/activity-log.ts` is already loaded. It logs every tool call to `.activity.log`, which the right pane displays. You can add more extensions here — they run inside pi's Node process. See pi's extension API docs.

### Change the task mid-workshop (live)
Not possible without rebuilding the image and resetting containers. Plan tasks in advance. For quick guidance changes, the operator can use `./admin tail <email>` to see what a participant is doing and intervene via a side channel (Slack, walk over).

---

## Constraints and trade-offs to keep in mind

| Constraint | Implication for task design |
|------------|----------------------------|
| 256 MB tmpfs work dir | Don't ask pi to download or generate large files |
| No display | No matplotlib pop-ups; use `savefig()` or text output |
| No internet (except OpenRouter) | All data must be pre-baked or uploaded by participant |
| Capped LLM key | Limit back-and-forth; avoid "keep going until perfect" prompts |
| ~60 min hands-on | 2–3 tasks max; one main + one extension is ideal |
| Mixed technical level | Tasks need a low floor (anyone can start) and high ceiling (experts stay engaged) |
| No persistence across resets | Tasks should not build on previous sessions' state |
| Participants share a server | Token concurrency matters; avoid tasks that generate very long outputs simultaneously |
