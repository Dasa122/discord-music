import { describe, expect, test } from "bun:test";
import { installTestEnv } from "../test-env.js";

installTestEnv();

const { livenessStatus, readinessStatus } = await import("./health.js");

describe("livenessStatus", () => {
  test("is 200 while the process is up, whatever the dependencies say", () => {
    expect(livenessStatus({ database: true, bot: true })).toBe(200);
    expect(livenessStatus({ database: false, bot: true })).toBe(200);
    expect(livenessStatus({ database: true, bot: false })).toBe(200);
    expect(livenessStatus({ database: false, bot: false })).toBe(200);
  });
});

describe("readinessStatus", () => {
  test("is 200 only when the database is reachable", () => {
    expect(readinessStatus({ database: true, bot: true })).toBe(200);
    expect(readinessStatus({ database: true, bot: false })).toBe(200);
  });

  test("is 503 when the database is down, even if the bot is up", () => {
    expect(readinessStatus({ database: false, bot: true })).toBe(503);
    expect(readinessStatus({ database: false, bot: false })).toBe(503);
  });
});
