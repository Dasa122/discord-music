import { describe, expect, test } from "bun:test";
import { installTestEnv } from "../test-env.js";

installTestEnv();

const {
  AuthError,
  assertNonceMatch,
  buildAuthorizeUrlFrom,
  createPkcePair,
  discoveryUrl,
  exchangeCode,
  parseTokenErrorBody,
  pkceChallenge,
  randomToken,
  requireIdToken,
  stateMatches,
} = await import("./authentik.js");

const DISCOVERY = {
  issuer: "https://auth.example.test/application/o/music/",
  authorization_endpoint: "https://auth.example.test/application/o/authorize/",
  token_endpoint: "https://auth.example.test/application/o/token/",
  jwks_uri: "https://auth.example.test/application/o/music/jwks/",
  userinfo_endpoint: "https://auth.example.test/application/o/userinfo/",
};

describe("PKCE", () => {
  test("S256 matches the RFC 7636 appendix B vector", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(pkceChallenge(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  test("generated verifier is base64url and its challenge is derived from it", () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(pkceChallenge(verifier));
    expect(challenge).not.toBe(verifier);
  });

  test("random tokens differ", () => {
    expect(randomToken(32)).not.toBe(randomToken(32));
  });
});

describe("authorize URL", () => {
  test("contains every required parameter with S256", () => {
    const url = new URL(
      buildAuthorizeUrlFrom(DISCOVERY, {
        clientId: "client-123",
        redirectUri: "https://music.example.test/api/auth/callback",
        state: "state-value",
        nonce: "nonce-value",
        codeChallenge: "challenge-value",
      }),
    );

    expect(url.origin + url.pathname).toBe(DISCOVERY.authorization_endpoint);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://music.example.test/api/auth/callback",
    );
    expect(url.searchParams.get("scope")).toBe("openid profile email");
    expect(url.searchParams.get("state")).toBe("state-value");
    expect(url.searchParams.get("nonce")).toBe("nonce-value");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-value");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  test("discovery URL tolerates issuers with and without a trailing slash", () => {
    expect(discoveryUrl("https://auth.example.test/application/o/music")).toBe(
      "https://auth.example.test/application/o/music/.well-known/openid-configuration",
    );
    expect(discoveryUrl("https://auth.example.test/application/o/music/")).toBe(
      "https://auth.example.test/application/o/music/.well-known/openid-configuration",
    );
  });
});

describe("state and nonce", () => {
  test("matching values are accepted", () => {
    expect(stateMatches("abc", "abc")).toBe(true);
    expect(() => assertNonceMatch("abc", "abc")).not.toThrow();
  });

  test("state mismatch is rejected", () => {
    expect(stateMatches("abc", "abd")).toBe(false);
    expect(stateMatches("abc", "abcd")).toBe(false);
  });

  test("nonce mismatch and non-string nonce raise AuthError", () => {
    for (const value of ["other", undefined, 42, null]) {
      try {
        assertNonceMatch(value, "expected");
        throw new Error("expected assertNonceMatch to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(AuthError);
        expect((error as InstanceType<typeof AuthError>).code).toBe("INVALID_NONCE");
      }
    }
  });
});

describe("requireIdToken", () => {
  test("returns the ID token from a valid response", () => {
    expect(requireIdToken({ id_token: "header.payload.signature" })).toBe(
      "header.payload.signature",
    );
  });

  test("rejects a response without an ID token instead of using userinfo", () => {
    for (const body of [
      { access_token: "access-only" },
      { id_token: "" },
      { id_token: 42 },
      null,
      "not-an-object",
    ]) {
      expect(() => requireIdToken(body)).toThrow(AuthError);
      try {
        requireIdToken(body);
      } catch (error) {
        expect((error as InstanceType<typeof AuthError>).code).toBe("MISSING_ID_TOKEN");
      }
    }
  });
});

describe("parseTokenErrorBody", () => {
  test("extracts only the provider error code and description", () => {
    expect(
      parseTokenErrorBody(
        JSON.stringify({
          error: "invalid_client",
          error_description: "Client authentication failed.",
        }),
      ),
    ).toEqual({
      error: "invalid_client",
      errorDescription: "Client authentication failed.",
    });
  });

  test("truncates and strips CR/LF and control characters", () => {
    const diagnostics = parseTokenErrorBody(
      JSON.stringify({
        error: `invalid_client\r\n\u0000${"e".repeat(200)}`,
        error_description: `line one\r\nline two\u0007${"d".repeat(300)}`,
      }),
    );

    expect(diagnostics.error).toHaveLength(64);
    expect(diagnostics.error?.startsWith("invalid_client e")).toBe(true);
    expect(diagnostics.errorDescription).toHaveLength(200);
    expect(diagnostics.errorDescription?.startsWith("line one line two d")).toBe(true);
    for (const value of [diagnostics.error, diagnostics.errorDescription]) {
      for (const char of value ?? "") {
        const code = char.codePointAt(0) ?? 0;
        expect(code < 0x20 || code === 0x7f).toBe(false);
      }
    }
  });

  test("never surfaces tokens or other response fields", () => {
    const diagnostics = parseTokenErrorBody(
      JSON.stringify({
        error: "invalid_grant",
        error_description: "The authorization code expired.",
        access_token: "access-token-must-not-leak",
        refresh_token: "refresh-token-must-not-leak",
        id_token: "id-token-must-not-leak",
        session_state: "session-must-not-leak",
      }),
    );

    expect(Object.keys(diagnostics).sort()).toEqual(["error", "errorDescription"]);
    expect(JSON.stringify(diagnostics)).not.toContain("must-not-leak");
  });

  test("returns no diagnostics for non-JSON bodies", () => {
    expect(parseTokenErrorBody("<html>bad gateway</html>")).toEqual({});
    expect(parseTokenErrorBody("invalid_grant")).toEqual({});
    expect(parseTokenErrorBody("")).toEqual({});
    expect(parseTokenErrorBody("null")).toEqual({});
  });
});

describe("exchangeCode token failures", () => {
  const discoveryUrlForTest = discoveryUrl(DISCOVERY.issuer);

  async function withTokenResponse(
    tokenResponse: () => Response,
    run: () => Promise<unknown>,
  ): Promise<unknown> {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === discoveryUrlForTest) {
        return new Response(JSON.stringify(DISCOVERY), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return tokenResponse();
    }) as typeof fetch;

    try {
      return await run();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  async function caught(run: () => Promise<unknown>): Promise<InstanceType<typeof AuthError>> {
    try {
      await run();
    } catch (error) {
      expect(error).toBeInstanceOf(AuthError);
      return error as InstanceType<typeof AuthError>;
    }
    throw new Error("expected exchangeCode to throw");
  }

  test("includes the provider error code in a typed TOKEN_EXCHANGE_FAILED error", async () => {
    const error = await caught(() =>
      withTokenResponse(
        () =>
          new Response(JSON.stringify({ error: "invalid_grant", error_description: "expired" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
        () => exchangeCode("code", "verifier", "nonce"),
      ),
    );

    expect(error.code).toBe("TOKEN_EXCHANGE_FAILED");
    expect(error.status).toBe(502);
    expect(error.message).toBe("Authentication with the identity provider failed (invalid_grant)");
    expect(error.message).not.toContain("expired");
  });

  test("non-JSON error bodies still raise TOKEN_EXCHANGE_FAILED without a code", async () => {
    const error = await caught(() =>
      withTokenResponse(
        () => new Response("upstream said no", { status: 503 }),
        () => exchangeCode("code", "verifier", "nonce"),
      ),
    );

    expect(error.code).toBe("TOKEN_EXCHANGE_FAILED");
    expect(error.status).toBe(502);
    expect(error.message).toBe("Authentication with the identity provider failed");
  });
});
