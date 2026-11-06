# syntax=docker/dockerfile:1

# Build context is the repository root, so workspace paths are apps/... and packages/....

FROM oven/bun:1 AS deps
WORKDIR /app

COPY package.json bun.lock ./
COPY apps/bot/package.json ./apps/bot/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/shared/package.json ./packages/shared/package.json

RUN bun install --frozen-lockfile
# Guarantee the workspace node_modules paths exist so later COPY steps never fail.
RUN mkdir -p apps/bot/node_modules packages/shared/node_modules

FROM oven/bun:1 AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps ./apps
COPY --from=deps /app/packages ./packages

COPY package.json tsconfig.base.json ./
COPY apps/bot/tsconfig.json ./apps/bot/tsconfig.json
COPY apps/bot/src ./apps/bot/src
COPY packages/shared/tsconfig.json packages/shared/tsconfig.build.json packages/shared/drizzle.config.ts ./packages/shared/
COPY packages/shared/src ./packages/shared/src

RUN bun run --filter @music/shared build && bun run --filter @music/bot build

FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
    curl \
    unzip \
    xz-utils \
    python3 \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh

ARG YT_DLP_VERSION=2026.10.26
RUN curl -fsSL -o /usr/local/bin/yt-dlp \
      "https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/yt-dlp_linux" \
  && chmod +x /usr/local/bin/yt-dlp

WORKDIR /app

COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/bot/node_modules ./apps/bot/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=build /app/apps/bot/dist ./apps/bot/dist
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY packages/shared/package.json ./packages/shared/package.json
COPY apps/bot/package.json ./apps/bot/package.json

# Runs as root for simplicity: the bot only writes under the mounted /data volume.
# Switch to `USER node` after chowning /app and /data if you need a non-root runtime.
ENV NODE_ENV=production
ENV BOT_CONTROL_HOST=0.0.0.0
EXPOSE 3001

CMD ["node", "apps/bot/dist/index.js"]
