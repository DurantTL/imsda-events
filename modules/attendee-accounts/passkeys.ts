import "server-only";

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { getPrisma } from "@/lib/prisma";
import { createAttendeeSession } from "@/modules/attendee-accounts/session-store";
import { logWarn } from "@/lib/logger";
import { writeAuditLog } from "@/modules/audit/audit-service";
import {
  PASSKEY_CHALLENGE_MINUTES,
  hasRecentSecondFactor,
  matchRelyingParty,
  passkeyNameFrom,
} from "@/modules/attendee-accounts/passkey-domain";
import { PLATFORM_SETTINGS_ID } from "@/modules/system-admin/platform-settings";

/**
 * Passkeys for attendees: the alternative to an authenticator code as the
 * second step (opening club rosters exactly as a code does), and since #374 a
 * way to sign in with no email or password. Because every passkey here needs
 * user verification (fingerprint, face, or PIN), a passkey sign-in also
 * counts as the second step. Password and Google sign-in never depend on them.
 */

export class PasskeyError extends Error {
  constructor(
    public readonly code:
      | "PASSKEYS_NOT_AVAILABLE"
      | "RECENT_VERIFICATION_REQUIRED"
      | "NO_PASSKEYS"
      | "CHALLENGE_EXPIRED"
      | "PASSKEY_NOT_VERIFIED"
      | "PASSKEY_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "PasskeyError";
  }
}

type Account = { id: string; verifiedEmail: string; displayName: string };

const transportsOf = (values: string[]) => values as AuthenticatorTransport[];

async function configuredRpId() {
  const settings = await getPrisma().platformSettings.findUnique({
    where: { id: PLATFORM_SETTINGS_ID },
    select: { passkeyRpId: true },
  });
  return settings?.passkeyRpId ?? null;
}

/** Whether passkeys are switched on for this deployment at all (the origin is checked per request). */
export async function passkeysConfigured() {
  return Boolean(await configuredRpId());
}

async function requireRelyingParty(requestOrigin: string | null) {
  const relyingParty = matchRelyingParty(await configuredRpId(), requestOrigin);
  if (!relyingParty) {
    throw new PasskeyError("PASSKEYS_NOT_AVAILABLE", "Passkeys aren't available on this site yet. Use your authenticator code instead.");
  }
  return relyingParty;
}

export type PasskeySummary = { id: string; name: string; createdAt: string; lastUsedAt: string | null; backedUp: boolean };

export async function listPasskeys(accountId: string): Promise<PasskeySummary[]> {
  const passkeys = await getPrisma().attendeePasskey.findMany({
    where: { accountId, revokedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, createdAt: true, lastUsedAt: true, backedUp: true },
  });
  return passkeys.map((passkey) => ({
    id: passkey.id,
    name: passkey.name,
    createdAt: passkey.createdAt.toISOString(),
    lastUsedAt: passkey.lastUsedAt?.toISOString() ?? null,
    backedUp: passkey.backedUp,
  }));
}

/**
 * Adding or removing a passkey changes how this account proves itself, so once
 * the account has any second step, this session must have passed one recently.
 * The very first second step can be added from sign-in alone, as an
 * authenticator app can.
 */
async function requireChangeAllowed(accountId: string, sessionId: string, now: Date) {
  const prisma = getPrisma();
  const [enrollment, passkeyCount, session] = await Promise.all([
    prisma.attendeeMfaEnrollment.findUnique({ where: { accountId }, select: { status: true } }),
    prisma.attendeePasskey.count({ where: { accountId, revokedAt: null } }),
    prisma.attendeeSession.findUnique({ where: { id: sessionId }, select: { secondFactorVerifiedAt: true } }),
  ]);
  const hasSecondStep = enrollment?.status === "ACTIVE" || passkeyCount > 0;
  if (hasSecondStep && !hasRecentSecondFactor(session?.secondFactorVerifiedAt, now)) {
    throw new PasskeyError(
      "RECENT_VERIFICATION_REQUIRED",
      "Confirm it's you first with your authenticator code or an existing passkey.",
    );
  }
}

