# Discord Music Bot — Implementation Plan

| Date       | Spec                                                            | Target                     |
| ---------- | --------------------------------------------------------------- | -------------------------- |
| 2026-11-06 | `docs/superpowers/specs/2026-11-06-discord-music-bot-design.md` | `~/Projects/discord-music` |

Execute P0 → P6 in order; each phase must exit green before the next starts. The
architecture in the spec is final — do not re-decide stack, runtime, or topology
while executing. If the spec is wrong, correct the spec first and note the change.

| Phase | Goal                                                                           | Blocked by                |
| ----- | ------------------------------------------------------------------------------ | ------------------------- |
| P0    | Scaffold + shared contracts                                                    | —                         |
| P1    | Bot: client, commands, embeds, player, media engine, control server, DB writes | P0                        |
| P2    | Web API: Hono, auth, routes, bot client, DB, migrations                        | P0 (P1 for live calls)    |
| P3    | Web UI                                                                         | P2                        |
| P4    | Integration + verification                                                     | P1–P3                     |
| P5    | Review (reviewer + security)                                                   | P4                        |
| P6    | Ship (git, GitHub, Coolify, DNS)                                               | P5 + manual prerequisites |

---

## P0 — Scaffold and Shared Contracts

**Goal:** a working monorepo with the wire contract compiled and importable from
both apps. Nothing runs yet.

**Files**

- Root: `package.json` (Bun workspaces `apps/*`, `packages/*`; scripts `lint`,
  `typecheck`, `build`), `tsconfig.base.json` (strict, ESM, bundler resolution),
  `biome.json`, `.env.example` (spec §10), `.gitignore`, `compose.dev.yml`.
- `packages/shared/`: `package.json` (`@music/shared`, ESM + types),
  `tsconfig.json` (build to `dist/`, emit `.d.ts`), `src/index.ts`.
- `packages/shared/src/track.ts` (`Track`, `QueueTrack`), `player.ts`
  (`PlayerState`, `GuildSummary`, loop modes), `control.ts` (action union + zod
  schemas), `{playlists,history,settings}.ts` (DTOs), `db/schema.ts` (Drizzle,
  all five tables from §6).

**Verify**

```bash
bun install && bun lint && bun typecheck
bun run build --filter @music/shared
```

**Exit criteria:** `@music/shared` emits ESM + `.d.ts`; every type in spec §8.1
and §8.2 is exported and type-checks; the schema matches spec §6 column for
column; both apps import the package without error (stub entrypoints allowed).

---

## P1 — Bot

**Goal:** a running Node 22 process that connects to Discord, plays audio, and
serves the internal control API.

**Files**

- `apps/bot/package.json` (Node 22 engines; discord.js, `@discordjs/voice`,
  `@discordjs/opus`, drizzle, postgres, hono) and `apps/bot/Dockerfile` (Node 22
  base, pinned `yt-dlp`, Deno >= 2.3, ffmpeg, repo-root context).
- `apps/bot/src/{config,client,index}.ts` — env validation (fail fast), discord.js
  client with gateway error handling, boot (register commands, start control
  server, start client).
- `apps/bot/src/commands/*.ts` — one file per command group (playback, queue,
  library); `apps/bot/src/embeds/{now-playing,queue,errors}.ts`, where
  `buildNowPlayingEmbed` is the only now-playing builder.
- `apps/bot/src/player/manager.ts` (per-guild registry), `queue.ts` (in-memory
  ops), `media.ts` (yt-dlp/ffmpeg spawn), `lifecycle.ts` (join/leave/idle/
  cooldown), `permissions.ts` (DJ gating).
- `apps/bot/src/control/server.ts` — Hono on :3001, `X-Control-Secret`
  middleware, four endpoints.
- `apps/bot/src/db/*.ts` — `play_history` writer, settings/playlist readers.

**Implementation notes:** spawn `yt-dlp` with `--js-runtimes deno:<DENO_PATH>`
explicitly, never relying on auto-detection; never let a child-process failure
reach the gateway handler (post an error embed instead); return the result shape
exactly (`{ ok: true, data }` or `{ ok: false, error: { code, message } }`);
register commands instantly to `DISCORD_GUILD_ID` when set, globally otherwise.

**Verify**

```bash
bun lint && bun typecheck
bun run build --filter bot
node apps/bot/dist/index.js --smoke   # boots, exits 0 without Discord credentials
```

**Exit criteria:** boot fails fast with a clear message on missing env vars;
`GET /health` answers and unauthenticated control requests are rejected; every
slash command is registered with a handler; YouTube and direct URL resolution
both work.

---

## P2 — Web API

**Goal:** a Bun Hono server that authenticates admins, serves the REST API, and
proxies control actions to the bot.

**Files**

- `apps/web/package.json`, `apps/web/Dockerfile` (Bun base, repo-root context,
  runs the compiled server).
- `apps/web/src/server/index.ts` — entrypoint; migrations on boot under an
  advisory lock; `db/migrate.ts` — Drizzle migrations + advisory lock.
- `apps/web/src/server/auth/{oidc,session,middleware}.ts` — discovery + PKCE +
  server-side code exchange; session create/read/delete; require session and
  `music-admins`.
- `apps/web/src/server/bot-client.ts` — typed bot control client with
  `X-Control-Secret`.
- `apps/web/src/server/routes/{auth,guilds,settings,playlists,history}.ts` — every
  endpoint in spec §8.4.
- `apps/web/src/server/{envelope,dev-bypass}.ts` — `{ success, data, error }`
  helpers; `AUTH_DEV_BYPASS`, refused when `NODE_ENV=production`.

