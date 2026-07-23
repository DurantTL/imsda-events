import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

const tokenNamespace = "imsda:attendee-pass:v1:";
const tokenPrefix = "imsda-pass.v1";
const tokenPartPattern = /^[A-Za-z0-9_-]+$/;
const identifierPattern = /^[A-Za-z0-9_-]{1,128}$/;
const localSigningSecret = "imsda-events-local-attendee-pass-secret-2026";
const postEventValidityMilliseconds = 48 * 60 * 60 * 1_000;

type AttendeePassEnvironment = "development" | "test" | "production";

export type AttendeePassClaims = {
  version: 1;
  eventId: string;
  attendeeId: string;
  expiresAt: Date;
};

export type CreateAttendeePassInput = {
  eventId: string;
  attendeeId: string;
  expiresAt: Date;
};

export type VerifyAttendeePassOptions = {
  expectedEventId: string;
  now?: Date;
  source?: Record<string, string | undefined>;
};

export class AttendeePassTokenError extends Error {
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
    this.name = "AttendeePassTokenError";
  }
}

function environment(
  source: Record<string, string | undefined>,
): AttendeePassEnvironment {
  return source.NODE_ENV === "production"
    ? "production"
    : source.NODE_ENV === "test"
      ? "test"
      : "development";
}

function configuredSecrets(
  source: Record<string, string | undefined>,
) {
  const current = source.ATTENDEE_PASS_SIGNING_SECRET?.trim() ?? "";
  const previous = source.ATTENDEE_PASS_SIGNING_SECRET_PREVIOUS?.trim() ?? "";
  if (environment(source) === "production" && current.length < 32) {
    throw new AttendeePassTokenError(
      "PASS_CONFIGURATION_INVALID",
      "ATTENDEE_PASS_SIGNING_SECRET must contain at least 32 characters in production.",
    );
  }
  if (previous && previous.length < 32) {
    throw new AttendeePassTokenError(
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
    throw new AttendeePassTokenError(
      "PASS_MALFORMED",
      "The attendee pass is not valid.",
    );
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new AttendeePassTokenError(
      "PASS_MALFORMED",
      "The attendee pass is not valid.",
    );
  }
  const record = decoded as Record<string, unknown>;
  const expiresAt = typeof record.x === "number"
    ? new Date(record.x * 1_000)
    : new Date(Number.NaN);
  if (
    record.v !== 1
    || typeof record.e !== "string"
    || typeof record.a !== "string"
    || typeof record.x !== "number"
    || !Number.isSafeInteger(record.x)
    || record.x <= 0
    || Number.isNaN(expiresAt.valueOf())
    || !assertIdentifier(record.e)
    || !assertIdentifier(record.a)
  ) {
    throw new AttendeePassTokenError(
      "PASS_MALFORMED",
      "The attendee pass is not valid.",
    );
  }
  return {
    version: 1 as const,
    eventId: record.e,
    attendeeId: record.a,
    expiresAt,
  };
}

export function attendeePassExpiry(eventEndsAt: Date) {
  if (Number.isNaN(eventEndsAt.valueOf())) {
    throw new RangeError("A valid event end date is required.");
  }
  return new Date(eventEndsAt.getTime() + postEventValidityMilliseconds);
}

export function attendeePassIsAvailable(
  eventEndsAt: Date,
  now = new Date(),
) {
  return attendeePassExpiry(eventEndsAt).getTime() > now.getTime();
}

export function createAttendeePassToken(
  input: CreateAttendeePassInput,
  source: Record<string, string | undefined> = process.env,
) {
  if (
    !assertIdentifier(input.eventId)
    || !assertIdentifier(input.attendeeId)
    || Number.isNaN(input.expiresAt.valueOf())
  ) {
    throw new AttendeePassTokenError(
      "PASS_MALFORMED",
      "The attendee pass could not be created.",
    );
  }
  const expiresAtSeconds = Math.floor(input.expiresAt.getTime() / 1_000);
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    e: input.eventId,
    a: input.attendeeId,
    x: expiresAtSeconds,
  })).toString("base64url");
  const currentSecret = configuredSecrets(source)[0];
  return `${tokenPrefix}.${payload}.${encodedSignature(payload, currentSecret)}`;
}

export function verifyAttendeePassToken(
  token: string,
  options: VerifyAttendeePassOptions,
): AttendeePassClaims {
  if (token.length > 768) {
    throw new AttendeePassTokenError(
      "PASS_MALFORMED",
      "The attendee pass is not valid.",
    );
  }
  const [namespace, version, payload, candidateSignature, ...extra] = token
    .trim()
    .split(".");
  if (
    namespace !== "imsda-pass"
    || version !== "v1"
    || !payload
    || !candidateSignature
    || extra.length > 0
    || !tokenPartPattern.test(payload)
  ) {
    throw new AttendeePassTokenError(
      "PASS_MALFORMED",
      "The attendee pass is not valid.",
    );
  }
  const validSignature = configuredSecrets(options.source ?? process.env)
    .some((secret) => signaturesMatch(payload, candidateSignature, secret));
  if (!validSignature) {
    throw new AttendeePassTokenError(
      "PASS_INVALID",
      "The attendee pass is not valid.",
    );
  }
  const claims = parseClaims(payload);
  if (claims.eventId !== options.expectedEventId) {
    throw new AttendeePassTokenError(
      "PASS_EVENT_MISMATCH",
      "This attendee pass belongs to another event.",
    );
  }
  const now = options.now ?? new Date();
  if (claims.expiresAt.getTime() <= now.getTime()) {
    throw new AttendeePassTokenError(
      "PASS_EXPIRED",
      "This attendee pass has expired.",
    );
  }
  return claims;
}
