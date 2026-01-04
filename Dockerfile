# syntax=docker/dockerfile:1

FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies only when needed
FROM base AS deps
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

# Production image
FROM base AS runner

# Install system dependencies needed for opencode and process management
RUN apt-get update && apt-get install -y \
    curl \
    procps \
    lsof \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install opencode binary
# Download directly from GitHub releases for the appropriate architecture
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "x86_64" ]; then \
        ARCH="x64"; \
    elif [ "$ARCH" = "aarch64" ]; then \
        ARCH="arm64"; \
    fi && \
    curl -fsSL "https://github.com/sst/opencode/releases/latest/download/opencode-linux-${ARCH}.tar.gz" -o /tmp/opencode.tar.gz && \
    tar -xzf /tmp/opencode.tar.gz -C /usr/local/bin && \
    chmod +x /usr/local/bin/opencode && \
    rm /tmp/opencode.tar.gz && \
    opencode --version

WORKDIR /app

# Copy dependencies
COPY --from=deps /app/node_modules ./node_modules

# Copy source code
COPY package.json ./
COPY tsconfig.json ./
COPY src ./src

# Create data directory for SQLite databases
RUN mkdir -p /app/data

# Default environment variables
ENV NODE_ENV=production
ENV ORCHESTRATOR_DB_PATH=/app/data/orchestrator.db
ENV TOPIC_DB_PATH=/app/data/topics.db

# Expose ports for API server and OpenCode instances
# API server
EXPOSE 4200
# OpenCode instance port range (configurable via OPENCODE_PORT_START)
EXPOSE 4100-4199

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:4200/api/health || exit 1

# Run the bot
CMD ["bun", "run", "start"]
