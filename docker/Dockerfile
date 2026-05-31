FROM node:22-slim

# System packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-dev \
    tmux curl wget sqlite3 \
    build-essential ca-certificates \
    procps \
  && rm -rf /var/lib/apt/lists/*

# ttyd static binary (v1.7.7)
RUN curl -fsSL -o /usr/local/bin/ttyd \
    https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 \
  && chmod +x /usr/local/bin/ttyd

# Python deps (pre-baked so agent needs no live installs)
RUN pip3 install --no-cache-dir --break-system-packages \
    pandas duckdb requests

# Pi coding agent
RUN npm install -g @earendil-works/pi-coding-agent

# Non-root user
RUN useradd -m -s /bin/bash agent

# Bake fixtures to work-seed (copied to tmpfs work dir at runtime)
COPY --chown=agent:agent fixtures/ /home/agent/work-seed/

# Pre-init pi config to avoid interactive first-run prompts
RUN su agent -c "pi --version 2>/dev/null || true"

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER agent
WORKDIR /home/agent

EXPOSE 7681 7682

ENTRYPOINT ["/entrypoint.sh"]
