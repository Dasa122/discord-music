import { describe, expect, test } from "bun:test";
import { redactProxyCredentials, sanitizeProcessOutput } from "./logger.js";

describe("redactProxyCredentials", () => {
  test("strips userinfo from proxy URLs", () => {
    expect(redactProxyCredentials("using https://user:pass@proxy.example:8080")).toBe(
      "using https://[REDACTED]@proxy.example:8080",
    );
    expect(redactProxyCredentials("http://user@proxy.example")).toBe("http://user@proxy.example");
  });

  test("redacts every occurrence and keeps credential-free hosts", () => {
    expect(redactProxyCredentials("a socks5://u:p@a.example b https://proxy.example/path")).toBe(
      "a socks5://[REDACTED]@a.example b https://proxy.example/path",
    );
  });
});

describe("sanitizeProcessOutput", () => {
  test("keeps only the last N non-empty lines", () => {
    const output = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n");
    const sanitized = sanitizeProcessOutput(output);
    const lines = sanitized.split("\n");
    expect(lines).toHaveLength(20);
    expect(lines[0]).toBe("line 11");
    expect(lines[19]).toBe("line 30");
  });

  test("drops blank lines and CRLF noise", () => {
    expect(sanitizeProcessOutput("a\r\n\r\nb\r\n")).toBe("a\nb");
  });

  test("redacts proxy credentials and tolerates undefined", () => {
    expect(sanitizeProcessOutput("via https://u:p@proxy.example")).toBe(
      "via https://[REDACTED]@proxy.example",
    );
    expect(sanitizeProcessOutput(undefined)).toBe("");
  });
});