async function storeChallenge(sessionId: string, purpose: "REGISTER" | "VERIFY", challenge: string, now: Date) {
  const prisma = getPrisma();
  // One open prompt per session and purpose: a new one replaces the last.
  await prisma.attendeePasskeyChallenge.deleteMany({ where: { sessionId, purpose } });
  await prisma.attendeePasskeyChallenge.create({
    data: { sessionId, purpose, challenge, expiresAt: new Date(now.getTime() + PASSKEY_CHALLENGE_MINUTES * 60_000) },
  });
}

/** Takes the session's open challenge, marking it used so it can't be answered twice. */
async function consumeChallenge(sessionId: string, purpose: "REGISTER" | "VERIFY", now: Date) {
  const prisma = getPrisma();
  const challenge = await prisma.attendeePasskeyChallenge.findFirst({
    where: { sessionId, purpose, usedAt: null, expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
  });
  if (!challenge) throw new PasskeyError("CHALLENGE_EXPIRED", "That passkey prompt expired. Please try again.");
  const claimed = await prisma.attendeePasskeyChallenge.updateMany({
    where: { id: challenge.id, usedAt: null },
    data: { usedAt: now },
  });
  if (claimed.count !== 1) throw new PasskeyError("CHALLENGE_EXPIRED", "That passkey prompt expired. Please try again.");
  return challenge.challenge;
}

export async function beginPasskeyRegistration(account: Account, sessionId: string, requestOrigin: string | null, now = new Date()) {
  const { rpId } = await requireRelyingParty(requestOrigin);
  await requireChangeAllowed(account.id, sessionId, now);
  const existing = await getPrisma().attendeePasskey.findMany({
    where: { accountId: account.id, revokedAt: null },
    select: { credentialId: true, transports: true },
  });
  const options = await generateRegistrationOptions({
    rpName: "IMSDA Events",
    rpID: rpId,
    userName: account.verifiedEmail,
    userDisplayName: account.displayName,
    userID: new TextEncoder().encode(account.id),
    attestationType: "none",
    excludeCredentials: existing.map((passkey) => ({ id: passkey.credentialId, transports: transportsOf(passkey.transports) })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  });
  await storeChallenge(sessionId, "REGISTER", options.challenge, now);
  return options;
}

export async function finishPasskeyRegistration(
  account: Account,
  sessionId: string,
  requestOrigin: string | null,
  input: { response: RegistrationResponseJSON; name?: unknown },
  now = new Date(),
) {
  const relyingParty = await requireRelyingParty(requestOrigin);
  await requireChangeAllowed(account.id, sessionId, now);
  const expectedChallenge = await consumeChallenge(sessionId, "REGISTER", now);
  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge,
      expectedOrigin: relyingParty.origin,
      expectedRPID: relyingParty.rpId,
      requireUserVerification: true,
    });
  } catch (error) {
    logWarn("Passkey registration was not verified", { reason: error instanceof Error ? error.message : "unknown" });
    throw new PasskeyError("PASSKEY_NOT_VERIFIED", "That passkey couldn't be added. Please try again.");
  }
  if (!verification.verified) throw new PasskeyError("PASSKEY_NOT_VERIFIED", "That passkey couldn't be added. Please try again.");

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const name = passkeyNameFrom(input.name);
  await getPrisma().$transaction(async (tx) => {
    const passkey = await tx.attendeePasskey.create({
      data: {
        accountId: account.id,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey),
        counter: BigInt(credential.counter),
        transports: credential.transports ?? [],
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
        name,
      },
    });
    await writeAuditLog({
      action: "ATTENDEE_PASSKEY_ADDED",
      entityType: "AttendeePasskey",
      entityId: passkey.id,
      summary: "An attendee added a passkey.",
      metadata: { actorAttendeeAccountId: account.id, backedUp: credentialBackedUp },
    }, tx);
  });
  return listPasskeys(account.id);
}

export async function removePasskey(account: Account, sessionId: string, passkeyId: string, now = new Date()) {
  await requireChangeAllowed(account.id, sessionId, now);
  await getPrisma().$transaction(async (tx) => {
    const removed = await tx.attendeePasskey.updateMany({
      where: { id: passkeyId, accountId: account.id, revokedAt: null },
      data: { revokedAt: now },
    });
    if (removed.count !== 1) throw new PasskeyError("PASSKEY_NOT_FOUND", "That passkey could not be found.");
    await writeAuditLog({
      action: "ATTENDEE_PASSKEY_REMOVED",
      entityType: "AttendeePasskey",
      entityId: passkeyId,
      summary: "An attendee removed a passkey.",
      metadata: { actorAttendeeAccountId: account.id },
    }, tx);
  });
  return listPasskeys(account.id);
}

