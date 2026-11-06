# Discord Music Bot + Admin Dashboard — Design Specification

| Date       | Owner   | Status                            | Scale target                               |
| ---------- | ------- | --------------------------------- | ------------------------------------------ |
| 2026-11-06 | Dasa122 | Approved — implementation pending | 10–50 guilds, one bot process, no sharding |

A self-hosted Discord music bot plus an admin web dashboard, deployed on the
existing Coolify instance at `https://music.dasa122.net`.

## 1. Scope

**In scope (v1):** slash-command playback from a Discord voice channel;
per-guild queue, playlists, play history, and settings; a web dashboard that acts
as a remote control for the same actions.

**Out of scope:** browser audio streaming (the Discord voice channel is always
the speaker — the dashboard is **remote control only**); sharding, horizontal
scaling, or multi-process bot deployments; cross-guild sharing of playlists or
history; anonymous dashboard access; GPU transcoding (audio only).

## 2. Architecture

```
                +---------------------------+
  Discord <---> |  music-bot (Node 22)      |
  gateway/voice |  discord.js + @discordjs/voice
                |  yt-dlp -> ffmpeg         |
                |  control HTTP :3001       |
                +------------^--------------+
                             | private HTTP, X-Control-Secret
                +------------+--------------+
  Browser <---> |  music-web (Bun)          |
                |  Hono + React 19 + Vite   |
                +------------+--------------+
                             |
                +------------v--------------+
                |  music-db (PostgreSQL 17) |
                +---------------------------+
```

- The bot is the only process that talks to Discord.
- The web app never touches Discord; it forwards control actions to the bot over
  the internal network.
- No Redis and no message broker. Live player state is in-memory in the bot,
  polled by the UI.
- All three resources live in the Coolify project `discord-music`.

## 3. Locked Stack Decisions

| Concern                      | Decision                                                                                 | Rationale                                                                                                                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspaces / package manager | Bun 1.4 workspaces                                                                       | Fast installs, one lockfile, shared TS config                                                                                                                                             |
| Bot runtime                  | **Node 22** (not Bun)                                                                    | Bun's Discord voice path is 8–13× CPU (oven-sh/bun#26415); `@discordjs/opus` prebuilds fail under Bun (oven-sh/bun#11313); `@discordjs/ws` on Bun crashes on reconnect (discord.js#10840) |
| Web runtime                  | Bun                                                                                      | Fast, stable for plain HTTP work                                                                                                                                                          |
| Web stack                    | Hono + React 19 + Vite + Tailwind CSS v4                                                 | Small typed server, standard UI tooling                                                                                                                                                   |
| Discord                      | discord.js + `@discordjs/voice` **>= 0.18** (DAVE mandatory)                             | DAVE is required for current voice                                                                                                                                                        |
| Audio                        | `yt-dlp` child process → `ffmpeg` child process → voice → Discord                        | Proven, audio only, no GPU                                                                                                                                                                |
| yt-dlp JS runtime            | Deno >= 2.3, passed as `--js-runtimes deno:/usr/local/bin/deno`                          | yt-dlp needs an external JS runtime; **Bun 1.4 is not supported as that runtime**                                                                                                         |
| Database                     | PostgreSQL 17 (Coolify-managed)                                                          | Managed backups, internal-only networking                                                                                                                                                 |
| ORM / driver                 | Drizzle ORM + `postgres.js`                                                              | Identical behaviour from Node and Bun                                                                                                                                                     |
| Dashboard auth               | Authentik OIDC, code flow + PKCE, confidential client, then an opaque app session cookie | Central identity, group-based authorisation                                                                                                                                               |
| Queue state                  | In-memory per guild                                                                      | Restart clears queues and the bot leaves voice; only durable data goes to Postgres                                                                                                        |

Because both runtimes import `packages/shared`, it must contain no Node-only or
Bun-only APIs.

## 4. Repository Layout

