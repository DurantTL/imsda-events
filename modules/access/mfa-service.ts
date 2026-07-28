import "server-only";

import { randomInt, randomUUID } from "node:crypto";
import { getPrisma } from "@/lib/prisma";
import { getServerEnv } from "@/lib/env";
import { openSecret, sealSecret } from "@/lib/secret-box";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { createDatabaseSession } from "@/modules/access/session-store";
import { createOpaqueToken, hashOpaqueToken } from "@/modules/access/tokens";
import { mfaGateFor, requiresMfa, type MfaGate } from "@/modules/access/mfa-rules";
import {
  generateTotpSecret,
  otpauthUri,
  verifyTotp,
} from "@/modules/access/totp";

/**
 * Enrolment, the sign-in challenge, and recovery codes.
 *
 * The shape of sign-in is deliberate: a correct password produces a
 * **challenge**, not a session. An account that must carry a second factor and
 * has not enrolled one cannot obtain a session at all — it is sent to enrol
 * inside the same challenge. That means there is no state in which a privileged
 * session exists without a second factor behind it, and no permission check
 * anywhere else has to know MFA exists.
 */

const SECRET_PURPOSE = "mfa-totp-secret";
const CHALLENGE_LIFETIME_MINUTES = 10;
const MAX_CHALLENGE_ATTEMPTS = 5;
const MAX_VERIFY_FAILURES = 5;
const VERIFY_LOCK_MINUTES = 15;
const RECOVERY_CODE_COUNT = 10;

export class MfaError extends Error {
  constructor(
    public readonly code:
      | "MFA_NOT_ENROLLED"
      | "MFA_ALREADY_ACTIVE"
      | "MFA_CHALLENGE_INVALID"
      | "MFA_CODE_INVALID"
      | "MFA_LOCKED"
      | "MFA_REQUIRED_BY_ROLE",
    message: string,
  ) {
    super(message);
    this.name = "MfaError";
  }
}

function issuerName() {
  try {
    return new URL(getServerEnv().APP_BASE_URL).hostname;
  } catch {
    return "IMSDA Events";
  }
}

async function subjectFor(userId: string) {
  const user = await getPrisma().user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      displayName: true,
      globalRole: true,
      memberships: { where: { status: "ACTIVE" }, select: { role: true } },
      mfaEnrollment: { select: { id: true, status: true } },
    },
  });
  return {
    user,
    subject: {
      globalRole: user.globalRole,
      activeEventRoles: user.memberships.map((membership) => membership.role),
    },
  };
}

/** Whether this account is obliged to carry a second factor. */
export async function accountRequiresMfa(userId: string) {
  const { subject } = await subjectFor(userId);
  return requiresMfa(subject);
}

export type MfaEnrollmentOffer = {
  secret: string;
  otpauthUri: string;
};

/**
 * Starts (or restarts) enrolment. The secret is returned once, to be shown as a
 * QR code and as text; only its sealed form is stored, and the enrolment stays
 * PENDING — useless for signing in — until a code from it is confirmed.
 *
 * Restarting replaces a PENDING enrolment: somebody who lost the QR code before
 * confirming must be able to start again. An ACTIVE one is not replaced without
 * being disabled first.
 */
export async function beginMfaEnrollment(userId: string): Promise<MfaEnrollmentOffer> {
  const { user } = await subjectFor(userId);
  if (user.mfaEnrollment?.status === "ACTIVE") {
    throw new MfaError(
      "MFA_ALREADY_ACTIVE",
      "This account already has an authenticator. Remove it before adding another.",
    );
  }

  const secret = generateTotpSecret();
  const sealedSecret = sealSecret(secret, SECRET_PURPOSE);
  await getPrisma().userMfaEnrollment.upsert({
    where: { userId },
    update: {
      sealedSecret,
      status: "PENDING",
      lastUsedStep: null,
      failedAttempts: 0,
      lockedUntil: null,
      confirmedAt: null,
    },
    create: { userId, sealedSecret, status: "PENDING" },
  });

  return {
    secret,
    otpauthUri: otpauthUri({
      secretBase32: secret,
      accountName: user.email,
      issuer: issuerName(),
    }),
  };
}

function generateRecoveryCode() {
  // Ten digits in two groups: unambiguous to read aloud and to type, and drawn
  // from a CSPRNG rather than Math.random.
  const digits = Array.from({ length: 10 }, () => randomInt(0, 10)).join("");
  return `${digits.slice(0, 5)}-${digits.slice(5)}`;
}

async function replaceRecoveryCodes(enrollmentId: string) {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  await getPrisma().$transaction([
    getPrisma().mfaRecoveryCode.deleteMany({ where: { enrollmentId } }),
    getPrisma().mfaRecoveryCode.createMany({
      data: codes.map((code) => ({ enrollmentId, codeHash: hashOpaqueToken(code) })),
    }),
  ]);
  return codes;
}

