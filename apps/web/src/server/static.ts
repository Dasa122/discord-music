import { existsSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import type { Context } from "hono";
import { config } from "./config.js";
import { failure } from "./envelope.js";

/**
 * Static SPA serving for `apps/web/dist`.
 *
 * The dist directory is probed at boot: from `src/server` it is `../../dist`
 * both in the repo and in the web image, and the cwd fallback covers a bundled
 * entrypoint.
 */

const ASSET_CACHE = "public, max-age=31536000, immutable";
const STATIC_CACHE = "public, max-age=3600";

const MIME_BY_EXTENSION: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/**
 * Source maps are build artefacts: never expose them from the production
 * server, and keep `.map` out of the MIME table so a dev-only serve cannot be
 * cached as a JavaScript asset.
 */
export function isBlockedAssetPath(pathname: string, isProduction: boolean): boolean {
  return isProduction && pathname.toLowerCase().endsWith(".map");
}

let distDir: string | null | undefined;

export function resolveWebDistDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [
    env.WEB_DIST_DIR,
    resolve(import.meta.dir, "../../dist"),
    resolve(process.cwd(), "apps/web/dist"),
    "/app/apps/web/dist",
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (existsSync(join(candidate, "index.html"))) return candidate;
  }
  return null;
}

function webDistDir(): string | null {
  if (distDir === undefined) distDir = resolveWebDistDir();
  return distDir;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function cacheControlFor(pathname: string): string {
  return pathname.startsWith("/assets/") ? ASSET_CACHE : STATIC_CACHE;
}

/** Content type for a served file; unknown extensions are opaque bytes. */
export function contentTypeFor(path: string): string {
  return MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function fileResponse(path: string, pathname: string): Response {
  const headers = new Headers({
    "cache-control": cacheControlFor(pathname),
    "content-type": contentTypeFor(path),
  });
  return new Response(Bun.file(path), { headers });
}

function indexResponse(path: string): Response {
  return new Response(Bun.file(path), {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
    },
  });
}

/** Serves a built asset, otherwise the SPA shell. Never used for `/api/*`. */
export async function serveSpa(c: Context): Promise<Response> {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    return c.json(failure("NOT_FOUND", "Not found"), 404);
  }

  const dir = webDistDir();
  if (!dir) return c.text("Web assets are not built", 404);

  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(c.req.url).pathname);
  } catch {
    return c.json(failure("NOT_FOUND", "Not found"), 404);
  }

  const segments = pathname.split("/");
  if (pathname.includes("\0") || segments.includes("..")) {
    return c.json(failure("NOT_FOUND", "Not found"), 404);
  }
  if (isBlockedAssetPath(pathname, config.isProduction)) {
    return c.json(failure("NOT_FOUND", "Not found"), 404);
  }

  if (pathname !== "/") {
    const candidate = resolve(dir, `.${pathname}`);
    if (candidate.startsWith(`${dir}${sep}`) && isFile(candidate)) {
      return fileResponse(candidate, pathname);
    }
  }

  const index = join(dir, "index.html");
  if (!isFile(index)) return c.text("Web assets are not built", 404);
  return indexResponse(index);
}
