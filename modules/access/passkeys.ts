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
import { cookies } from "next/headers";
import { createDatabaseSession, isSessionIdle, SESSION_COOKIE_NAME, shouldTouchSession, touchDatabaseSession } from "@/modules/access/session-store";
import { hashOpaqueToken } from "@/modules/access/tokens";
import { logWarn } from "@/lib/logger";
import { verifyCurrentPassword } from "@/modules/access/auth-service";
import { verifySecondFactorForChange } from "@/modules/access/mfa-service";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { PASSKEY_CHALLENGE_MINUTES, matchRelyingParty, passkeyNameFrom } from "@/modules/passkeys/domain";
import { PLATFORM_SETTINGS_ID } from "@/modules/system-admin/platform-settings";

/**
 * Passkeys for staff (#429): system administrators and other staff can add
 * one from account settings and sign in with one at `/login`. Because every
 * passkey here needs user verification (fingerprint, face, or PIN), a
 * passkey sign-in is phishing-resistant multi-factor on its own — it
 * completes sign-in the same way `completeMfaChallenge` does (a session is
 * only ever created once the second factor, if any is required, is
 * satisfied; creating one directly from a verified UV passkey is that same
 * record). Password sign-in and existing MFA continue to work unchanged.
 *
 * Kept apart from `modules/attendee-accounts/passkeys.ts` on purpose: a
 * separate credential table (`UserPasskey`) and a separate session model
 * (`UserSession`, not `AttendeeSession`). The relying-party rules and the
 * request schemas are shared from `modules/passkeys/` instead of copied.
 *
 * Adding or removing a passkey changes how the account proves itself, so both
 * need a fresh proof in the same request (see {@link requireRecentVerification}):
 * a hijacked session alone must not be able to plant its own passkey.
 */

export class PasskeyError extends Error {
  constructor(
    public readonly code:
      | "PASSKEYS_NOT_AVAILABLE"
      | "CHALLENGE_EXPIRED"
      | "PASSKEY_NOT_VERIFIED"
      | "PASSKEY_NOT_FOUND"
      | "NO_PASSKEYS"
      | "RECENT_VERIFICATION_REQUIRED",
    message: string,
  ) {
    super(message);
    this.name = "PasskeyError";
  }
}

type StaffAccount = { id: string; email: string; displayName: string };

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
    throw new PasskeyError("PASSKEYS_NOT_AVAILABLE", "Passkeys aren't available on this site yet. Sign in with your password instead.");
  }
  return relyingParty;
}

export type StaffPasskeySummary = { id: string; name: string; createdAt: string; lastUsedAt: string | null; backedUp: boolean };

