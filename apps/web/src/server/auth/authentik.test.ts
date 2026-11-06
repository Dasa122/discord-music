import { describe, expect, test } from "bun:test";
import { installTestEnv } from "../test-env.js";

installTestEnv();

const {
  AuthError,
  assertNonceMatch,
  buildAuthorizeUrlFrom,
  createPkcePair,
  discoveryUrl,
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
