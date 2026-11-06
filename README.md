# Discord Music

Self-hosted Discord music bot with a web control panel: a Node 22 bot joins voice channels and
streams audio, a Bun/Hono API serves the React UI, and both share types and Drizzle schemas from
`packages/shared`.

```
                    +----------------------+
  Discord gateway <->   apps/bot (Node 22) |
                    |   discord.js + voice |
                    +----------+-----------+
                               | HTTP control API (:3001)
                    +----------v-----------+
  Browser  <------> |   apps/web (Bun)     |
                    |   Hono API + React   |
                    +----------+-----------+
                               |
                    +----------v-----------+
                    |  Postgres + shared   |
                    |  (@music/shared)     |
                    +----------------------+
```

## Local development

Prerequisites: **Node 22+**, **Bun 1.4+**, and **Docker** (for Postgres and the compose stack).
The bot image additionally installs `ffmpeg`, `yt-dlp`, and Deno.

### Everything in Docker

```bash
cp .env.example .env      # fill in Discord/Authentik credentials where needed
docker compose up --build # Postgres + bot (:3001) + web (:3000)
```

The compose file supplies local-only defaults (`PUBLIC_BASE_URL=http://localhost:3000`,
`BOT_INTERNAL_URL=http://bot:3001`, `AUTH_DEV_BYPASS=true`, `SESSION_COOKIE_SECURE=false`) and a
shared placeholder `BOT_CONTROL_SECRET`. Override anything by editing `.env`.

### Vite dev pair

Run the API and the Vite UI in two terminals:

```bash
# terminal 1 — Vite UI on :5173 (proxies /api to :3000)
PUBLIC_BASE_URL=http://localhost:5173 bun run --filter @music/web dev:ui

# terminal 2 — Hono API on :3000
PUBLIC_BASE_URL=http://localhost:5173 bun run --filter @music/web dev
```

Set `AUTH_DEV_BYPASS=true` in `.env` (or the environment) to skip Authentik during local work.
`AUTHENTIK_REDIRECT_URI` must be `http://localhost:3000/api/auth/callback` for the Vite pair —
the browser origin differs from the API origin, so log in through the API callback.

### Bot

```bash
bun run --filter @music/bot dev     # build once, then `node --watch dist/index.js`
bun run --filter @music/bot watch   # optional: tsc --watch for live rebuilds
```

For live reload, run `watch` in one terminal and `dev` in another. Running only `dev` works too —
restart it after source changes.

### Database

```bash
bun run db:generate       # regenerate Drizzle migrations after a schema change
```

Migrations are applied automatically on web boot (`runMigrations`), under a Postgres advisory lock
so rolling replicas cannot race DDL.

### Checks

```bash
bun run check   # check:ts + typecheck + lint + test
bun run build
```

## Production

The target topology and environment contract live in the
[design document](docs/superpowers/specs/2026-11-06-discord-music-bot-design.md). Production
expects real Authentik OIDC credentials, `SESSION_COOKIE_SECURE=true`, `AUTH_DEV_BYPASS` unset, and
a managed Postgres instance.

## Known risks

- **YouTube datacenter-IP blocks** — yt-dlp streaming from cloud hosts is frequently challenged;
  residential or allowlisted egress may be required.
- **Optional cookies / proxy / POT** — `YTDLP_COOKIES_FILE`, `YTDLP_PROXY`, and `POT_PROVIDER_URL`
  are supported escape hatches, but none is guaranteed to keep working.
- **ToS caveat** — downloading/streaming YouTube media can violate YouTube's Terms of Service;
  operators are responsible for how they run this.

## Design

See [`docs/superpowers/specs/2026-11-06-discord-music-bot-design.md`](docs/superpowers/specs/2026-11-06-discord-music-bot-design.md).