/**
 * Confirms enrolment with a code from the authenticator, which is the only
 * proof the secret was actually transferred. Returns the recovery codes, once.
 */
export async function confirmMfaEnrollment(
  userId: string,
  code: string,
  options: { now?: Date } = {},
) {
  const now = options.now ?? new Date();
  const enrollment = await getPrisma().userMfaEnrollment.findUnique({
    where: { userId },
    select: { id: true, status: true, sealedSecret: true, lastUsedStep: true },
  });
  if (!enrollment || enrollment.status === "ACTIVE") {
    throw new MfaError(
      "MFA_NOT_ENROLLED",
      "Start setting up an authenticator before confirming a code.",
    );
  }

  const verification = verifyTotp(openSecret(enrollment.sealedSecret, SECRET_PURPOSE), code, {
    at: now,
    lastUsedStep: enrollment.lastUsedStep === null ? null : Number(enrollment.lastUsedStep),
  });
  if (!verification.valid) {
    throw new MfaError("MFA_CODE_INVALID", "That code is not right. Try the next one.");
  }

  await getPrisma().userMfaEnrollment.update({
    where: { id: enrollment.id },
    data: {
      status: "ACTIVE",
      confirmedAt: now,
      lastVerifiedAt: now,
      lastUsedStep: BigInt(verification.step),
      failedAttempts: 0,
      lockedUntil: null,
    },
  });

  const recoveryCodes = await replaceRecoveryCodes(enrollment.id);

  await writeAuditLog({
    actorUserId: userId,
    action: "MFA_ENROLLED",
    entityType: "User",
    entityId: userId,
    correlationId: randomUUID(),
    summary: "An authenticator was added to this account.",
    metadata: { method: "TOTP", recoveryCodesIssued: recoveryCodes.length },
  });

  return { recoveryCodes };
}

/** Issues a new set, retiring the old. Requires an already-active enrolment. */
export async function regenerateRecoveryCodes(userId: string) {
  const enrollment = await getPrisma().userMfaEnrollment.findUnique({
    where: { userId },
    select: { id: true, status: true },
  });
  if (enrollment?.status !== "ACTIVE") {
    throw new MfaError("MFA_NOT_ENROLLED", "This account has no authenticator to issue codes for.");
  }
  const recoveryCodes = await replaceRecoveryCodes(enrollment.id);
  await writeAuditLog({
    actorUserId: userId,
    action: "MFA_RECOVERY_CODES_REGENERATED",
    entityType: "User",
    entityId: userId,
    correlationId: randomUUID(),
    summary: "New recovery codes were issued; the previous set stopped working.",
    metadata: { recoveryCodesIssued: recoveryCodes.length },
  });
  return { recoveryCodes };
}

/**
 * Removes the second factor. Refused for an account whose role requires one —
 * removing it would leave a privileged account on a password alone, and the
 * next sign-in would demand enrolment anyway.
 */
export async function disableMfa(userId: string, code: string, options: { now?: Date } = {}) {
  const now = options.now ?? new Date();
  const { subject } = await subjectFor(userId);
  if (requiresMfa(subject)) {
    throw new MfaError(
      "MFA_REQUIRED_BY_ROLE",
      "This account administers events, so it must keep an authenticator. Remove its administrator access first.",
    );
  }

  const enrollment = await getPrisma().userMfaEnrollment.findUnique({
    where: { userId },
    select: { id: true, status: true, sealedSecret: true, lastUsedStep: true },
  });
  if (enrollment?.status !== "ACTIVE") {
    throw new MfaError("MFA_NOT_ENROLLED", "This account has no authenticator to remove.");
  }

  const accepted = await consumeSecondFactor(enrollment, code, now);
  if (!accepted.valid) {
    throw new MfaError("MFA_CODE_INVALID", "That code is not right.");
  }

  await getPrisma().userMfaEnrollment.delete({ where: { id: enrollment.id } });
  await writeAuditLog({
    actorUserId: userId,
    action: "MFA_DISABLED",
    entityType: "User",
    entityId: userId,
    correlationId: randomUUID(),
    summary: "The authenticator was removed from this account.",
    metadata: { method: "TOTP" },
  });
}

type EnrollmentRecord = {
  id: string;
  status: "PENDING" | "ACTIVE";
  sealedSecret: string;
  lastUsedStep: bigint | null;
};

/**
 * Accepts either an authenticator code or an unused recovery code, and spends
 * whichever it was. Both paths are single-use: a TOTP step is recorded so it
 * cannot be replayed, and a recovery code is marked used.
 */