export async function listPasskeys(userId: string): Promise<StaffPasskeySummary[]> {
  const passkeys = await getPrisma().userPasskey.findMany({
    where: { userId, revokedAt: null },
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

async function storeChallenge(sessionId: string, purpose: "REGISTER" | "VERIFY", challenge: string, now: Date) {
  const prisma = getPrisma();
  // One open prompt per session and purpose: a new one replaces the last.
  await prisma.userPasskeyChallenge.deleteMany({ where: { sessionId, purpose } });
  await prisma.userPasskeyChallenge.create({
    data: { sessionId, purpose, challenge, expiresAt: new Date(now.getTime() + PASSKEY_CHALLENGE_MINUTES * 60_000) },
  });
}

/** Takes the session's open challenge, marking it used so it can't be answered twice. */
async function consumeChallenge(sessionId: string, purpose: "REGISTER" | "VERIFY", now: Date) {
  const prisma = getPrisma();
  const challenge = await prisma.userPasskeyChallenge.findFirst({
    where: { sessionId, purpose, usedAt: null, expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
  });
  if (!challenge) throw new PasskeyError("CHALLENGE_EXPIRED", "That passkey prompt expired. Please try again.");
  const claimed = await prisma.userPasskeyChallenge.updateMany({
    where: { id: challenge.id, usedAt: null },
    data: { usedAt: now },
  });
  if (claimed.count !== 1) throw new PasskeyError("CHALLENGE_EXPIRED", "That passkey prompt expired. Please try again.");
  return challenge.challenge;
}

/**
 * Stores a new counter only if it moves forward, so two concurrent answers
 * can't both be accepted with the same counter (a sign of a cloned key). An
 * authenticator that reports 0 doesn't keep a counter at all, so nothing is
 * written. Returns false when the counter lost that race.
 */
async function advanceCounter(passkeyId: string, newCounter: number, now: Date) {
  const prisma = getPrisma();
  if (newCounter > 0) {
    const advanced = await prisma.userPasskey.updateMany({
      where: { id: passkeyId, counter: { lt: BigInt(newCounter) } },
      data: { counter: BigInt(newCounter) },
    });
    if (advanced.count !== 1) return false;
  }
  await prisma.userPasskey.update({ where: { id: passkeyId }, data: { lastUsedAt: now } });
  return true;
}

/** A fresh proof, sent with the add or remove request itself. At most one is given. */
export type ChangeProof = {
  code?: string;
  password?: string;
  passkey?: AuthenticationResponseJSON;
};

/** Which proofs this account can give before adding or removing a passkey. */
export type ChangeVerificationMethods = { code: boolean; passkey: boolean; password: boolean };

export async function changeVerificationMethods(userId: string): Promise<ChangeVerificationMethods> {
  const prisma = getPrisma();
  const [enrollment, passkeyCount] = await Promise.all([
    prisma.userMfaEnrollment.findUnique({ where: { userId }, select: { status: true } }),
    prisma.userPasskey.count({ where: { userId, revokedAt: null } }),
  ]);
  const code = enrollment?.status === "ACTIVE";
  // The password counts only for an account with no second factor at all, where
  // it is exactly what sign-in asks for. With an authenticator or a passkey,
  // that factor must be shown instead, so a known password plus a hijacked
  // session can't add or remove a passkey.
  return { code, passkey: passkeyCount > 0, password: !code && passkeyCount === 0 };
}

const VERIFICATION_REFUSED = "Confirm it's you first with your authenticator code, a recovery code, an existing passkey, or your password.";

/**
 * Starts the "use an existing passkey" proof: a prompt for this account's own
 * passkeys, tied to this session and answered once (`VERIFY`).
 */
export async function beginPasskeyVerification(account: StaffAccount, sessionId: string, requestOrigin: string | null, now = new Date()) {
  const { rpId } = await requireRelyingParty(requestOrigin);
  const passkeys = await getPrisma().userPasskey.findMany({
    where: { userId: account.id, revokedAt: null },
    select: { credentialId: true, transports: true },
  });
  if (passkeys.length === 0) throw new PasskeyError("NO_PASSKEYS", "This account has no passkey to confirm with.");
  const options = await generateAuthenticationOptions({
    rpID: rpId,
    allowCredentials: passkeys.map((passkey) => ({ id: passkey.credentialId, transports: transportsOf(passkey.transports) })),
    userVerification: "required",
  });
  await storeChallenge(sessionId, "VERIFY", options.challenge, now);
  return options;
}

/** Checks an existing-passkey answer to this session's `VERIFY` prompt. Never throws for a bad answer. */
async function verifyExistingPasskey(
  account: StaffAccount,
  sessionId: string,
  requestOrigin: string | null,
  response: AuthenticationResponseJSON,
  now: Date,
) {
  const relyingParty = matchRelyingParty(await configuredRpId(), requestOrigin);
  if (!relyingParty) return false;
  let expectedChallenge: string;
  try {
    expectedChallenge = await consumeChallenge(sessionId, "VERIFY", now);
  } catch {
    return false;
  }
  const passkey = await getPrisma().userPasskey.findFirst({
    where: { credentialId: response.id, userId: account.id, revokedAt: null },
  });
  if (!passkey) return false;
  try {
    const verification = await verifyAuthenticationResponse({
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
    if (!verification.verified) return false;
    return advanceCounter(passkey.id, verification.authenticationInfo.newCounter, now);
  } catch {
    logWarn("Staff passkey confirmation was not verified", { reason: "ASSERTION_REJECTED" });
    return false;
  }
}

/**
 * The re-authentication gate on adding or removing a passkey (#429). The
 * request must carry one fresh proof the account supports:
 *
 * - with an ACTIVE authenticator: an authenticator code or a recovery code,
 *   spent through the same single-use path and lockout as sign-in;
 * - with an active passkey: an answer from that passkey to this session's
 *   `VERIFY` prompt;
 * - without an active authenticator: the current password, through the same
 *   check and lockout counter as password sign-in.
 *
 * Every failure — nothing sent, a wrong or reused code, a wrong password, a
 * proof this account can't give — is the same answer.
 */
async function requireRecentVerification(
  account: StaffAccount,
  sessionId: string,
  requestOrigin: string | null,
  proof: ChangeProof | undefined,
  now: Date,
) {
  const methods = await changeVerificationMethods(account.id);
  let verified = false;
  if (proof?.code !== undefined) {
    verified = methods.code && await verifySecondFactorForChange(account.id, proof.code, now);
  } else if (proof?.passkey !== undefined) {
    verified = methods.passkey && await verifyExistingPasskey(account, sessionId, requestOrigin, proof.passkey, now);
  } else if (proof?.password !== undefined) {
    verified = methods.password && await verifyCurrentPassword(account.id, proof.password);
  }
  if (!verified) throw new PasskeyError("RECENT_VERIFICATION_REQUIRED", VERIFICATION_REFUSED);
}

export async function beginPasskeyRegistration(
  account: StaffAccount,
  sessionId: string,
  requestOrigin: string | null,
  proof: ChangeProof | undefined,
  now = new Date(),
) {
  const { rpId } = await requireRelyingParty(requestOrigin);
  await requireRecentVerification(account, sessionId, requestOrigin, proof, now);
  const existing = await getPrisma().userPasskey.findMany({
    where: { userId: account.id, revokedAt: null },
    select: { credentialId: true, transports: true },
  });
  const options = await generateRegistrationOptions({
    rpName: "IMSDA Events",
    rpID: rpId,
    userName: account.email,
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
  account: StaffAccount,
  sessionId: string,
  requestOrigin: string | null,
  input: { response: RegistrationResponseJSON; name?: unknown },
  now = new Date(),
) {
  const relyingParty = await requireRelyingParty(requestOrigin);
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
  } catch {
    // A fixed reason code: the library's own message can echo request contents.
    logWarn("Staff passkey registration was not verified", { reason: "REGISTRATION_REJECTED" });
    throw new PasskeyError("PASSKEY_NOT_VERIFIED", "That passkey couldn't be added. Please try again.");
  }
  if (!verification.verified || !verification.registrationInfo) {
    throw new PasskeyError("PASSKEY_NOT_VERIFIED", "That passkey couldn't be added. Please try again.");
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const name = passkeyNameFrom(input.name);
  await getPrisma().$transaction(async (tx) => {
    const passkey = await tx.userPasskey.create({
      data: {
        userId: account.id,
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
      actorUserId: account.id,
      action: "USER_PASSKEY_ADDED",
      entityType: "UserPasskey",
      entityId: passkey.id,
      summary: "A staff passkey was added.",
      metadata: { backedUp: credentialBackedUp },
    }, tx);
  });
  return listPasskeys(account.id);
}

export async function renamePasskey(account: StaffAccount, passkeyId: string, name: unknown, now = new Date()) {
  const newName = passkeyNameFrom(name);
  await getPrisma().$transaction(async (tx) => {
    const updated = await tx.userPasskey.updateMany({
      where: { id: passkeyId, userId: account.id, revokedAt: null },
      data: { name: newName },
    });
    if (updated.count !== 1) throw new PasskeyError("PASSKEY_NOT_FOUND", "That passkey could not be found.");
    await writeAuditLog({
      actorUserId: account.id,
      action: "USER_PASSKEY_RENAMED",
      entityType: "UserPasskey",
      entityId: passkeyId,
      summary: "A staff passkey was renamed.",
      metadata: {},
    }, tx);
  });
  void now;
  return listPasskeys(account.id);
}

export async function removePasskey(
  account: StaffAccount,
  sessionId: string,
  requestOrigin: string | null,
  passkeyId: string,
  proof: ChangeProof | undefined,
  now = new Date(),
) {
  // Check the target first, so a stale id doesn't spend a one-time code.
  const target = await getPrisma().userPasskey.findFirst({
    where: { id: passkeyId, userId: account.id, revokedAt: null },
    select: { id: true },
  });
  if (!target) throw new PasskeyError("PASSKEY_NOT_FOUND", "That passkey could not be found.");
  await requireRecentVerification(account, sessionId, requestOrigin, proof, now);
  // No "last sign-in method" refusal: passkey management needs a session from
  // an account with a usable password (`currentStaffPasskeySession`), so the
  // password is always the fallback once a passkey is gone.
  await getPrisma().$transaction(async (tx) => {
    const removed = await tx.userPasskey.updateMany({
      where: { id: passkeyId, userId: account.id, revokedAt: null },
      data: { revokedAt: now },
    });
    if (removed.count !== 1) throw new PasskeyError("PASSKEY_NOT_FOUND", "That passkey could not be found.");
    await writeAuditLog({
      actorUserId: account.id,
      action: "USER_PASSKEY_REMOVED",
      entityType: "UserPasskey",
      entityId: passkeyId,
      summary: "A staff passkey was removed.",
      metadata: {},
    }, tx);
  });
  return listPasskeys(account.id);
}

/** What the account settings panel needs to show the passkey controls. */
export async function getPasskeySettings(account: StaffAccount) {
  const [passkeys, available, verification] = await Promise.all([
    listPasskeys(account.id),
    passkeysConfigured(),
    changeVerificationMethods(account.id),
  ]);
  return { passkeys, available, verification };
}

/**
 * Resolves the signed-in staff member the same way `getCurrentSession` does,
 * but also returns the session's own id, which passkey registration and
 * verification need to tie a challenge to this browser's session. Kept apart
 * from `getCurrentSession` rather than widening its return shape, matching
 * how `getCurrentAttendee` keeps its own resolver instead of reusing it.
 */
export async function currentStaffPasskeySession() {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;

  const tokenHash = hashOpaqueToken(token);
  const session = await getPrisma().userSession.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      expiresAt: true,
      revokedAt: true,
      lastSeenAt: true,
      user: {
        select: {
          id: true,
          email: true,
          displayName: true,
          accountStatus: true,
          credential: { select: { disabledAt: true } },
        },
      },
    },
  });

  const now = new Date();
  if (
    !session
    || session.revokedAt
    || session.expiresAt <= now
    || !session.user.credential
    || session.user.credential.disabledAt
    || session.user.accountStatus !== "ACTIVE"
  ) {
    return null;
  }

  if (isSessionIdle(session.lastSeenAt, now)) return null;
  if (shouldTouchSession(session.lastSeenAt, now)) {
    await touchDatabaseSession(tokenHash, session.lastSeenAt, now);
  }

  return {
    account: { id: session.user.id, email: session.user.email, displayName: session.user.displayName },
    sessionId: session.id,
  };
}

/** Neutral on purpose: an unknown, revoked, disabled, or refused passkey all read the same. */
const SIGN_IN_REFUSED = "That passkey didn't sign you in. Try again, or sign in with your email and password.";

/**
 * Starts a passkey sign-in. No account is named: the browser offers the
 * person's own passkeys for this site, so this never reveals whether a given
 * email address has one (no account enumeration). The challenge is
 * single-use, expires in five minutes, and its id goes in a cookie so only
 * this browser can answer it.
 */
export async function beginPasskeySignIn(requestOrigin: string | null, now = new Date()) {
  const { rpId } = await requireRelyingParty(requestOrigin);
  const prisma = getPrisma();
  // Anyone can ask for a sign-in prompt, so expired ones are cleared as new ones are made.
  await prisma.userPasskeyChallenge.deleteMany({ where: { purpose: "SIGN_IN", expiresAt: { lt: now } } });
  const options = await generateAuthenticationOptions({ rpID: rpId, userVerification: "required" });
  const challenge = await prisma.userPasskeyChallenge.create({
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

export type StaffPasskeySignInResult = {
  userId: string;
  globalRole: "SYSTEM_ADMIN" | null;
  session: { token: string; expiresAt: Date };
};

/**
 * Finishes a passkey sign-in. The challenge is spent first, so a failed
 * answer can't be retried against it. Only an active passkey on an active
 * account with a usable credential signs in — the same account-state checks
 * `authenticateWithPassword` applies, so a disabled or locked-out account
 * cannot be reached by passkey either (don't weaken MFA, don't weaken the
 * account lock).
 *
 * A UV (user-verified) passkey assertion is phishing-resistant multi-factor
 * on its own, so this creates the session directly with
 * `createDatabaseSession` — the exact function `completeMfaChallenge` uses
 * once a password and a second factor have both checked out. There is no
 * separate "second factor satisfied" flag on `UserSession` to set: session
 * creation through this path *is* how MFA completion is recorded for staff,
 * the same as it already is for the password + authenticator path.
 */
export async function finishPasskeySignIn(
  challengeId: string | null,
  requestOrigin: string | null,
  response: AuthenticationResponseJSON,
  userAgent: string | null,
  now = new Date(),
): Promise<StaffPasskeySignInResult> {
  const relyingParty = await requireRelyingParty(requestOrigin);
  const prisma = getPrisma();
  if (!challengeId) throw new PasskeyError("CHALLENGE_EXPIRED", "That passkey prompt expired. Please try again.");
  const challenge = await prisma.userPasskeyChallenge.findFirst({
    where: { id: challengeId, purpose: "SIGN_IN", sessionId: null, usedAt: null, expiresAt: { gt: now } },
    select: { id: true, challenge: true },
  });
  if (!challenge) throw new PasskeyError("CHALLENGE_EXPIRED", "That passkey prompt expired. Please try again.");
  const claimed = await prisma.userPasskeyChallenge.updateMany({ where: { id: challenge.id, usedAt: null }, data: { usedAt: now } });
  if (claimed.count !== 1) throw new PasskeyError("CHALLENGE_EXPIRED", "That passkey prompt expired. Please try again.");

  const passkey = await prisma.userPasskey.findFirst({
    where: { credentialId: response.id, revokedAt: null },
    include: { user: { select: { id: true, globalRole: true, accountStatus: true, credential: { select: { disabledAt: true, lockedUntil: true } } } } },
  });
  const user = passkey?.user;
  const credential = user?.credential;
  if (
    !passkey
    || !user
    || user.accountStatus !== "ACTIVE"
    || !credential
    || credential.disabledAt
    || (credential.lockedUntil && credential.lockedUntil > now)
  ) {
    throw new PasskeyError("PASSKEY_NOT_VERIFIED", SIGN_IN_REFUSED);
  }
  // The authenticator names the account it was made for; it must be this passkey's.
  const userHandle = decodeUserHandle(response.response.userHandle);
  if (userHandle !== null && userHandle !== user.id) throw new PasskeyError("PASSKEY_NOT_VERIFIED", SIGN_IN_REFUSED);

  // Counter policy (matches the attendee module): the library itself refuses
  // an assertion whose counter did not advance past what's stored — a sign a
  // credential may have been cloned — and throws. That throw is caught below
  // and falls back to rejecting the sign-in, the same as any other
  // verification failure; the stored counter is left untouched.
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
  } catch {
    // A fixed reason code: the library's own message can echo request contents.
    logWarn("Staff passkey sign-in failed", { reason: "ASSERTION_REJECTED" });
    throw new PasskeyError("PASSKEY_NOT_VERIFIED", SIGN_IN_REFUSED);
  }
  if (!verification.verified) throw new PasskeyError("PASSKEY_NOT_VERIFIED", SIGN_IN_REFUSED);

  if (!(await advanceCounter(passkey.id, verification.authenticationInfo.newCounter, now))) {
    logWarn("Staff passkey sign-in failed", { reason: "COUNTER_NOT_ADVANCED" });
    throw new PasskeyError("PASSKEY_NOT_VERIFIED", SIGN_IN_REFUSED);
  }

  // Re-read immediately before minting, as `completeMfaChallenge` does: the
  // passkey could have been revoked (a two-step reset) or the account
  // disabled, deactivated, or locked while the assertion was being checked.
  const [stillActive, current] = await Promise.all([
    prisma.userPasskey.findFirst({ where: { id: passkey.id, revokedAt: null }, select: { id: true } }),
    prisma.user.findUnique({
      where: { id: user.id },
      select: { accountStatus: true, credential: { select: { disabledAt: true, lockedUntil: true } } },
    }),
  ]);
  if (
    !stillActive
    || !current
    || current.accountStatus !== "ACTIVE"
    || !current.credential
    || current.credential.disabledAt
    || (current.credential.lockedUntil && current.credential.lockedUntil > now)
  ) {
    throw new PasskeyError("PASSKEY_NOT_VERIFIED", SIGN_IN_REFUSED);
  }

  const session = await createDatabaseSession(user.id, userAgent);
  await writeAuditLog({
    actorUserId: user.id,
    action: "USER_PASSKEY_SIGN_IN",
    entityType: "UserPasskey",
    entityId: passkey.id,
    summary: "A staff member signed in with a passkey.",
    metadata: {},
  });
  return { userId: user.id, globalRole: user.globalRole, session };
}
