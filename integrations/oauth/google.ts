import "server-only";

import { createHash, createPublicKey, createVerify, randomBytes } from "node:crypto";
import { getServerEnv } from "@/lib/env";

/**
 * Google as an OpenID Connect provider, for attendee sign-in only.
 *
 * Written against the protocol rather than pulled from a library, for the same
 * reason the rest of this codebase holds its own session and token handling:
 * the parts that matter here are the checks, and a dependency that performs
 * them silently is a dependency whose checks nobody has read.
 *
 * What is deliberately *not* here: staff. `/api/auth/login` carries the MFA
 * gate that guards roster export and sensitive data, and Google cannot tell us
 * whether a given sign-in involved a second factor — the `amr` and `acr` claims
 * are not populated for consumer accounts. Federating that path would replace a
 * verified factor with an unverifiable assertion.
 */

const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const JWKS_URI = "https://www.googleapis.com/oauth2/v3/certs";
/** Google issues under both spellings; both are legitimate. */
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

/** Tolerance for clock skew between this host and Google, in seconds. */
const CLOCK_SKEW_SECONDS = 120;

export class GoogleOAuthNotConfiguredError extends Error {
  readonly code = "GOOGLE_OAUTH_NOT_CONFIGURED";

  constructor() {
    super("Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET to offer Google sign-in.");
    this.name = "GoogleOAuthNotConfiguredError";
  }
}

export class GoogleOAuthError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(message);
    this.name = "GoogleOAuthError";
  }
}

export function isGoogleSignInConfigured() {
  const env = getServerEnv();
  return Boolean(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET);
}

function credentials() {
  const env = getServerEnv();
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) {
    throw new GoogleOAuthNotConfiguredError();
  }
  return {
    clientId: env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    redirectUri: new URL("/api/attendee/oauth/google/callback", env.APP_BASE_URL).toString(),
  };
}

export function googleRedirectUri() {
  return credentials().redirectUri;
}

export type GoogleAuthorizationRequest = {
  authorizationUrl: string;
  state: string;
  nonce: string;
  codeVerifier: string;
};

/**
 * Builds the redirect that starts a sign-in.
 *
 * Three single-use secrets go with it. `state` is compared on the way back, so
 * a callback the browser did not ask for is refused. `nonce` is carried inside
 * the ID token, which stops one issued for a different session being replayed
 * into this one. `codeVerifier` is PKCE: an intercepted authorization code is
 * useless without it. None is optional here — Google permits PKCE on the
 * confidential-client flow, and the cost of including it is nothing.
 */
export function beginGoogleAuthorization(): GoogleAuthorizationRequest {
  const { clientId, redirectUri } = credentials();
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");

  const url = new URL(AUTHORIZATION_ENDPOINT);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  // No broader scope is requested. This flow needs to know who someone is and
  // that the address is theirs; it has no business reading their contacts.
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  // Ask for the account chooser rather than silently reusing whichever Google
  // account the browser last used — households share browsers.
  url.searchParams.set("prompt", "select_account");

  return { authorizationUrl: url.toString(), state, nonce, codeVerifier };
}

type JsonWebKey = {
  kid: string;
  kty: string;
  alg?: string;
  use?: string;
  n: string;
  e: string;
};

let cachedKeys: { keys: JsonWebKey[]; expiresAt: number } | null = null;

async function signingKeys(forceRefresh = false): Promise<JsonWebKey[]> {
  const now = Date.now();
  if (!forceRefresh && cachedKeys && cachedKeys.expiresAt > now) {
    return cachedKeys.keys;
  }
  const response = await fetch(JWKS_URI, { cache: "no-store" });
  if (!response.ok) {
    throw new GoogleOAuthError("Google's signing keys could not be fetched.");
  }
  const body = await response.json() as { keys?: JsonWebKey[] };
  if (!Array.isArray(body.keys) || body.keys.length === 0) {
    throw new GoogleOAuthError("Google returned no signing keys.");
  }
  // Honour the cache header when there is one; Google rotates these, and
  // pinning them for longer than it says would break sign-in at rotation.
  const maxAge = Number(
    /max-age=(\d+)/.exec(response.headers.get("cache-control") ?? "")?.[1] ?? 3600,
  );
  cachedKeys = {
    keys: body.keys,
    expiresAt: now + Math.min(Math.max(maxAge, 60), 24 * 60 * 60) * 1000,
  };
  return body.keys;
}

