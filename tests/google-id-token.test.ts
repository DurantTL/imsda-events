import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ getServerEnv: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ getServerEnv: dependencies.getServerEnv }));

import {
  isGoogleSignInConfigured,
  resetGoogleSigningKeyCache,
  verifyGoogleIdToken,
} from "@/integrations/oauth/google";

/**
 * These run against a real RSA key pair rather than a stubbed verifier. The
 * point of this module is that it refuses tokens it should refuse, and a mocked
 * signature check would test nothing at all.
 */

const CLIENT_ID = "1234.apps.googleusercontent.com";
const KID = "test-key-1";

let privateKey: KeyObject;
let publicJwk: Record<string, unknown>;

function segment(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function signToken(
  payloadOverrides: Record<string, unknown> = {},
  headerOverrides: Record<string, unknown> = {},
  signWith: KeyObject = privateKey,
) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", kid: KID, typ: "JWT", ...headerOverrides };
  const payload = {
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    sub: "google-subject-1",
    email: "person@example.com",
    email_verified: true,
    name: "A Person",
    nonce: "the-nonce",
    iat: now,
    exp: now + 3600,
    ...payloadOverrides,
  };
  const signed = `${segment(header)}.${segment(payload)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signed);
  signer.end();
  return `${signed}.${signer.sign(signWith).toString("base64url")}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetGoogleSigningKeyCache();
  dependencies.getServerEnv.mockReturnValue({
    APP_BASE_URL: "https://events.imsda.org",
    GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: "a-client-secret",
  });

  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  privateKey = pair.privateKey;
  publicJwk = { ...pair.publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };

  vi.stubGlobal("fetch", vi.fn(async () => new Response(
    JSON.stringify({ keys: [publicJwk] }),
    { status: 200, headers: { "cache-control": "public, max-age=3600" } },
  )));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a token that should be believed", () => {
  it("returns the identity", async () => {
    const identity = await verifyGoogleIdToken(signToken(), "the-nonce");
    expect(identity).toEqual({
      subject: "google-subject-1",
      email: "person@example.com",
      emailVerified: true,
      name: "A Person",
    });
  });

  it("normalises the address the way account matching does", async () => {
    const identity = await verifyGoogleIdToken(
      signToken({ email: "Person@Example.COM" }),
      "the-nonce",
    );
    expect(identity.email).toBe("person@example.com");
  });

  it("accepts either issuer spelling Google uses", async () => {
    for (const iss of ["https://accounts.google.com", "accounts.google.com"]) {
      await expect(verifyGoogleIdToken(signToken({ iss }), "the-nonce")).resolves.toBeTruthy();
    }
  });

  it("accepts an audience array containing this client", async () => {
    const identity = await verifyGoogleIdToken(
      signToken({ aud: ["someone-else", CLIENT_ID] }),
      "the-nonce",
    );
    expect(identity.subject).toBe("google-subject-1");
  });

  it("reads the legacy string form of email_verified", async () => {
    const identity = await verifyGoogleIdToken(
      signToken({ email_verified: "true" }),
      "the-nonce",
    );
    expect(identity.emailVerified).toBe(true);
  });
});

describe("a token that must be refused", () => {
  it("rejects a bad signature", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    await expect(verifyGoogleIdToken(signToken({}, {}, other.privateKey), "the-nonce"))
      .rejects.toThrow(/signature is not valid/i);
  });

  it("rejects alg: none and anything else that is not RS256", async () => {
    // The algorithm-confusion family, closed by refusing rather than by
    // trusting a library default.
    for (const alg of ["none", "HS256", "RS512"]) {
      await expect(verifyGoogleIdToken(signToken({}, { alg }), "the-nonce"))
        .rejects.toThrow(/RS256/);
    }
  });

  it("rejects a token minted for a different application", async () => {
    await expect(verifyGoogleIdToken(signToken({ aud: "another-client" }), "the-nonce"))
      .rejects.toThrow(/different application/i);
  });

  it("rejects a token from another issuer", async () => {
    await expect(verifyGoogleIdToken(signToken({ iss: "https://evil.example" }), "the-nonce"))
      .rejects.toThrow(/not issued by Google/i);
  });

  it("rejects an expired token", async () => {
    const past = Math.floor(Date.now() / 1000) - 7200;
    await expect(verifyGoogleIdToken(signToken({ iat: past, exp: past + 60 }), "the-nonce"))
      .rejects.toThrow(/expired/i);
  });

  it("rejects a token issued in the future", async () => {
    const ahead = Math.floor(Date.now() / 1000) + 7200;
    await expect(verifyGoogleIdToken(signToken({ iat: ahead, exp: ahead + 3600 }), "the-nonce"))
      .rejects.toThrow(/future/i);
  });

  it("rejects a token belonging to a different sign-in attempt", async () => {
    // Replay: a token Google legitimately issued, presented into a session that
    // did not ask for it.
    await expect(verifyGoogleIdToken(signToken({ nonce: "someone-elses" }), "the-nonce"))
      .rejects.toThrow(/does not match this sign-in/i);
    await expect(verifyGoogleIdToken(signToken({ nonce: undefined }), "the-nonce"))
      .rejects.toThrow(/does not match this sign-in/i);
  });

  it("rejects a token with no subject or no address", async () => {
    await expect(verifyGoogleIdToken(signToken({ sub: undefined }), "the-nonce"))
      .rejects.toThrow(/missing an identifier or an address/i);
    await expect(verifyGoogleIdToken(signToken({ email: undefined }), "the-nonce"))
      .rejects.toThrow(/missing an identifier or an address/i);
  });

  it("rejects a malformed token", async () => {
    for (const malformed of ["", "a.b", "a.b.c.d"]) {
      await expect(verifyGoogleIdToken(malformed, "the-nonce")).rejects.toThrow();
    }
  });

  it("reports an unverified address rather than silently trusting it", async () => {
    // Not a throw: the caller refuses this one with a message a person can act
    // on, so it has to come back as data.
    const identity = await verifyGoogleIdToken(
      signToken({ email_verified: false }),
      "the-nonce",
    );
    expect(identity.emailVerified).toBe(false);
  });
});

describe("signing keys", () => {
  it("refetches once when the key id is unknown, then gives up", async () => {
    const token = signToken({}, { kid: "rotated-key" });
    await expect(verifyGoogleIdToken(token, "the-nonce")).rejects.toThrow(/signature is not valid/i);
    // One cached read plus one refresh — not an unbounded retry against Google.
    expect(vi.mocked(fetch).mock.calls.length).toBe(2);
  });

  it("caches keys between verifications", async () => {
    await verifyGoogleIdToken(signToken(), "the-nonce");
    await verifyGoogleIdToken(signToken(), "the-nonce");
    expect(vi.mocked(fetch).mock.calls.length).toBe(1);
  });
});

describe("configuration", () => {
  it("is off unless both halves are present", () => {
    expect(isGoogleSignInConfigured()).toBe(true);

    for (const partial of [
      { GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET: undefined },
      { GOOGLE_OAUTH_CLIENT_ID: undefined, GOOGLE_OAUTH_CLIENT_SECRET: "a-client-secret" },
      { GOOGLE_OAUTH_CLIENT_ID: undefined, GOOGLE_OAUTH_CLIENT_SECRET: undefined },
    ]) {
      dependencies.getServerEnv.mockReturnValue({
        APP_BASE_URL: "https://events.imsda.org",
        ...partial,
      });
      expect(isGoogleSignInConfigured()).toBe(false);
    }
  });
});
