import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { installTestEnv } from "./test-env.js";

installTestEnv();

const {
  BOT_TIMEOUTS,
  botClient,
  botErrorStatus,
  errorFromFetchFailure,
  errorFromHttpResponse,
  isBotErrorShape,
} = await import("./bot-client.js");

describe("errorFromFetchFailure", () => {
  test("maps an aborted timeout to BOT_TIMEOUT", () => {
    const timeout = new DOMException("The operation timed out", "TimeoutError");
    expect(errorFromFetchFailure(timeout)).toEqual({
      code: "BOT_TIMEOUT",
      message: "The bot did not respond in time",
    });
  });

  test("maps an AbortError to BOT_TIMEOUT", () => {
    expect(errorFromFetchFailure(new DOMException("aborted", "AbortError")).code).toBe(
      "BOT_TIMEOUT",
    );
  });

  test("maps network failures to BOT_UNAVAILABLE", () => {
    expect(errorFromFetchFailure(new TypeError("fetch failed"))).toEqual({
      code: "BOT_UNAVAILABLE",
      message: "The bot is unreachable",
    });
    expect(errorFromFetchFailure("nope").code).toBe("BOT_UNAVAILABLE");
    expect(errorFromFetchFailure(undefined).code).toBe("BOT_UNAVAILABLE");
  });
});

describe("errorFromHttpResponse", () => {
  test("passes through a bot error envelope", () => {
    expect(
      errorFromHttpResponse(400, {
        ok: false,
        error: { code: "INVALID_ACTION", message: "Bad action" },
      }),
    ).toEqual({ code: "INVALID_ACTION", message: "Bad action" });
  });

  test("reads a bare error object", () => {
    expect(
      errorFromHttpResponse(500, { error: { code: "BOT_BROKEN", message: "Broken" } }),
    ).toEqual({
      code: "BOT_BROKEN",
      message: "Broken",
    });
  });

  test("falls back to BOT_ERROR for unknown bodies", () => {
    expect(errorFromHttpResponse(502, null)).toEqual({
      code: "BOT_ERROR",
      message: "The bot responded with HTTP 502",
    });
    expect(errorFromHttpResponse(503, { message: "no" }).code).toBe("BOT_ERROR");
  });
});

describe("isBotErrorShape", () => {
  test("requires string code and message", () => {
    expect(isBotErrorShape({ code: "A", message: "B" })).toBe(true);
    expect(isBotErrorShape({ code: 1, message: "B" })).toBe(false);
    expect(isBotErrorShape(null)).toBe(false);
  });
});

describe("botErrorStatus", () => {
  test("maps bot failure codes to HTTP statuses", () => {
    expect(botErrorStatus("BOT_TIMEOUT")).toBe(504);
    expect(botErrorStatus("BOT_UNAVAILABLE")).toBe(503);
    expect(botErrorStatus("BOT_ERROR")).toBe(502);
    expect(botErrorStatus("GUILD_NOT_FOUND")).toBe(404);
    expect(botErrorStatus("PLAYBACK_BUSY")).toBe(409);
    expect(botErrorStatus("NOT_CONNECTED")).toBe(409);
    expect(botErrorStatus("COOLDOWN")).toBe(409);
    expect(botErrorStatus("VALIDATION")).toBe(400);
    expect(botErrorStatus("MEDIA_ERROR")).toBe(400);
  });

  test("unknown codes are bad-gateway, never a client error", () => {
    expect(botErrorStatus("SOMETHING_NEW")).toBe(502);
    expect(botErrorStatus("")).toBe(502);
  });
});

describe("request timeouts", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("actions wait 90s while state stays at 5s", async () => {
    const timeoutSpy = spyOn(AbortSignal, "timeout");
    const seen: number[] = [];
    timeoutSpy.mockImplementation((ms: number) => {
      seen.push(ms);
      return new AbortController().signal;
    });

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true, data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    try {
      await botClient.action("guild-1", { type: "pause" });
      await botClient.state("guild-1");
    } finally {
      timeoutSpy.mockRestore();
    }

    expect(seen).toEqual([BOT_TIMEOUTS.action, BOT_TIMEOUTS.state]);
    expect(BOT_TIMEOUTS.action).toBe(90_000);
    expect(BOT_TIMEOUTS.state).toBe(5_000);
  });
});