```
discord-music/
├── package.json                  # bun workspaces: apps/*, packages/*
├── bun.lock
├── tsconfig.base.json
├── biome.json
├── docker-compose.yml            # local dev only
├── .env.example
├── apps/bot/                     # Node 22
│   ├── Dockerfile
│   └── src/{index.ts,config.ts,client.ts,commands/*,embeds/*,player/*,control/server.ts,db/*}
├── apps/web/                     # Bun
│   ├── Dockerfile
│   └── src/{server/*,ui/*}
└── packages/shared/              # @music/shared, built to ESM + d.ts
    └── src/{index,track,player,control,playlists,history,settings,db/schema}.ts
```

`packages/shared` is the single source of truth for the wire contract, the DB
schema, and every type crossing a process boundary.

## 5. Deployment Topology (Coolify)

Project `discord-music`, three resources:

| Resource    | Type          | Build                                            | Networking                                                          |
| ----------- | ------------- | ------------------------------------------------ | ------------------------------------------------------------------- |
| `music-bot` | Application   | `apps/bot/Dockerfile`, build context = repo root | **No public domain**; network alias `music-bot`, internal port 3001 |
| `music-web` | Application   | `apps/web/Dockerfile`, build context = repo root | Domain `https://music.dasa122.net`, health check `GET /api/health`  |
| `music-db`  | PostgreSQL 17 | —                                                | Not public                                                          |

**Control plane:** `music-web` → `music-bot` over the Coolify internal network at
`http://music-bot:3001`, authenticated with `X-Control-Secret`. No Redis.

**Data ownership:** `music-web` writes `guild_settings`, `playlist`,
`playlist_item`, and `session`; `music-bot` writes `play_history`; both read what
they need.

**Migrations** run once from `music-web` on boot, under a PostgreSQL advisory
lock, so rolling restarts cannot race.

Operational consequences: the bot's control server binds `0.0.0.0:3001` inside
the container; restarting the bot clears all queues and disconnects voice (an
accepted behaviour, not a bug); a failed migration fails the web boot loudly
rather than serving a stale schema.

## 6. Data Model

Defined in `packages/shared/src/db/schema.ts`.

```sql
guild_settings   (guild_id TEXT PK, dj_role_id TEXT NULL, default_volume INT DEFAULT 100,
                  max_queue_length INT DEFAULT 100, allowed_channel_ids TEXT[] DEFAULT '{}',
                  created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ)

playlist         (id TEXT PK /* nanoid */, guild_id TEXT, owner_discord_id TEXT, name TEXT,
                  is_shared BOOLEAN DEFAULT false, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ,
                  UNIQUE (guild_id, name))

playlist_item    (id TEXT PK, playlist_id TEXT REFERENCES playlist(id) ON DELETE CASCADE,
                  position INT, title TEXT, url TEXT, duration_sec INT NULL,
                  thumbnail_url TEXT NULL, added_by TEXT, created_at TIMESTAMPTZ)

play_history     (id TEXT PK, guild_id TEXT, title TEXT, url TEXT, duration_sec INT NULL,
                  requested_by TEXT, played_at TIMESTAMPTZ DEFAULT now(),
                  INDEX (guild_id, played_at DESC))

session          (id TEXT PK /* 32 random bytes hex */, authentik_sub TEXT, display_name TEXT,
                  groups TEXT[], created_at TIMESTAMPTZ, expires_at TIMESTAMPTZ,
                  INDEX (expires_at))
```

## 7. Bot Design

### 7.1 Slash Commands

| Group    | Commands                                                                                                                                                    |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Playback | `/play <query\|url>`, `/search <query>` (select menu of top 5), `/skip [count]`, `/pause`, `/resume`, `/stop`, `/nowplaying`                                |
| Queue    | `/queue [page]`, `/volume <0-200>`, `/seek <mm:ss>`, `/loop <off\|track\|queue>`, `/shuffle`, `/remove <pos>`, `/move <from> <to>`, `/clear`, `/disconnect` |
| Library  | `/playlist save\|load\|list\|delete <name>`, `/history [page]`                                                                                              |

All replies are ephemeral except the shared now-playing and queue embeds.

### 7.2 Embeds

One canonical `buildNowPlayingEmbed(track, state)` is reused everywhere — slash
replies, button updates, and dashboard-driven changes.

- Title linked to the track URL, thumbnail, description `Requested by <@user>`.
- Fields: Duration, Position, Volume, Loop, Queue.
- Footer: bot name + guild name. Timestamp: playback start.
- Colours: green playing, amber paused, red error, gray ended.
- Buttons: Pause/Resume, Skip, Stop, Queue, Shuffle.

