import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { MediaError } from "../errors.js";

export interface UrlGuardOptions {
  /** Injectable DNS resolver (tests); defaults to `dns.lookup(host, { all: true })`. */
  resolveHost?: (hostname: string) => Promise<string[]>;
}

/** Loopback, private, and link-local ranges that must never reach yt-dlp. */
export function isPrivateAddress(address: string): boolean {
  const value = address
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (!value) return true;

  const mapped = ipv4FromMappedIpv6(value);
  const candidate = mapped ?? value;

  const family = isIP(candidate);
  if (family === 4) return isPrivateIpv4(candidate);
  if (family === 6) return isPrivateIpv6(candidate);
  return false;
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  const [a, b] = octets;
  if (a === undefined || b === undefined) return true;

  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function isPrivateIpv6(address: string): boolean {
  const value = address.split("%")[0] ?? address;

  // ::1 in any equivalent spelling.
  const groups = value.split(":");
  let zeroGroups = 0;
  let oneGroups = 0;
  let otherGroups = false;
  for (const group of groups) {
    if (group === "" || /^0+$/.test(group)) zeroGroups += 1;
    else if (/^0*1$/.test(group)) oneGroups += 1;
    else otherGroups = true;
  }
  if (!otherGroups && oneGroups === 1) return true;
  if (!otherGroups && oneGroups === 0 && zeroGroups > 0) return true; // ::

  const first = groups[0] ?? "";
  if (first) {
    const numeric = Number.parseInt(first, 16);
    if (Number.isFinite(numeric) && (numeric & 0xffc0) === 0xfe80) return true; // fe80::/10
    if (/^(fc|fd)/.test(first)) return true; // fc00::/7
  }
  return false;
}

function ipv4FromMappedIpv6(value: string): string | null {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (dotted?.[1]) return dotted[1];

  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(value);
  if (!hex?.[1] || !hex[2]) return null;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

/** Hosts yt-dlp is expected to talk to (and their subdomains). */
export const ALLOWED_MEDIA_HOSTS = [
  "youtube.com",
  "youtu.be",
  "youtube-nocookie.com",
  "googlevideo.com",
  "ytimg.com",
] as const;

/** Direct media files may only use these extensions. */
export const ALLOWED_MEDIA_EXTENSIONS = [
  ".mp3",
  ".m4a",
  ".opus",
  ".ogg",
  ".webm",
  ".mp4",
  ".aac",
  ".flac",
  ".wav",
] as const;

/** Strip the brackets `URL#hostname` keeps on IPv6 literals. */
export function bareHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
}

export function isAllowedMediaHost(hostname: string): boolean {
  const host = bareHostname(hostname).replace(/\.$/, "");
  return ALLOWED_MEDIA_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

export function hasAllowedMediaExtension(pathname: string): boolean {
  const path = pathname.toLowerCase();
  return ALLOWED_MEDIA_EXTENSIONS.some((extension) => path.endsWith(extension));
}

/**
 * The single allow predicate every yt-dlp spawn path shares.
 *
 * Accepted: `https` on port 443 (or the default) for a known media host, or a
 * direct media file URL ending in one of `ALLOWED_MEDIA_EXTENSIONS`.
 * `ytsearch:`/bare text never reach this function.
 */
export function isAllowedMediaTarget(url: URL): boolean {
  if (url.protocol !== "https:") return false;
  if (url.port !== "" && url.port !== "443") return false;

  const hostname = bareHostname(url.hostname);
  if (isAllowedMediaHost(hostname)) return true;
  return hasAllowedMediaExtension(url.pathname);
}

/**
 * Only `ytsearch:`/bare text queries plus the allow-listed targets above may
 * reach yt-dlp. Literal private IPs are rejected without DNS; hostnames are
 * resolved and every answer is checked, which stops DNS-rebinding and
 * loopback/link-local SSRF attempts even for an allow-listed host.
 */
export async function assertSafeMediaQuery(
  raw: string,
  options: UrlGuardOptions = {},
): Promise<string> {
  const value = raw.trim();
  if (!value) return value;

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
  if (scheme === undefined) return value; // bare text becomes a ytsearch query
  if (/^ytsearch\d*:/i.test(value)) return value;
  if (scheme !== "https") {
    throw new MediaError("INVALID_URL", "Only https:// URLs and text searches are supported.");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MediaError("INVALID_URL", "That URL is not valid.");
  }
  if (!url.hostname || !isAllowedMediaTarget(url)) {
    throw new MediaError(
      "INVALID_URL",
      "Only YouTube links, direct audio/video files, and text searches are supported.",
    );
  }

  const hostname = bareHostname(url.hostname);
  if (isPrivateAddress(hostname)) {
    throw new MediaError("INVALID_URL", "That host is not allowed.");
  }

  if (isIP(hostname) === 0) {
    const resolveHost = options.resolveHost ?? defaultResolveHost;
    let addresses: string[];
    try {
      addresses = await resolveHost(hostname);
    } catch {
      throw new MediaError("INVALID_URL", "That host could not be resolved.");
    }
    if (addresses.length === 0 || addresses.some((address) => isPrivateAddress(address))) {
      throw new MediaError("INVALID_URL", "That host is not allowed.");
    }
  }

  return value;
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}
