FROM node:24-bookworm-slim

COPY --from=ghcr.io/astral-sh/uv:0.13.1 /uv /uvx /bin/

ENV DEBIAN_FRONTEND=noninteractive \
    UV_PYTHON_INSTALL_DIR=/opt/uv/python \
    UV_CACHE_DIR=/tmp/uv-cache \
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    NEXT_TELEMETRY_DISABLED=1 \
    PI_WEB_APP_NAME=WorkAgent \
    PI_CODING_AGENT_DIR=/app/.workagent/agent \
    PI_MEMORY_DIR=/app/.workagent/memory \
    PI_MEMORY_EXIT_SUMMARY=off \
    PI_MEMORY_SUMMARIZE_TRANSITIONS=0 \
    PI_MEMORY_QMD_UPDATE=off \
    PI_MEMORY_NO_SEARCH=1 \
    PATH=/app/.venv/bin:$PATH

ARG DEBIAN_MIRROR=mirrors.aliyun.com
RUN sed -i "s|deb.debian.org/debian-security|${DEBIAN_MIRROR}/debian-security|g; s|deb.debian.org/debian|${DEBIAN_MIRROR}/debian|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git ripgrep bash python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@12.10.1 \
    && uv python install 3.12

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml pyproject.toml uv.lock ./
COPY bin/ ./bin/
RUN pnpm install --frozen-lockfile

COPY . ./
ARG BUILD_NODE_OPTIONS=--max-old-space-size=2560
RUN WORKAGENT_BUILD_PROGRESS=1 NODE_OPTIONS="$BUILD_NODE_OPTIONS" pnpm build \
    && uv sync --frozen --no-dev \
    && uv run --offline --frozen python -c "import openpyxl; import docx" \
    && mkdir -p /app/.workagent/agent /app/.workagent/memory \
    && chown -R node:node /app /opt/uv/python /tmp/uv-cache

ENV NODE_ENV=production UV_NO_SYNC=1
USER node
EXPOSE 30141

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:30141/api/web-auth').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"

CMD ["node", "scripts/workagent-start.mjs"]