**One live now-playing message per guild**, tracked by `messageId`. On track
change the old message is edited into a finished state with buttons removed and
a new message is posted. Buttons are disabled after a 15-minute idle timeout. The
`/queue` embed is paginated at 10 per page with Prev/Next. Errors are embeds with
actionable text; `yt-dlp` stderr is included only when `LOG_LEVEL=debug`.

### 7.3 Player Lifecycle

- Auto-join only the invoker's **current** voice channel.
- Auto-leave after `IDLE_TIMEOUT` (default 300s) of an empty channel or empty queue.
- The DJ role gates `skip`, `stop`, `clear`, `remove`, `move`, `seek`, `shuffle`,
  and `volume` for non-administrators.
- A resolution failure skips the track and posts one error embed; it must never
  crash the gateway connection.
- A burst of failures triggers a 60-second per-guild cooldown.

## 8. Wire Contract

Implemented exactly in `packages/shared`; camelCase on the wire.

### 8.1 Types

```ts
type Track = {
  id: string;
  title: string;
  url: string;
  durationSec: number | null;
  thumbnailUrl: string | null;
  source: "youtube" | "direct" | "unknown";
  requestedBy: { id: string; name: string };
};

type PlayerState = {
  guildId: string;
  connected: boolean;
  voiceChannelId: string | null;
  textChannelId: string | null;
  playing: boolean;
  paused: boolean;
  positionSec: number;
  volume: number;
  loop: "off" | "track" | "queue";
  current: Track | null;
  queue: Track[];
  updatedAt: string;
};

type GuildSummary = {
  id: string;
  name: string;
  iconUrl: string | null;
  memberCount: number;
  connected: boolean;
  playing: boolean;
  currentTitle: string | null;
};
```

### 8.2 Control Actions

A discriminated union on `type`:

| `type`                                                           | Payload                                       |
| ---------------------------------------------------------------- | --------------------------------------------- |
| `play`                                                           | `{ query, requestedBy, textChannelId? }`      |
| `pause` / `resume` / `stop` / `shuffle` / `clear` / `disconnect` | —                                             |
| `skip`                                                           | `{ count? }`                                  |
| `seek`                                                           | `{ positionSec }`                             |
| `volume`                                                         | `{ volume }`                                  |
| `loop`                                                           | `{ mode }`                                    |
| `remove`                                                         | `{ index }`                                   |
| `move`                                                           | `{ from, to }`                                |
| `playPlaylist`                                                   | `{ playlistId, requestedBy, textChannelId? }` |

### 8.3 Bot Control API (internal)

Every request requires the `X-Control-Secret` header.

| Method | Path                  | Response                                                                       |
| ------ | --------------------- | ------------------------------------------------------------------------------ |
| GET    | `/health`             | liveness                                                                       |
| GET    | `/guilds`             | `{ guilds: GuildSummary[] }`                                                   |
| GET    | `/guilds/:id/state`   | `PlayerState`                                                                  |
| POST   | `/guilds/:id/actions` | `{ ok: true, data: PlayerState }` \| `{ ok: false, error: { code, message } }` |

### 8.4 Web API

All responses are JSON in the envelope
`{ success: boolean, data?: T, error?: { code, message } }`.

```
GET    /api/health
GET    /api/me
GET    /api/guilds
GET    /api/guilds/:guildId/state
POST   /api/guilds/:guildId/actions
GET    /api/guilds/:guildId/settings
PUT    /api/guilds/:guildId/settings
GET    /api/guilds/:guildId/playlists
POST   /api/guilds/:guildId/playlists
PATCH  /api/playlists/:playlistId
DELETE /api/playlists/:playlistId
POST   /api/playlists/:playlistId/items
DELETE /api/playlists/:playlistId/items/:itemId
GET    /api/guilds/:guildId/history?limit&offset
GET    /api/auth/login
GET    /api/auth/callback
POST   /api/auth/logout
```

## 9. Web Application

### 9.1 Authentication

1. `/api/auth/login` generates `state` + a PKCE verifier and redirects to
   Authentik.