async function consumeSecondFactor(
  enrollment: EnrollmentRecord,
  presented: string,
  now: Date,
): Promise<{ valid: boolean; usedRecoveryCode?: boolean }> {
  const verification = verifyTotp(openSecret(enrollment.sealedSecret, SECRET_PURPOSE), presented, {
    at: now,
    lastUsedStep: enrollment.lastUsedStep === null ? null : Number(enrollment.lastUsedStep),
  });
  if (verification.valid) {
    const claimed = await getPrisma().userMfaEnrollment.updateMany({
      where: {
        id: enrollment.id,
        OR: [
          { lastUsedStep: null },
          { lastUsedStep: { lt: BigInt(verification.step) } },
        ],
      },
      data: {
        lastUsedStep: BigInt(verification.step),
        lastVerifiedAt: now,
        failedAttempts: 0,
        lockedUntil: null,
      },
    });
    // Losing the race means the same step was spent by a concurrent request.
    return { valid: claimed.count === 1 };
  }

  const spent = await getPrisma().mfaRecoveryCode.updateMany({
    where: {
      enrollmentId: enrollment.id,
      codeHash: hashOpaqueToken(presented.trim()),
      usedAt: null,
    },
    data: { usedAt: now },
  });
  if (spent.count === 1) {
    await getPrisma().userMfaEnrollment.update({
      where: { id: enrollment.id },
      data: { lastVerifiedAt: now, failedAttempts: 0, lockedUntil: null },
    });
    return { valid: true, usedRecoveryCode: true };
  }

  return { valid: false };
}

export type MfaChallengeIssue = {
  challengeToken: string;
  gate: Exclude<MfaGate["kind"], "not_required">;
  expiresAt: Date;
};

/**
 * Records that a password was accepted and a second factor is still outstanding.
 * The raw token is returned once and stored only as a digest, like every other
 * bearer value in this codebase.
 */
export async function issueMfaChallenge(
  userId: string,
  gate: Exclude<MfaGate["kind"], "not_required">,
  options: { userAgent?: string | null; now?: Date } = {},
): Promise<MfaChallengeIssue> {
  const now = options.now ?? new Date();
  const token = createOpaqueToken();
  const expiresAt = new Date(now.getTime() + CHALLENGE_LIFETIME_MINUTES * 60 * 1000);
  await getPrisma().$transaction([
    // One live challenge per account: a second sign-in attempt retires the first.
    getPrisma().mfaChallenge.updateMany({
      where: { userId, consumedAt: null },
      data: { consumedAt: now },
    }),
    getPrisma().mfaChallenge.create({
      data: {
        userId,
        tokenHash: hashOpaqueToken(token),
        expiresAt,
        userAgent: options.userAgent ?? null,
      },
    }),
  ]);
  return { challengeToken: token, gate, expiresAt };
}

async function liveChallenge(token: string, now: Date) {
  const challenge = await getPrisma().mfaChallenge.findUnique({
    where: { tokenHash: hashOpaqueToken(token) },
    select: {
      id: true,
      userId: true,
      expiresAt: true,
      consumedAt: true,
      attempts: true,
      userAgent: true,
    },
  });
  if (
    !challenge
    || challenge.consumedAt
    || challenge.expiresAt <= now
    || challenge.attempts >= MAX_CHALLENGE_ATTEMPTS
  ) {
    throw new MfaError(
      "MFA_CHALLENGE_INVALID",
      "This sign-in attempt has expired. Enter your email and password again.",
    );
  }
  return challenge;
}

/** Describes a live challenge to the sign-in page, revealing nothing else. */
export async function describeMfaChallenge(token: string, options: { now?: Date } = {}) {
  const now = options.now ?? new Date();
  const challenge = await liveChallenge(token, now);
  const { user } = await subjectFor(challenge.userId);
  return {
    gate: user.mfaEnrollment?.status === "ACTIVE" ? "challenge" as const : "enrol" as const,
    email: user.email,
  };
}

/**
 * Starts enrolment from inside a sign-in challenge, for an account that must
 * carry a second factor and has never set one up. Proving the password is what
 * authorises this; no session exists yet and none is issued here.
 */
export async function beginEnrollmentFromChallenge(
  token: string,
  options: { now?: Date } = {},
) {
  const now = options.now ?? new Date();
  const challenge = await liveChallenge(token, now);
  return beginMfaEnrollment(challenge.userId);
}

export type MfaSignInResult = {
  session: { token: string; expiresAt: Date };
  usedRecoveryCode: boolean;
  recoveryCodes?: string[];
};

/**
 * Completes sign-in. Accepts a code from a confirmed authenticator, a recovery
 * code, or — when the challenge is an enrolment — the first code from a freshly
 * scanned secret, which confirms the enrolment and returns recovery codes.
 */
