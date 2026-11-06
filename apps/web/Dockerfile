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
RUN mkdir -p apps/web/node_modules packages/shared/node_modules

FROM oven/bun:1 AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps ./apps
COPY --from=deps /app/packages ./packages

COPY package.json tsconfig.base.json ./
COPY apps/web/index.html apps/web/vite.config.ts apps/web/tsconfig.json ./apps/web/
COPY apps/web/src ./apps/web/src
COPY packages/shared/tsconfig.json packages/shared/tsconfig.build.json packages/shared/drizzle.config.ts ./packages/shared/
COPY packages/shared/src ./packages/shared/src

RUN bun run --filter @music/shared build && bun run --filter @music/web build

FROM oven/bun:1-debian AS runtime
WORKDIR /app

ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY packages/shared/drizzle ./packages/shared/drizzle
COPY packages/shared/package.json ./packages/shared/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/web/tsconfig.json ./apps/web/tsconfig.json
COPY apps/web/src/server ./apps/web/src/server

# The runtime only reads from /app and writes nothing to disk (migrations run
# against Postgres), so the image runs as the `bun` user shipped by the base
# image instead of root.
USER bun

EXPOSE 3000

CMD ["bun", "apps/web/src/server/index.ts"]