2. `/api/auth/callback` validates `state`, exchanges the code **server-side**
   (confidential client), and reads `sub`, `name`, `groups`.
3. Login is refused unless the user belongs to the Authentik group `music-admins`.
4. A 32-byte random session id is written to `session` and set as an opaque
   cookie: `HttpOnly`, `Secure`, `SameSite=Lax`.
5. `POST /api/auth/logout` deletes the session row and clears the cookie.

No refresh token is stored; an expired session means logging in again.

### 9.2 Pages (v1, full scope)

| Page             | Contents                                                                            |
| ---------------- | ----------------------------------------------------------------------------------- |
| Login / redirect | Authentik redirect plus error state                                                 |
| Dashboard        | Guild sidebar, now-playing card with controls, add-track input, live queue          |
| Per-guild queue  | Full queue with reorder and remove                                                  |
| Playlists        | Create/rename/delete, load to queue, reorder items                                  |
| History          | Paginated play history                                                              |
| Settings         | DJ role id, default volume, max queue length, allowed channel ids, bot/voice status |

Live state comes from TanStack Query polling `/api/guilds/:id/state` every 2
seconds. Dark theme, Tailwind v4, responsive. `AUTH_DEV_BYPASS=1` exists for local
development and must be refused when `NODE_ENV=production`.

## 10. Configuration

Documented in `.env.example`.

```
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=            # optional, dev-only instant command registration
BOT_CONTROL_PORT=3001
BOT_CONTROL_SECRET=
MAX_CONCURRENT_STREAMS=3
IDLE_TIMEOUT_SECONDS=300
LOG_LEVEL=info
YTDLP_PATH=/usr/local/bin/yt-dlp
DENO_PATH=/usr/local/bin/deno
FFMPEG_PATH=/usr/bin/ffmpeg
YTDLP_COOKIES_FILE=/data/cookies.txt
YTDLP_PROXY=
POT_PROVIDER_URL=
DATABASE_URL=
PORT=3000
PUBLIC_BASE_URL=https://music.dasa122.net
BOT_INTERNAL_URL=http://music-bot:3001
AUTHENTIK_ISSUER=
AUTHENTIK_CLIENT_ID=
AUTHENTIK_CLIENT_SECRET=
AUTHENTIK_REDIRECT_URI=
AUTHENTIK_ADMIN_GROUP=music-admins
SESSION_TTL_DAYS=7
SESSION_COOKIE_SECURE=true
AUTH_DEV_BYPASS=
```

## 11. YouTube Extraction Risk

The largest operational risk in the project, and therefore a first-class design
constraint.

- Datacenter IPs are commonly blocked at the **IP level**: "Sign in to confirm
  you're not a bot".
- **PO tokens do not fix an IP-level block**; they address a different check.
- Extractors break whenever YouTube changes, so the pinned version will
  eventually be stale.

v1 therefore ships with: an optional cookies file, an optional `--proxy`, an
optional bgutil PO-token provider URL, a pinned `yt-dlp` + Deno, graceful
"extractor may be outdated" errors, and a loud log line on every failure.

**Documented upgrade path:** a residential proxy plus a cookies file.

**Caveat:** downloading from YouTube is a gray zone under YouTube's terms of
service, and streaming it into Discord is a gray zone under Discord's terms.
Playback is **unverified** until real credentials and a real voice channel are
used.

## 12. Acceptance Criteria

1. `bun install`, `bun lint`, `bun typecheck`, and `bun run build` pass from the repo root.
2. Both Docker images build successfully.
3. An authorised admin can log in via Authentik; anyone else is refused.
4. The dashboard reflects live player state within 2 seconds of a change.
5. Every control action in the union works from the UI.
6. Playlists can be created, reordered, and loaded to the queue.
7. History is written by the bot and readable in the dashboard.
8. Settings persist across restarts.
9. A failed extraction produces an error embed and does not crash the bot.
10. An empty channel disconnects the bot after the idle timeout.

## 13. Other Accepted Risks

- In-memory queue loss on restart: short disruption, surfaced in the UI.
- Single bot process with no failover: acceptable at 10–50 guilds.
- yt-dlp extractor drift: pinned version, graceful errors, loud logs.