**Implementation notes:** the code exchange is server-side only, so the client
secret never reaches the browser. Session ids are 32 random bytes hex with a
`groups` snapshot. Validate every body with the `@music/shared` schemas.
`/api/health` must not require auth.

**Verify**

```bash
bun lint && bun typecheck && bun run build --filter web
docker compose -f compose.dev.yml up -d postgres && bun run --cwd apps/web start &
curl -fsS localhost:3000/api/health
curl -s -o /dev/null -w '%{http_code}' localhost:3000/api/me   # expect 401
```

**Exit criteria:** health returns 200 without a session; `/api/me` returns 401
without one; migrations create all five tables on an empty database; every
endpoint returns the envelope shape.

---

## P3 — Web UI

**Goal:** the full v1 dashboard from spec §9.2.

**Files**

- `apps/web/vite.config.ts` — React plugin, `/api` proxy to Hono in dev.
- `apps/web/src/ui/{main.tsx,router.tsx,query.ts,api.ts,styles.css}` — mount;
  routes (`/`, `/guilds/:id`, `/guilds/:id/playlists`, `/history`, `/settings`);
  TanStack Query client with 2s player-state polling; envelope-unwrapping fetch
  wrapper; Tailwind v4 entry with dark tokens.
- `apps/web/src/ui/components/` — `GuildSidebar`, `NowPlayingCard`, `QueueList`,
  `AddTrackInput`, `PlaylistEditor`, `HistoryTable`, `SettingsForm`.

**Implementation notes:** every mutation invalidates the player-state query so the
UI updates immediately; every bot control must be reachable from the UI; the
sidebar collapses to a drawer below `md`.

**Verify**

```bash
bun lint && bun typecheck && bun run build --filter web
```

**Exit criteria:** every page renders; polling updates the now-playing card
within 2 seconds; no page crashes with an empty guild list or a disconnected bot.

---

## P4 — Integration and Verification

**Goal:** prove the system works together and both images build.

```bash
bun install && bun lint && bun typecheck && bun run build
bun test                                        # queue ops, DJ matrix, dispatch
docker build -f apps/bot/Dockerfile -t music-bot:local .
docker build -f apps/web/Dockerfile -t music-web:local .
docker compose -f compose.dev.yml up -d postgres  # then migrate + boot both apps
```

**Exit criteria:** all commands pass from the repo root; both images build; a
`play` action sent through `music-web` reaches `music-bot` and returns a
`PlayerState`; queue mutations, the DJ permission matrix, and control dispatch
are covered by unit tests.

---

## P5 — Review

**Goal:** independent review before anything ships.

1. Run the `reviewer` agent over the branch: correctness, conformance to spec §8,
   error handling, type safety.
2. Run the `security` agent: session handling, the OIDC flow, the
   `X-Control-Secret` boundary, command injection in child-process arguments, and
   authorisation gaps on the web API.
3. Fix findings, or record accepted risks with a reason.

```bash
bun lint && bun typecheck && bun run build && bun test
```

**Exit criteria:** no unresolved high-severity findings; every accepted risk is
written down; the spec is updated if a finding changed a design decision.

---

## P6 — Ship

**Goal:** the live deployment at `https://music.dasa122.net`.

1. `git init`, commit the full tree, create a **private** GitHub repository, push.
2. Create Coolify project `discord-music` with three resources:
   - `music-bot` — Application, `apps/bot/Dockerfile`, repo-root context, **no
     domain**, network alias `music-bot`, internal port 3001.
   - `music-web` — Application, `apps/web/Dockerfile`, domain
     `https://music.dasa122.net`, health check `GET /api/health`.
   - `music-db` — PostgreSQL 17, not public.
3. Set every `.env.example` variable on the correct resource; set
   `BOT_INTERNAL_URL=http://music-bot:3001` on `music-web` and the same
   `BOT_CONTROL_SECRET` on both.
4. Deploy `music-db`, then `music-bot`, then `music-web`.
5. Verify: health check, Authentik login, guild list populated, control-action
   round trip.

```bash
curl -fsS https://music.dasa122.net/api/health
```

**Exit criteria:** the public health check passes; an `music-admins` member can
log in and anyone else is refused; the dashboard lists the bot's guilds; a
dashboard control action affects the Discord player.

---

## Manual Steps the Human Must Do

These block P6 and cannot be automated.

| #   | Step                                                                                                                                              | Produces                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | Create a Discord application, add a bot, copy the token, generate an invite URL with `bot` + `applications.commands` scopes and voice permissions | `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, invite URL                                               |
| 2   | Create an Authentik confidential OIDC provider + application, create group `music-admins`, add the admins                                         | `AUTHENTIK_ISSUER`, `AUTHENTIK_CLIENT_ID`, `AUTHENTIK_CLIENT_SECRET`, `AUTHENTIK_REDIRECT_URI` |
| 3   | Set the Coolify env secrets on `music-bot` and `music-web`                                                                                        | Runtime configuration                                                                          |
| 4   | Point DNS `music.dasa122.net` at the Coolify host; let Coolify issue TLS                                                                          | Working HTTPS domain                                                                           |
| 5   | Optionally supply a cookies file at `/data/cookies.txt`, `YTDLP_PROXY`, and/or `POT_PROVIDER_URL`                                                 | Working extraction from a datacenter IP                                                        |

Until step 5 completes, three surfaces stay unverified: real YouTube playback
from the Coolify host's IP, voice quality under DAVE, and long-run stability
across many guilds. These are accepted risks documented in spec §11.
