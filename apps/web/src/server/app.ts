import { Hono } from "hono";
import { requireAdmin, requireSameOrigin } from "./auth/session.js";
import { failure } from "./envelope.js";
import { authRoutes, meRoutes } from "./routes/auth.js";
import { guildRoutes } from "./routes/guilds.js";
import { healthRoutes } from "./routes/health.js";
import { historyRoutes } from "./routes/history.js";
import { playlistRoutes } from "./routes/playlists.js";
import { settingsRoutes } from "./routes/settings.js";
import { serveSpa } from "./static.js";
import type { AppEnv } from "./types.js";

export const app = new Hono<AppEnv>();

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  // Tailwind/React emit style attributes; scripts stay same-origin only.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' https:",
].join("; ");

app.use("*", async (c, next) => {
  const requestId = crypto.randomUUID();
  const startedAt = performance.now();
  c.set("requestId", requestId);
  c.header("x-request-id", requestId);

  let status = 500;
  try {
    await next();
    status = c.res.status;
  } finally {
    console.log(
      JSON.stringify({
        level: "info",
        msg: "request",
        requestId,
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        status,
        durationMs: Math.round(performance.now() - startedAt),
      }),
    );
  }
});

app.use("*", async (c, next) => {
  await next();

  // Set after the response exists: handlers that return a raw `Response`
  // (static files, the SPA shell) would otherwise drop prepared headers.
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Frame-Options", "DENY");
  c.header("Content-Security-Policy", CONTENT_SECURITY_POLICY);
});

/** CSRF guard for every mutating `/api/*` call except the OIDC callback. */
app.use("/api/*", async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
  if (new URL(c.req.url).pathname === "/api/auth/callback") return next();
  return requireSameOrigin(c, next);
});

app.route("/api", healthRoutes);
app.route("/api/auth", authRoutes);
app.route("/api", meRoutes);

// Protected routers. Registered before them so Hono attaches the middleware
// to every route below; public auth/health routes are already registered.
app.use("/api/guilds", requireAdmin);
app.use("/api/guilds/*", requireAdmin);
app.use("/api/playlists", requireAdmin);
app.use("/api/playlists/*", requireAdmin);

app.route("/api", guildRoutes);
app.route("/api", settingsRoutes);
app.route("/api", playlistRoutes);
app.route("/api", historyRoutes);

// API paths never fall through to the SPA shell.
app.all("/api", (c) => c.json(failure("NOT_FOUND", "Not found"), 404));
app.all("/api/*", (c) => c.json(failure("NOT_FOUND", "Not found"), 404));

app.all("*", serveSpa);

app.onError((error, c) => {
  console.error(
    JSON.stringify({
      level: "error",
      msg: "unhandled_error",
      path: new URL(c.req.url).pathname,
      error: error instanceof Error ? error.message : String(error),
    }),
  );

  if (new URL(c.req.url).pathname.startsWith("/api/")) {
    return c.json(failure("INTERNAL_ERROR", "Internal server error"), 500);
  }
  return c.text("Internal server error", 500);
});
