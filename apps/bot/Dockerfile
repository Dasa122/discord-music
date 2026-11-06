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

# Toolchain pinning. Both downloads are checked against a published SHA-256
# before they become executable; a mismatch fails the build.
#
#   DENO_VERSION / DENO_SHA256
#     The checksum is for the linux x86_64 release archive. Overriding either
#     (for example when building for arm64) requires a matching checksum:
#     https://github.com/denoland/deno/releases/tag/v<version>
#   YT_DLP_VERSION
#     The release's own SHA2-256SUMS is fetched at build time, so only the
#     version needs overriding.
ARG DENO_VERSION=2.9.8
ARG DENO_SHA256=e890975bc2549807bbcc0b584ffafda72cc7c93349dd99c80483dd784f6c4609
ARG YT_DLP_VERSION=2026.10.26

RUN set -eux; \
  curl -fsSL -o /tmp/deno.zip \
    "https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-x86_64-unknown-linux-gnu.zip"; \
  echo "${DENO_SHA256}  /tmp/deno.zip" | sha256sum -c -; \
  unzip -q /tmp/deno.zip -d /usr/local/bin; \
  chmod +x /usr/local/bin/deno; \
  rm /tmp/deno.zip; \
  deno --version

RUN set -eux; \
  base="https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}"; \
  curl -fsSL -o /usr/local/bin/yt-dlp "$base/yt-dlp_linux"; \
  curl -fsSL -o /tmp/SHA2-256SUMS "$base/SHA2-256SUMS"; \
  cd /tmp; \
  grep -E '[[:space:]]yt-dlp_linux$' SHA2-256SUMS > yt-dlp_linux.sha256; \
  sed -i 's#yt-dlp_linux$#/usr/local/bin/yt-dlp#' yt-dlp_linux.sha256; \
  sha256sum -c yt-dlp_linux.sha256; \
  chmod +x /usr/local/bin/yt-dlp; \
  rm -f SHA2-256SUMS yt-dlp_linux.sha256; \
  yt-dlp --version

WORKDIR /app

COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/bot/node_modules ./apps/bot/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=build /app/apps/bot/dist ./apps/bot/dist
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY packages/shared/package.json ./packages/shared/package.json
COPY apps/bot/package.json ./apps/bot/package.json

# Runs as an unprivileged user. The only writable location the bot needs is the
# mounted /data volume (cookies and other media tooling state).
RUN mkdir -p /data && chown node:node /data

ENV NODE_ENV=production
ENV BOT_CONTROL_HOST=0.0.0.0
EXPOSE 3001

USER node

CMD ["node", "apps/bot/dist/index.js"]