export async function completeMfaChallenge(
  token: string,
  code: string,
  options: { userAgent?: string | null; now?: Date } = {},
): Promise<MfaSignInResult> {
  const now = options.now ?? new Date();
  const challenge = await liveChallenge(token, now);
  await getPrisma().mfaChallenge.update({
    where: { id: challenge.id },
    data: { attempts: { increment: 1 } },
  });

  const enrollment = await getPrisma().userMfaEnrollment.findUnique({
    where: { userId: challenge.userId },
    select: {
      id: true,
      status: true,
      sealedSecret: true,
      lastUsedStep: true,
      lockedUntil: true,
    },
  });
  if (!enrollment) {
    throw new MfaError(
      "MFA_NOT_ENROLLED",
      "Set up an authenticator to finish signing in.",
    );
  }
  if (enrollment.lockedUntil && enrollment.lockedUntil > now) {
    throw new MfaError(
      "MFA_LOCKED",
      "Too many incorrect codes. Wait a few minutes and try again.",
    );
  }

  let recoveryCodes: string[] | undefined;
  let accepted: { valid: boolean; usedRecoveryCode?: boolean };

  if (enrollment.status === "PENDING") {
    // Confirming and signing in are one step here: the person has just scanned
    // the secret, and this code is the proof the transfer worked. A wrong code
    // throws MFA_CODE_INVALID from inside, which is the same answer this
    // function would give anyway.
    try {
      recoveryCodes = (await confirmMfaEnrollment(challenge.userId, code, { now })).recoveryCodes;
      accepted = { valid: true };
    } catch (error) {
      if (error instanceof MfaError && error.code === "MFA_CODE_INVALID") {
        accepted = { valid: false };
      } else {
        throw error;
      }
    }
  } else {
    accepted = await consumeSecondFactor(enrollment, code, now);
  }

  if (!accepted.valid) {
    const failedAttempts = await getPrisma().userMfaEnrollment.update({
      where: { id: enrollment.id },
      data: { failedAttempts: { increment: 1 } },
      select: { failedAttempts: true },
    });
    if (failedAttempts.failedAttempts >= MAX_VERIFY_FAILURES) {
      await getPrisma().userMfaEnrollment.update({
        where: { id: enrollment.id },
        data: {
          lockedUntil: new Date(now.getTime() + VERIFY_LOCK_MINUTES * 60 * 1000),
          failedAttempts: 0,
        },
      });
    }
    throw new MfaError("MFA_CODE_INVALID", "That code is not right. Try the next one.");
  }

  await getPrisma().mfaChallenge.update({
    where: { id: challenge.id },
    data: { consumedAt: now },
  });

  // Re-read immediately before minting. Consuming outstanding challenges when
  // an account is disabled closes the common case, but not the race where this
  // challenge was already read and verified when the disable landed. Without
  // this the resulting session is merely inert — refused while `disabledAt`
  // stands — and becomes usable the moment the account is re-enabled, with no
  // password or code entered again.
  const credential = await getPrisma().authCredential.findUnique({
    where: { userId: challenge.userId },
    select: { disabledAt: true },
  });
  if (!credential || credential.disabledAt) {
    throw new MfaError(
      "MFA_CHALLENGE_INVALID",
      "This sign-in is no longer valid. Start again.",
    );
  }

  const session = await createDatabaseSession(challenge.userId, challenge.userAgent ?? null);

  if (accepted.usedRecoveryCode) {
    await writeAuditLog({
      actorUserId: challenge.userId,
      action: "MFA_RECOVERY_CODE_USED",
      entityType: "User",
      entityId: challenge.userId,
      correlationId: randomUUID(),
      summary: "A recovery code was used to sign in; it can no longer be reused.",
      metadata: { remaining: await getPrisma().mfaRecoveryCode.count({
        where: { enrollmentId: enrollment.id, usedAt: null },
      }) },
    });
  }

  return {
    session,
    usedRecoveryCode: Boolean(accepted.usedRecoveryCode),
    recoveryCodes,
  };
}

/** What the account settings panel shows. */
export async function getMfaStatus(userId: string) {
  const { user, subject } = await subjectFor(userId);
  const enrollment = user.mfaEnrollment
    ? await getPrisma().userMfaEnrollment.findUnique({
        where: { userId },
        select: {
          status: true,
          confirmedAt: true,
          lastVerifiedAt: true,
          _count: { select: { recoveryCodes: { where: { usedAt: null } } } },
        },
      })
    : null;

  return {
    required: requiresMfa(subject),
    status: enrollment?.status ?? "NONE",
    confirmedAt: enrollment?.confirmedAt?.toISOString() ?? null,
    lastVerifiedAt: enrollment?.lastVerifiedAt?.toISOString() ?? null,
    unusedRecoveryCodes: enrollment?._count.recoveryCodes ?? 0,
  };
}

export { mfaGateFor };
