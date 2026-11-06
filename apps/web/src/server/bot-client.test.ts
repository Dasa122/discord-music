import { describe, expect, test } from "bun:test";
import { installTestEnv } from "./test-env.js";

installTestEnv();

const { botErrorStatus, errorFromFetchFailure, errorFromHttpResponse, isBotErrorShape } =
  await import("./bot-client.js");

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
    expect(botErrorStatus("INVALID_ACTION")).toBe(400);
  });
});
