import "server-only";

import { randomInt } from "node:crypto";
import { getPrisma } from "@/lib/prisma";
import { getServerEnv } from "@/lib/env";
import { openSecret, sealSecret } from "@/lib/secret-box";
import { hashOpaqueToken } from "@/modules/access/tokens";
import { scheduleLockoutEmails } from "@/modules/communications/lockout-email";
import { hasRecentSecondFactor } from "@/modules/attendee-accounts/passkey-domain";
import {
  generateTotpSecret,
  otpauthUri,
  verifyTotp,
} from "@/modules/access/totp";

const SECRET_PURPOSE = "attendee-mfa-totp-secret";
const RECOVERY_CODE_COUNT = 10;
// Decision 2026-09-25 (#456): three wrong codes, not zero enforcement, lock
// the second factor for fifteen minutes — the attendee/club-leader equivalent
// of the staff threshold in modules/access/mfa-service.ts.
const MAX_VERIFY_FAILURES = 3;
const VERIFY_LOCK_MINUTES = 15;

export class AttendeeMfaError extends Error {
  constructor(
    public readonly code:
      | "MFA_NOT_ENROLLED"
      | "MFA_ALREADY_ACTIVE"
      | "MFA_CODE_INVALID"
      | "MFA_LOCKED"
      | "RECENT_VERIFICATION_REQUIRED"
      | "MFA_REMOVAL_NOT_ALLOWED",
    message: string,
  ) {
    super(message);
    this.name = "AttendeeMfaError";
  }
}

function issuerName() {
  try {
    return new URL(getServerEnv().APP_BASE_URL).hostname;
  } catch {
    return "IMSDA Events";
  }
}

function generateRecoveryCode() {
  const digits = Array.from({ length: 10 }, () => randomInt(0, 10)).join("");
  return `${digits.slice(0, 5)}-${digits.slice(5)}`;
}

async function replaceRecoveryCodes(enrollmentId: string) {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  await getPrisma().$transaction([
    getPrisma().attendeeMfaRecoveryCode.deleteMany({ where: { enrollmentId } }),
    getPrisma().attendeeMfaRecoveryCode.createMany({
      data: codes.map((code) => ({ enrollmentId, codeHash: hashOpaqueToken(code) })),
    }),
  ]);
  return codes;
}

export async function getAttendeeMfaStatus(accountId: string) {
  const enrollment = await getPrisma().attendeeMfaEnrollment.findUnique({
    where: { accountId },
    select: {
      status: true,
      confirmedAt: true,
      lastVerifiedAt: true,
      recoveryCodes: { where: { usedAt: null }, select: { id: true } },
    },
  });
  return {
    required: false,
    status: enrollment?.status ?? "NONE",
    confirmedAt: enrollment?.confirmedAt?.toISOString() ?? null,
    lastVerifiedAt: enrollment?.lastVerifiedAt?.toISOString() ?? null,
    unusedRecoveryCodes: enrollment?.recoveryCodes.length ?? 0,
  } as const;
}

export async function beginAttendeeMfaEnrollment(accountId: string) {
  const account = await getPrisma().attendeeAccount.findUniqueOrThrow({
    where: { id: accountId },
    select: {
      email: true,
      mfaEnrollment: { select: { status: true } },
    },
  });
  if (account.mfaEnrollment?.status === "ACTIVE") {
    throw new AttendeeMfaError(
      "MFA_ALREADY_ACTIVE",
      "This account already has an authenticator.",
    );
  }

  const secret = generateTotpSecret();
  const sealedSecret = sealSecret(secret, SECRET_PURPOSE);
  await getPrisma().attendeeMfaEnrollment.upsert({
    where: { accountId },
    update: {
      sealedSecret,
      status: "PENDING",
      lastUsedStep: null,
      failedAttempts: 0,
      lockedUntil: null,
      confirmedAt: null,
    },
    create: {
      accountId,
      sealedSecret,
      status: "PENDING",
    },
  });
  return {
    secret,
    otpauthUri: otpauthUri({
      secretBase32: secret,
      accountName: account.email,
      issuer: issuerName(),
    }),
  };
}

