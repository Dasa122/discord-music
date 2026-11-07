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

Every route requires the `X-Control-Secret` header. `GET /guilds/:guildId/downloads` returns the
guild's current download state for the dashboard:

```json
{
  "sessionId": "…",
  "entries": [
    {
      "trackId": "vid",
      "title": "Track",
      "state": "downloading",
      "bytes": 1048576,
      "totalBytes": 4194304,
      "percent": 25,
      "startedAt": "2026-11-07T00:00:00.000Z",
      "finishedAt": null,
      "gainDb": null,
      "error": null
    }
  ],
  "totalBytes": 0,
  "maxBytes": 1610612736,
  "store": "local"
}
```

`state` is one of `queued`, `downloading`, `ready`, `failed`; `percent` (and `totalBytes`) are
`null` when yt-dlp cannot know the size, and `gainDb` fills in once the cached file has been
measured. With no active session the route returns `sessionId: null` and `entries: []`.

`DISCORD_ALLOWED_GUILD_IDS` is an optional comma-separated allow-list. When set, commands and
buttons from any other guild are ignored (and logged once); leave it empty to serve every guild
the bot is invited to.

### Audio storage

Audio is cached only for the lifetime of one voice session. A session starts when the bot joins
a channel and ends when it leaves (`/stop`, `/disconnect`, an empty channel, an empty queue after
the 60 second idle timeout, a destroyed voice connection, or process shutdown). Session end deletes
the session's cached audio; a restart wipes everything, because sessions do not survive a restart.
`/data` therefore only needs to survive a session, not a host rebuild.

Two backends are available:

- **`AUDIO_STORE=local`** (default) — files live under `AUDIO_CACHE_DIR` (`/data/audio`). In the
  container `/data` must be a writable volume owned by uid 1000 (`node`). This is the dev default
  and the automatic fallback when S3 is unreachable.
- **`AUDIO_STORE=s3`** — Garage/MinIO-compatible object storage. The bot uploads downloads from a
  local temp directory and streams them back through presigned GET URLs (6 hour expiry, so seek
  uses HTTP range requests). It needs no `/data` volume.

Garage setup:

1. Create a bucket (for example `music`) and an access key with read/write permission on it.
2. Point `S3_ENDPOINT` at the **S3 API** endpoint (`http://garage:3900`), not the admin API
   (`http://garage:3903`). The region is arbitrary for Garage (`S3_REGION=garage`).
3. Keep `S3_FORCE_PATH_STYLE=true` and set `S3_BUCKET`, `S3_ACCESS_KEY_ID`,
   `S3_SECRET_ACCESS_KEY`, and optionally `S3_PREFIX` (default `audio`).

At boot the bot wipes all objects under `S3_PREFIX` (or the whole local cache directory), logging
`cache_cleared`. If `health()` fails at boot it logs `audio_store_unavailable` and falls back to
local storage instead of crashing.

The byte cap (`AUDIO_CACHE_MAX_BYTES`, 1.5 GiB by default) is only an LRU safety net for one very
long session. Live streams and tracks without a known duration are never cached; they always use
the yt-dlp pipe. If a store read or download fails, playback degrades to that same pipe rather than
failing the track. Cache tuning lives in `AUDIO_CACHE_DIR`, `AUDIO_CACHE_MAX_BYTES`,
`AUDIO_CACHE_MAX_FILE_BYTES`, `PREFETCH_ENABLED`, `PREFETCH_MAX_CONCURRENT`, and
`PREFETCH_DEPTH` (1..3, default 2: the next two queue tracks are fetched in order, through a
budget that playback never waits on).

### Fast start

`/play` joins the voice channel and resolves the query at the same time, so extraction no longer
waits for the voice handshake, and resolved metadata is memoised for five minutes. Streamed
tracks buffer `STREAM_PREBUFFER_MS` (default 250 ms, range 100..2000) of decoded audio before
playback; lower values start faster but risk stalls on a slow network. If the stream produces no
bytes within four times that window it falls back to the raw pipe instead of failing the track.
The first track of each play logs `first_audio { ms, source, trackId }` at `info` when the player
reaches `Playing`, which is the measurement to compare before and after these changes.

### Playlists and music links

- `/play` accepts `start_at` (1-based track number) or `start_from` (title substring) for YouTube,
  Spotify and Apple Music collections; they are mutually exclusive.
- A multi-track collection without a start point now shows a picker (first 10 previewed, up to 25
  selectable) instead of queueing everything blindly; **Queue all** or a chosen track enqueues from
  that point.
- Spotify/Apple Music **tracks** resolve through song.link with no credentials; Spotify
  **albums/playlists** need `SPOTIFY_CLIENT_ID`/`SPOTIFY_CLIENT_SECRET`. `MUSIC_LINK_MAX_TRACKS`
  (default 50) caps how far one link expands.

### Loudness normalization

Every decoded track passes through a loudness filter before the 48 kHz stereo s16le PCM reaches
Discord, so a quiet master and a loud one play at a similar perceived volume. The filter is applied
on both playback paths: the yt-dlp stream (the first play of a track) and the cached file
(local or presigned S3 URL).

`AUDIO_NORMALIZE` selects the mode:

- **`loudnorm`** (default) — one-pass EBU R128, targeting integrated loudness. Exact per-track
  levelling with `AUDIO_TARGET_LUFS` (default `-16` LUFS, range `-30..-5`), `AUDIO_TRUE_PEAK_DB`
  (default `-1.5` dBTP, range `-6..0`), and `AUDIO_LRA` (default `11`, range `1..20`).
- **`dynaudnorm`** — a smoother, faster moving-average normaliser. It evens out a track that is
  itself uneven, but is less exact at matching the target level across tracks. Its window is
  `AUDIO_DYN_FRAME_MS` (default `150`, range `10..500`).
- **`off`** — no filter at all; the decoder emits untouched PCM.

The first play of a track is a stream, so it cannot be measured before it starts: it always uses
the configured live filter above. Once the background download fills the cache, the bot runs a
loudnorm analysis pass on the local file and stores the result for the session. A cached replay
then applies that exact gain (`volume=<gain>dB` plus a −1 dBFS limiter) instead of a live
one-pass normalization, which is more accurate and cheaper at playback time. `AUDIO_TWO_PASS`
(default `true`) turns the analysis pass off; `AUDIO_MAX_GAIN_DB` (default `12`, range `0..24`)
caps the applied gain in both directions, and the true peak still cannot exceed
`AUDIO_TRUE_PEAK_DB`. A failed or silent analysis just falls back to the configured filter.

`/volume` is applied after normalization on the AudioResource's inline volume, so it stays a live
per-guild setting and is never baked into the ffmpeg filter. Normalization costs roughly a few
percent of one CPU core per active stream, on top of decoding.

### Opus bitrate

`AUDIO_BITRATE_KBPS` sets the outgoing Opus bitrate: default `96`, range `16..128`. Two ceilings
apply. The encoder cannot exceed **128 kbps** (`prism-media`'s `setBitrate` clamps there, so a
larger request would silently do nothing), and Discord also caps the stream at the voice channel's
own bitrate — a 64 kbps channel gets 64 kbps even when 96 is configured. The effective value is
re-applied to every new encoder, so it survives the streamed first track, cached playback, seeks
and track changes.

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