/** Exported for tests: drops the key cache so a rotation can be simulated. */
export function resetGoogleSigningKeyCache() {
  cachedKeys = null;
}

export type GoogleIdentity = {
  subject: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
};

function decodeSegment(segment: string) {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
}

/**
 * Verifies an ID token completely: signature first, then every claim that
 * decides whether it may be believed.
 *
 * The signature check is not strictly required — the token arrived over TLS
 * directly from Google's token endpoint, which OIDC accepts as sufficient
 * provenance. It is done anyway, because "we skipped it and here is the
 * paragraph explaining why that was safe" is a note that outlives the reasoning
 * it depends on. If this ever stops being a direct exchange, the check is
 * already here.
 */
export async function verifyGoogleIdToken(
  idToken: string,
  expectedNonce: string,
  now = new Date(),
): Promise<GoogleIdentity> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new GoogleOAuthError("The ID token is malformed.");
  const [headerSegment, payloadSegment, signatureSegment] = parts;

  const header = decodeSegment(headerSegment);
  if (header.alg !== "RS256") {
    // Refusing anything else is what closes the `alg: none` and
    // algorithm-confusion families rather than relying on the library default.
    throw new GoogleOAuthError("The ID token is not signed with RS256.");
  }

  const signed = `${headerSegment}.${payloadSegment}`;
  const signature = Buffer.from(signatureSegment, "base64url");
  const verified = await verifyAgainstKeys(signed, signature, String(header.kid ?? ""));
  if (!verified) throw new GoogleOAuthError("The ID token signature is not valid.");

  const payload = decodeSegment(payloadSegment);
  const { clientId } = credentials();
  const seconds = Math.floor(now.getTime() / 1000);

  if (!ISSUERS.has(String(payload.iss))) {
    throw new GoogleOAuthError("The ID token was not issued by Google.");
  }
  // `aud` may be a string or an array; this client must be in it either way.
  const audience = Array.isArray(payload.aud) ? payload.aud.map(String) : [String(payload.aud)];
  if (!audience.includes(clientId)) {
    throw new GoogleOAuthError("The ID token was issued for a different application.");
  }
  if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW_SECONDS < seconds) {
    throw new GoogleOAuthError("The ID token has expired.");
  }
  if (typeof payload.iat !== "number" || payload.iat - CLOCK_SKEW_SECONDS > seconds) {
    throw new GoogleOAuthError("The ID token was issued in the future.");
  }
  if (typeof payload.nonce !== "string" || payload.nonce !== expectedNonce) {
    // Without this, an ID token minted for another session could be replayed
    // into this one.
    throw new GoogleOAuthError("The ID token does not match this sign-in attempt.");
  }

  const subject = typeof payload.sub === "string" ? payload.sub : "";
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!subject || !email) {
    throw new GoogleOAuthError("The ID token is missing an identifier or an address.");
  }

  return {
    subject,
    email,
    // Google sends this as a boolean or the string "true" depending on age of
    // the client. Anything else is treated as unverified.
    emailVerified: payload.email_verified === true || payload.email_verified === "true",
    name: typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : null,
  };
}

async function verifyAgainstKeys(signed: string, signature: Buffer, kid: string) {
  for (const refresh of [false, true]) {
    const keys = await signingKeys(refresh);
    const candidates = kid ? keys.filter((key) => key.kid === kid) : keys;
    for (const jwk of candidates) {
      if (jwk.kty !== "RSA") continue;
      const verifier = createVerify("RSA-SHA256");
      verifier.update(signed);
      verifier.end();
      if (verifier.verify(createPublicKey({ key: jwk, format: "jwk" }), signature)) {
        return true;
      }
    }
    // A key id this host has not seen means Google rotated; one refresh, then
    // the answer is no.
    if (candidates.length > 0) break;
  }
  return false;
}

/**
 * Exchanges the authorization code for an ID token. The client secret travels
 * only here, server to server, and never reaches the browser.
 */
export async function exchangeGoogleAuthorizationCode(
  code: string,
  codeVerifier: string,
): Promise<string> {
  const { clientId, clientSecret, redirectUri } = credentials();
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    cache: "no-store",
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: codeVerifier,
    }),
  });

  const body = await response.json().catch(() => ({})) as {
    id_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !body.id_token) {
    throw new GoogleOAuthError(
      "Google would not complete this sign-in.",
      body.error_description ?? body.error ?? `HTTP ${response.status}`,
    );
  }
  return body.id_token;
}