export async function confirmAttendeeMfaEnrollment(
  accountId: string,
  code: string,
  now = new Date(),
) {
  const enrollment = await getPrisma().attendeeMfaEnrollment.findUnique({
    where: { accountId },
    select: { id: true, status: true, sealedSecret: true, lastUsedStep: true },
  });
  if (!enrollment || enrollment.status === "ACTIVE") {
    throw new AttendeeMfaError(
      "MFA_NOT_ENROLLED",
      "Start setting up an authenticator before confirming a code.",
    );
  }
  const verified = verifyTotp(openSecret(enrollment.sealedSecret, SECRET_PURPOSE), code, {
    at: now,
    lastUsedStep: enrollment.lastUsedStep === null ? null : Number(enrollment.lastUsedStep),
  });
  if (!verified.valid) {
    throw new AttendeeMfaError("MFA_CODE_INVALID", "That code is not right. Try the next one.");
  }
  await getPrisma().attendeeMfaEnrollment.update({
    where: { id: enrollment.id },
    data: {
      status: "ACTIVE",
      confirmedAt: now,
      lastVerifiedAt: now,
      lastUsedStep: BigInt(verified.step),
      failedAttempts: 0,
      lockedUntil: null,
    },
  });
  return { recoveryCodes: await replaceRecoveryCodes(enrollment.id) };
}

/**
 * Recovery codes pass the second step on their own, so minting new ones needs
 * more than the password: either this session passed a second step within the
 * same window passkey changes use ({@link hasRecentSecondFactor}), or the
 * request carries a current authenticator (or recovery) code, checked through
 * the same single-use path and lockout as every other code. A phished
 * password alone must not be enough to mint codes and open club rosters.
 */
export async function regenerateAttendeeRecoveryCodes(
  accountId: string,
  proof: { sessionId: string | null; code?: string | null },
  now = new Date(),
) {
  const enrollment = await getPrisma().attendeeMfaEnrollment.findUnique({
    where: { accountId },
    select: { id: true, status: true },
  });
  if (enrollment?.status !== "ACTIVE") {
    throw new AttendeeMfaError("MFA_NOT_ENROLLED", "This account has no authenticator.");
  }
  if (!proof.sessionId) {
    throw new AttendeeMfaError(
      "RECENT_VERIFICATION_REQUIRED",
      "Sign in with your own attendee account to issue new recovery codes.",
    );
  }
  if (proof.code) {
    // Throws MFA_CODE_INVALID or MFA_LOCKED, and counts toward the lock.
    await verifyAttendeeSecondFactor(accountId, proof.code, now);
  } else {
    const session = await getPrisma().attendeeSession.findUnique({
      where: { id: proof.sessionId },
      select: { accountId: true, secondFactorVerifiedAt: true },
    });
    if (session?.accountId !== accountId || !hasRecentSecondFactor(session.secondFactorVerifiedAt, now)) {
      throw new AttendeeMfaError(
        "RECENT_VERIFICATION_REQUIRED",
        "Enter a code from your authenticator to issue new recovery codes.",
      );
    }
  }
  return { recoveryCodes: await replaceRecoveryCodes(enrollment.id) };
}

type Enrollment = {
  id: string;
  sealedSecret: string;
  lastUsedStep: bigint | null;
};

async function consumeSecondFactor(enrollment: Enrollment, presented: string, now: Date) {
  const verified = verifyTotp(openSecret(enrollment.sealedSecret, SECRET_PURPOSE), presented, {
    at: now,
    lastUsedStep: enrollment.lastUsedStep === null ? null : Number(enrollment.lastUsedStep),
  });
  if (verified.valid) {
    const claimed = await getPrisma().attendeeMfaEnrollment.updateMany({
      where: {
        id: enrollment.id,
        OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: BigInt(verified.step) } }],
      },
      data: {
        lastUsedStep: BigInt(verified.step),
        lastVerifiedAt: now,
        failedAttempts: 0,
        lockedUntil: null,
      },
    });
    return claimed.count === 1;
  }
  const recovery = await getPrisma().attendeeMfaRecoveryCode.updateMany({
    where: {
      enrollmentId: enrollment.id,
      codeHash: hashOpaqueToken(presented.trim()),
      usedAt: null,
    },
    data: { usedAt: now },
  });
  if (recovery.count !== 1) return false;
  await getPrisma().attendeeMfaEnrollment.update({
    where: { id: enrollment.id },
    data: { lastVerifiedAt: now, failedAttempts: 0, lockedUntil: null },
  });
  return true;
}

