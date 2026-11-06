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
cp .env.example .env                      # fill in credentials, including BOT_CONTROL_SECRET
docker compose -f compose.dev.yml up --build   # Postgres + bot + web (:3000)
```

`compose.dev.yml` is **local development only** — never deploy it. It enables `AUTH_DEV_BYPASS`
and refuses to start unless `BOT_CONTROL_SECRET` is set in `.env`. It publishes only the web
port (:3000); Postgres and the bot control API stay on the compose network. Other local-only
defaults are `PUBLIC_BASE_URL=http://localhost:3000`, `BOT_INTERNAL_URL=http://bot:3001`, and
`SESSION_COOKIE_SECURE=false`.

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

The bot's HTTP control API binds `BOT_CONTROL_HOST` (default `127.0.0.1`). Docker sets
`0.0.0.0` so the web container can reach `music-bot:3001`; leave the default for bare-metal runs
so port 3001 stays on the loopback interface.

`DISCORD_ALLOWED_GUILD_IDS` is an optional comma-separated allow-list. When set, commands and
buttons from any other guild are ignored (and logged once); leave it empty to serve every guild
the bot is invited to.

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

### Image toolchain pins

`apps/bot/Dockerfile` downloads Deno and yt-dlp at build time. Deno is pinned by
`DENO_VERSION` + `DENO_SHA256` (linux x86_64 archive) and yt-dlp by `YT_DLP_VERSION`, whose
release `SHA2-256SUMS` is verified with `sha256sum -c`. Both fail the build on mismatch; override
a pin only together with its matching checksum.

## Production

Audio objects live in S3 (Garage): `infra/garage/` builds an image with the static config baked in
that reads `GARAGE_RPC_SECRET`, `GARAGE_ADMIN_TOKEN`, `GARAGE_METRICS_TOKEN`, and the default
access/bucket keys from the environment at runtime.

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