export async function beginPasskeyVerification(account: Account, sessionId: string, requestOrigin: string | null, now = new Date()) {
  const { rpId } = await requireRelyingParty(requestOrigin);
  const passkeys = await getPrisma().attendeePasskey.findMany({
    where: { accountId: account.id, revokedAt: null },
    select: { credentialId: true, transports: true },
  });
  if (passkeys.length === 0) throw new PasskeyError("NO_PASSKEYS", "Add a passkey on your Security page first.");
  const options = await generateAuthenticationOptions({
    rpID: rpId,
    allowCredentials: passkeys.map((passkey) => ({ id: passkey.credentialId, transports: transportsOf(passkey.transports) })),
    userVerification: "required",
  });
  await storeChallenge(sessionId, "VERIFY", options.challenge, now);
  return options;
}

/** Checks a passkey answer for this account. On success the caller records the second step on the session. */
export async function finishPasskeyVerification(
  account: Account,
  sessionId: string,
  requestOrigin: string | null,
  response: AuthenticationResponseJSON,
  now = new Date(),
) {
  const relyingParty = await requireRelyingParty(requestOrigin);
  const expectedChallenge = await consumeChallenge(sessionId, "VERIFY", now);
  const passkey = await getPrisma().attendeePasskey.findFirst({
    where: { credentialId: response.id, accountId: account.id, revokedAt: null },
  });
  if (!passkey) throw new PasskeyError("PASSKEY_NOT_VERIFIED", "That passkey didn't work. Try again or use your authenticator code.");
  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: relyingParty.origin,
      expectedRPID: relyingParty.rpId,
      credential: {
        id: passkey.credentialId,
        publicKey: new Uint8Array(passkey.publicKey),
        counter: Number(passkey.counter),
        transports: transportsOf(passkey.transports),
      },
      requireUserVerification: true,
    });
  } catch (error) {
    logWarn("Passkey verification failed", { reason: error instanceof Error ? error.message : "unknown" });
    throw new PasskeyError("PASSKEY_NOT_VERIFIED", "That passkey didn't work. Try again or use your authenticator code.");
  }
  if (!verification.verified) {
    throw new PasskeyError("PASSKEY_NOT_VERIFIED", "That passkey didn't work. Try again or use your authenticator code.");
  }
  await getPrisma().attendeePasskey.update({
    where: { id: passkey.id },
    data: { counter: BigInt(verification.authenticationInfo.newCounter), lastUsedAt: now },
  });
}

/** What the Security page needs to show the passkey controls. */
export async function getPasskeySettings(accountId: string, sessionId: string | null, now = new Date()) {
  const prisma = getPrisma();
  const [passkeys, available, enrollment, session] = await Promise.all([
    listPasskeys(accountId),
    passkeysConfigured(),
    prisma.attendeeMfaEnrollment.findUnique({ where: { accountId }, select: { status: true } }),
    sessionId ? prisma.attendeeSession.findUnique({ where: { id: sessionId }, select: { secondFactorVerifiedAt: true } }) : null,
  ]);
  const hasAuthenticator = enrollment?.status === "ACTIVE";
  const hasSecondStep = hasAuthenticator || passkeys.length > 0;
  return {
    passkeys,
    available,
    hasAuthenticator,
    needsConfirmation: hasSecondStep && !hasRecentSecondFactor(session?.secondFactorVerifiedAt, now),
  };
}

/** Neutral on purpose: an unknown, revoked, or refused passkey all read the same. */
const SIGN_IN_REFUSED = "That passkey didn't sign you in. Try again, or sign in with your email and password.";

/**
 * Starts a passkey sign-in (#374). No account is named: the browser offers the
 * person's own passkeys for this site. The challenge is single-use, expires in
 * five minutes, and its id goes in a cookie so only this browser can answer it.
 */