/** No lock, or one that has already expired: the "no live lock" predicate. */
function noLiveLock(now: Date) {
  return [{ lockedUntil: null }, { lockedUntil: { lte: now } }];
}

/**
 * Reserves one guess before any code is checked (#456 re-review). The counter
 * is incremented only while there is no live lock and fewer than
 * {@link MAX_VERIFY_FAILURES} guesses are outstanding, in one conditional
 * statement — so a parallel burst gets at most that many verifications, not
 * as many as can read "unlocked" before the first lock lands. A right code
 * resets the counter (in `consumeSecondFactor`); a wrong one keeps its
 * reservation. `false` means no guess is available: the caller refuses.
 */
async function reserveCodeAttempt(enrollmentId: string, now: Date) {
  const reserved = await getPrisma().attendeeMfaEnrollment.updateMany({
    where: { id: enrollmentId, failedAttempts: { lt: MAX_VERIFY_FAILURES }, OR: noLiveLock(now) },
    data: { failedAttempts: { increment: 1 } },
  });
  return reserved.count === 1;
}

/**
 * Claims the not-locked -> locked transition once the reserved guesses are
 * spent. The conditional `updateMany` matches for exactly one request, and
 * only that one schedules the lockout email (#456), after the response. Also
 * run when a reservation is refused, so a counter left at the maximum by an
 * interrupted request still turns into a (temporary) lock rather than a
 * permanent one. Mirrors modules/access/mfa-service.ts for staff.
 */
async function claimCodeLock(accountId: string, enrollmentId: string, now: Date) {
  const lockedUntil = new Date(now.getTime() + VERIFY_LOCK_MINUTES * 60 * 1000);
  const claimed = await getPrisma().attendeeMfaEnrollment.updateMany({
    where: { id: enrollmentId, failedAttempts: { gte: MAX_VERIFY_FAILURES }, OR: noLiveLock(now) },
    data: { lockedUntil, failedAttempts: 0 },
  });
  if (claimed.count === 1) {
    scheduleLockoutEmails({
      audience: "ATTENDEE",
      kind: "CODE",
      accountAttendeeId: accountId,
      lockedUntil,
      now,
    });
  }
}

function lockedError() {
  return new AttendeeMfaError(
    "MFA_LOCKED",
    "Too many incorrect codes. Wait a few minutes and try again.",
  );
}

export async function verifyAttendeeSecondFactor(
  accountId: string,
  code: string,
  now = new Date(),
) {
  const enrollment = await getPrisma().attendeeMfaEnrollment.findUnique({
    where: { accountId },
    select: { id: true, status: true, sealedSecret: true, lastUsedStep: true, lockedUntil: true },
  });
  if (enrollment?.status !== "ACTIVE") {
    throw new AttendeeMfaError(
      "MFA_NOT_ENROLLED",
      "Set up an authenticator before opening sensitive information.",
    );
  }
  if (enrollment.lockedUntil && enrollment.lockedUntil > now) throw lockedError();
  if (!await reserveCodeAttempt(enrollment.id, now)) {
    await claimCodeLock(accountId, enrollment.id, now);
    throw lockedError();
  }
  if (!await consumeSecondFactor(enrollment, code, now)) {
    await claimCodeLock(accountId, enrollment.id, now);
    throw new AttendeeMfaError("MFA_CODE_INVALID", "That code is not right.");
  }
}

/**
 * Nobody can turn off their own second step (decision 2026-09-23). A lost
 * device is reset by a system administrator instead.
 */
export async function disableAttendeeMfa(accountId: string, code: string, now = new Date()): Promise<never> {
  void accountId;
  void code;
  void now;
  throw new AttendeeMfaError(
    "MFA_REMOVAL_NOT_ALLOWED",
    "Two-step sign-in can't be turned off. If you lose your device, ask the conference office to reset it.",
  );
}
