export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SECRET_KEY_PATTERN = /token|secret|password|authorization|cookie|api[-_]?key/i;

/**
 * `https://user:pass@proxy.example` leaks credentials into logs when yt-dlp
 * echoes a proxy URL. Redact the userinfo, keep the scheme and host.
 */
const PROXY_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi;

export function redactProxyCredentials(text: string): string {
  return text.replace(PROXY_CREDENTIALS, "$1[REDACTED]@");
}

/**
 * Process output is diagnostics, not a transcript: strip proxy credentials and
 * keep only the tail so one noisy extractor cannot flood the log.
 */
export function sanitizeProcessOutput(text: string | undefined, maxLines = 20): string {
  if (!text) return "";
  return redactProxyCredentials(text)
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .slice(-Math.max(1, maxLines))
    .join("\n");
}

let threshold = parseLevel(process.env.LOG_LEVEL);

function parseLevel(value: string | undefined): number {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "debug") return LEVEL_ORDER.debug;
  if (normalized === "warn") return LEVEL_ORDER.warn;
  if (normalized === "error") return LEVEL_ORDER.error;
  return LEVEL_ORDER.info;
}

export function setLogLevel(level: LogLevel): void {
  threshold = LEVEL_ORDER[level];
}

function replacer(this: unknown, key: string, value: unknown): unknown {
  if (SECRET_KEY_PATTERN.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactProxyCredentials(value);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  return value;
}

function write(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < threshold) return;

  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  };

  let serialized: string;
  try {
    serialized = JSON.stringify(line, replacer);
  } catch {
    serialized = JSON.stringify({ ts: line.ts, level, msg, fields: "[unserializable]" });
  }

  const output = `${serialized}\n`;
  if (level === "warn" || level === "error") process.stderr.write(output);
  else process.stdout.write(output);
}

export const logger = {
  debug(msg: string, fields?: Record<string, unknown>): void {
    write("debug", msg, fields);
  },
  info(msg: string, fields?: Record<string, unknown>): void {
    write("info", msg, fields);
  },
  warn(msg: string, fields?: Record<string, unknown>): void {
    write("warn", msg, fields);
  },
  error(msg: string, fields?: Record<string, unknown>): void {
    write("error", msg, fields);
  },
};