export async function beginPasskeySignIn(requestOrigin: string | null, now = new Date()) {
  const { rpId } = await requireRelyingParty(requestOrigin);
  const prisma = getPrisma();
  // Anyone can ask for a sign-in prompt, so expired ones are cleared as new ones are made.
  await prisma.attendeePasskeyChallenge.deleteMany({ where: { purpose: "SIGN_IN", expiresAt: { lt: now } } });
  const options = await generateAuthenticationOptions({ rpID: rpId, userVerification: "required" });
  const challenge = await prisma.attendeePasskeyChallenge.create({
    data: { purpose: "SIGN_IN", challenge: options.challenge, expiresAt: new Date(now.getTime() + PASSKEY_CHALLENGE_MINUTES * 60_000) },
    select: { id: true },
  });
  return { options, challengeId: challenge.id };
}

function decodeUserHandle(value: string | undefined) {
  if (!value) return null;
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Finishes a passkey sign-in: the challenge is spent first, so a failed
 * answer can't be retried against it. Only an active passkey on an active,
 * verified account signs in. The new session is marked as having passed the
 * second step, because the passkey itself required the person's fingerprint,
 * face, or PIN.
 */
export async function finishPasskeySignIn(
  challengeId: string | null,
  requestOrigin: string | null,
  response: AuthenticationResponseJSON,
  userAgent: string | null,
  now = new Date(),
) {
  const relyingParty = await requireRelyingParty(requestOrigin);
  const prisma = getPrisma();
  if (!challengeId) throw new PasskeyError("CHALLENGE_EXPIRED", "That passkey prompt expired. Please try again.");
  const challenge = await prisma.attendeePasskeyChallenge.findFirst({
    where: { id: challengeId, purpose: "SIGN_IN", sessionId: null, usedAt: null, expiresAt: { gt: now } },
    select: { id: true, challenge: true },
  });
  if (!challenge) throw new PasskeyError("CHALLENGE_EXPIRED", "That passkey prompt expired. Please try again.");
  const claimed = await prisma.attendeePasskeyChallenge.updateMany({ where: { id: challenge.id, usedAt: null }, data: { usedAt: now } });
  if (claimed.count !== 1) throw new PasskeyError("CHALLENGE_EXPIRED", "That passkey prompt expired. Please try again.");

  const passkey = await prisma.attendeePasskey.findFirst({
    where: { credentialId: response.id, revokedAt: null },
    include: { account: { select: { id: true, status: true, emailVerifiedAt: true, disabledAt: true } } },
  });
  const account = passkey?.account;
  if (!passkey || !account || account.status !== "ACTIVE" || !account.emailVerifiedAt || account.disabledAt) {
    throw new PasskeyError("PASSKEY_NOT_VERIFIED", SIGN_IN_REFUSED);
  }
  // The authenticator names the account it was made for; it must be this passkey's.
  const userHandle = decodeUserHandle(response.response.userHandle);
  if (userHandle !== null && userHandle !== account.id) throw new PasskeyError("PASSKEY_NOT_VERIFIED", SIGN_IN_REFUSED);

  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: relyingParty.origin,
      expectedRPID: relyingParty.rpId,
      credential: {
        id: passkey.credentialId,
        publicKey: new Uint8Array(passkey.publicKey),
        counter: Number(passkey.counter),
        transports: transportsOf(passkey.transports),
      },
      requireUserVerification: true,
    });
  } catch (error) {
    logWarn("Passkey sign-in failed", { reason: error instanceof Error ? error.message : "unknown" });
    throw new PasskeyError("PASSKEY_NOT_VERIFIED", SIGN_IN_REFUSED);
  }
  if (!verification.verified) throw new PasskeyError("PASSKEY_NOT_VERIFIED", SIGN_IN_REFUSED);

  await prisma.attendeePasskey.update({
    where: { id: passkey.id },
    data: { counter: BigInt(verification.authenticationInfo.newCounter), lastUsedAt: now },
  });
  const session = await createAttendeeSession(account.id, userAgent, { secondFactorVerifiedAt: now });
  await writeAuditLog({
    action: "ATTENDEE_PASSKEY_SIGN_IN",
    entityType: "AttendeePasskey",
    entityId: passkey.id,
    summary: "An attendee signed in with a passkey.",
    metadata: { actorAttendeeAccountId: account.id },
  });
  return { accountId: account.id, session };
}
