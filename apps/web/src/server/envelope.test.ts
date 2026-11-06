import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  failure,
  issueFromZod,
  jsonBodyTooLarge,
  MAX_JSON_BODY_BYTES,
  payloadTooLargeFailure,
  readJsonBody,
  success,
  validationFailure,
} from "./envelope.js";

describe("envelope helpers", () => {
  test("success wraps data", () => {
    expect(success({ value: 1 })).toEqual({ success: true, data: { value: 1 } });
    expect(success(null)).toEqual({ success: true, data: null });
  });

  test("failure wraps an error code and message", () => {
    expect(failure("NOT_FOUND", "Missing")).toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "Missing" },
    });
  });

  test("failure includes issues and details only when provided", () => {
    const withIssues = failure("VALIDATION_ERROR", "Bad", {
      issues: [{ path: "name", message: "Required" }],
    });
    expect(withIssues.error.issues).toEqual([{ path: "name", message: "Required" }]);
    expect(withIssues.error.details).toBeUndefined();

    const withDetails = failure("UNHEALTHY", "Down", { details: { dependencies: { bot: false } } });
    expect(withDetails.error.details).toEqual({ dependencies: { bot: false } });
  });

  test("validationFailure maps zod issues to dotted paths", () => {
    const result = z
      .object({ name: z.string().min(2), nested: z.object({ id: z.number() }) })
      .safeParse({
        name: "a",
        nested: {},
      });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected failure");

    const issues = issueFromZod(result.error);
    expect(issues.map((issue) => issue.path)).toEqual(["name", "nested.id"]);

    const envelope = validationFailure(result.error);
    expect(envelope.error.code).toBe("VALIDATION_ERROR");
    expect(envelope.error.issues?.length).toBe(2);
  });

  test("readJsonBody returns null for malformed JSON", async () => {
    expect(
      await readJsonBody(new Request("https://example.test", { method: "POST", body: "{" })),
    ).toBeNull();
    expect(
      await readJsonBody(new Request("https://example.test", { method: "POST", body: '{"a":1}' })),
    ).toEqual({ a: 1 });
  });

  test("rejects declared bodies over 256 KB", () => {
    expect(MAX_JSON_BODY_BYTES).toBe(262_144);
    expect(jsonBodyTooLarge(null)).toBe(false);
    expect(jsonBodyTooLarge(undefined)).toBe(false);
    expect(jsonBodyTooLarge("")).toBe(false);
    expect(jsonBodyTooLarge("1024")).toBe(false);
    expect(jsonBodyTooLarge(String(MAX_JSON_BODY_BYTES))).toBe(false);
    expect(jsonBodyTooLarge(String(MAX_JSON_BODY_BYTES + 1))).toBe(true);
    expect(jsonBodyTooLarge("not-a-number")).toBe(false);
  });

  test("payloadTooLargeFailure is a 413 envelope", () => {
    expect(payloadTooLargeFailure()).toEqual({
      success: false,
      error: { code: "PAYLOAD_TOO_LARGE", message: "Request body is too large" },
    });
  });
});
