type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Defence in depth: these keys never reach the log even if a caller passes them. */
const SECRET_KEY_PATTERN = /token|secret|password|authorization|cookie|api[-_]?key/i;

let threshold = parseThreshold(process.env.LOG_LEVEL);

function parseThreshold(value: string | undefined): number {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "debug") return LEVEL_ORDER.debug;
  if (normalized === "warn") return LEVEL_ORDER.warn;
  if (normalized === "error") return LEVEL_ORDER.error;
  return LEVEL_ORDER.info;
}

export function setLogLevel(level: LogLevel): void {
  threshold = LEVEL_ORDER[level];
}

export type LogFields = { event: string } & Record<string, unknown>;

function redact(fields: LogFields): LogFields {
  const safe: LogFields = { ...fields };
  for (const key of Object.keys(safe)) {
    if (SECRET_KEY_PATTERN.test(key)) safe[key] = "[REDACTED]";
  }
  return safe;
}

function write(level: LogLevel, fields: LogFields): void {
  if (LEVEL_ORDER[level] < threshold) return;
  const line = { ts: new Date().toISOString(), level, ...redact(fields) };
  const output = `${JSON.stringify(line)}\n`;
  if (level === "warn" || level === "error") process.stderr.write(output);
  else process.stdout.write(output);
}

/** Structured, secret-redacting JSON logs — one line per event. */
export const logger = {
  debug(fields: LogFields): void {
    write("debug", fields);
  },
  info(fields: LogFields): void {
    write("info", fields);
  },
  warn(fields: LogFields): void {
    write("warn", fields);
  },
  error(fields: LogFields): void {
    write("error", fields);
  },
};
