import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A club's own QR pass (Q1, #412): staff scan the confirmation code or any
 * member's individual pass to open the club's check-in view; a director can
 * also show one QR that opens the same view directly, without naming a
 * scanned person. It is a separate signed token type from an attendee pass
 * (`attendee-pass-token.ts`), not a variant of it: a different top-level
 * prefix, a different HMAC namespace, and its own `t` field in the signed
 * payload, so an attendee pass can never be replayed as a club pass or the
 * reverse even though both are verified against the same signing secret.
 */

const tokenNamespace = "imsda:club-pass:v1:";
export const clubPassTokenPrefix = "imsda-club-pass.v1";
const tokenPartPattern = /^[A-Za-z0-9_-]+$/;
const identifierPattern = /^[A-Za-z0-9_-]{1,128}$/;
const localSigningSecret = "imsda-events-local-attendee-pass-secret-2026";
const postEventValidityMilliseconds = 48 * 60 * 60 * 1_000;

type ClubPassEnvironment = "development" | "test" | "production";

export type ClubPassClaims = {
  version: 1;
  type: "club";
  eventId: string;
  clubRegistrationId: string;
  expiresAt: Date;
};

export type CreateClubPassInput = {
  eventId: string;
  clubRegistrationId: string;
  expiresAt: Date;
};

export type VerifyClubPassOptions = {
  expectedEventId: string;
  now?: Date;
  source?: Record<string, string | undefined>;
};

export class ClubPassTokenError extends Error {
  constructor(
    public readonly code:
      | "PASS_CONFIGURATION_INVALID"
      | "PASS_MALFORMED"
      | "PASS_INVALID"
      | "PASS_EXPIRED"
      | "PASS_EVENT_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "ClubPassTokenError";
  }
}

function environment(
  source: Record<string, string | undefined>,
): ClubPassEnvironment {
  return source.NODE_ENV === "production"
    ? "production"
    : source.NODE_ENV === "test"
      ? "test"
      : "development";
}

// Reuses the attendee pass's signing secret mechanism (same env vars, same
// rotation contract): one secret to configure and rotate, not two. The
// namespace and prefix below keep the tokens themselves from ever being
// confused, so sharing the secret creates no cross-type forgery risk.
function configuredSecrets(
  source: Record<string, string | undefined>,
) {
  const current = source.ATTENDEE_PASS_SIGNING_SECRET?.trim() ?? "";
  const previous = source.ATTENDEE_PASS_SIGNING_SECRET_PREVIOUS?.trim() ?? "";
  if (environment(source) === "production" && current.length < 32) {
    throw new ClubPassTokenError(
      "PASS_CONFIGURATION_INVALID",
      "ATTENDEE_PASS_SIGNING_SECRET must contain at least 32 characters in production.",
    );
  }
  if (previous && previous.length < 32) {
    throw new ClubPassTokenError(
      "PASS_CONFIGURATION_INVALID",
      "ATTENDEE_PASS_SIGNING_SECRET_PREVIOUS must contain at least 32 characters when configured.",
    );
  }
  return [...new Set([
    current || localSigningSecret,
    ...(previous ? [previous] : []),
  ])];
}

function assertIdentifier(value: string) {
  return identifierPattern.test(value);
}

function signature(payload: string, secret: string) {
  return createHmac("sha256", secret)
    .update(`${tokenNamespace}${payload}`)
    .digest();
}

function encodedSignature(payload: string, secret: string) {
  return signature(payload, secret).toString("base64url");
}

function signaturesMatch(
  payload: string,
  encodedCandidate: string,
  secret: string,
) {
  if (!tokenPartPattern.test(encodedCandidate)) return false;
  const candidate = Buffer.from(encodedCandidate, "base64url");
  const expected = signature(payload, secret);
  return candidate.length === expected.length
    && timingSafeEqual(candidate, expected);
}

function parseClaims(payload: string) {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new ClubPassTokenError(
      "PASS_MALFORMED",
      "The club pass is not valid.",
    );
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new ClubPassTokenError(
      "PASS_MALFORMED",
      "The club pass is not valid.",
    );
  }
  const record = decoded as Record<string, unknown>;
  const expiresAt = typeof record.x === "number"
    ? new Date(record.x * 1_000)
    : new Date(Number.NaN);
  if (
    record.v !== 1
    || record.t !== "club"
    || typeof record.e !== "string"
    || typeof record.c !== "string"
    || typeof record.x !== "number"
    || !Number.isSafeInteger(record.x)
    || record.x <= 0
    || Number.isNaN(expiresAt.valueOf())
    || !assertIdentifier(record.e)
    || !assertIdentifier(record.c)
  ) {
    throw new ClubPassTokenError(
      "PASS_MALFORMED",
      "The club pass is not valid.",
    );
  }
  return {
    version: 1 as const,
    type: "club" as const,
    eventId: record.e,
    clubRegistrationId: record.c,
    expiresAt,
  };
}

export function clubPassExpiry(eventEndsAt: Date) {
  if (Number.isNaN(eventEndsAt.valueOf())) {
    throw new RangeError("A valid event end date is required.");
  }
  return new Date(eventEndsAt.getTime() + postEventValidityMilliseconds);
}

export function clubPassIsAvailable(eventEndsAt: Date, now = new Date()) {
  return clubPassExpiry(eventEndsAt).getTime() > now.getTime();
}

export function createClubPassToken(
  input: CreateClubPassInput,
  source: Record<string, string | undefined> = process.env,
) {
  if (
    !assertIdentifier(input.eventId)
    || !assertIdentifier(input.clubRegistrationId)
    || Number.isNaN(input.expiresAt.valueOf())
  ) {
    throw new ClubPassTokenError(
      "PASS_MALFORMED",
      "The club pass could not be created.",
    );
  }
  const expiresAtSeconds = Math.floor(input.expiresAt.getTime() / 1_000);
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    t: "club",
    e: input.eventId,
    c: input.clubRegistrationId,
    x: expiresAtSeconds,
  })).toString("base64url");
  const currentSecret = configuredSecrets(source)[0];
  return `${clubPassTokenPrefix}.${payload}.${encodedSignature(payload, currentSecret)}`;
}

export function verifyClubPassToken(
  token: string,
  options: VerifyClubPassOptions,
): ClubPassClaims {
  if (token.length > 768) {
    throw new ClubPassTokenError(
      "PASS_MALFORMED",
      "The club pass is not valid.",
    );
  }
  const [namespace, version, payload, candidateSignature, ...extra] = token
    .trim()
    .split(".");
  if (
    namespace !== "imsda-club-pass"
    || version !== "v1"
    || !payload
    || !candidateSignature
    || extra.length > 0
    || !tokenPartPattern.test(payload)
  ) {
    throw new ClubPassTokenError(
      "PASS_MALFORMED",
      "The club pass is not valid.",
    );
  }
  const validSignature = configuredSecrets(options.source ?? process.env)
    .some((secret) => signaturesMatch(payload, candidateSignature, secret));
  if (!validSignature) {
    throw new ClubPassTokenError(
      "PASS_INVALID",
      "The club pass is not valid.",
    );
  }
  const claims = parseClaims(payload);
  if (claims.eventId !== options.expectedEventId) {
    throw new ClubPassTokenError(
      "PASS_EVENT_MISMATCH",
      "This club pass belongs to another event.",
    );
  }
  const now = options.now ?? new Date();
  if (claims.expiresAt.getTime() <= now.getTime()) {
    throw new ClubPassTokenError(
      "PASS_EXPIRED",
      "This club pass has expired.",
    );
  }
  return claims;
}
