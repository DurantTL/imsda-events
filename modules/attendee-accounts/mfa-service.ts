import "server-only";

import { randomInt } from "node:crypto";
import { getPrisma } from "@/lib/prisma";
import { getServerEnv } from "@/lib/env";
import { openSecret, sealSecret } from "@/lib/secret-box";
import { hashOpaqueToken } from "@/modules/access/tokens";
import { dispatchLockoutEmails } from "@/modules/communications/lockout-email";
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

export async function regenerateAttendeeRecoveryCodes(accountId: string) {
  const enrollment = await getPrisma().attendeeMfaEnrollment.findUnique({
    where: { accountId },
    select: { id: true, status: true },
  });
  if (enrollment?.status !== "ACTIVE") {
    throw new AttendeeMfaError("MFA_NOT_ENROLLED", "This account has no authenticator.");
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

/**
 * Counts a wrong code toward the second factor's lockout, and — on the exact
 * attempt that crosses into locked, never before it and never while already
 * locked — sends the lockout email (#456). Mirrors `recordFailedCode` in
 * modules/access/mfa-service.ts for staff.
 */
async function recordFailedCode(accountId: string, enrollmentId: string, now: Date) {
  const failedAttempts = await getPrisma().attendeeMfaEnrollment.update({
    where: { id: enrollmentId },
    data: { failedAttempts: { increment: 1 } },
    select: { failedAttempts: true },
  });
  if (failedAttempts.failedAttempts >= MAX_VERIFY_FAILURES) {
    const lockedUntil = new Date(now.getTime() + VERIFY_LOCK_MINUTES * 60 * 1000);
    await getPrisma().attendeeMfaEnrollment.update({
      where: { id: enrollmentId },
      data: { lockedUntil, failedAttempts: 0 },
    });
    await dispatchLockoutEmails({
      audience: "ATTENDEE",
      kind: "CODE",
      accountAttendeeId: accountId,
      lockedUntil,
      now,
    });
  }
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
  if (enrollment.lockedUntil && enrollment.lockedUntil > now) {
    throw new AttendeeMfaError(
      "MFA_LOCKED",
      "Too many incorrect codes. Wait a few minutes and try again.",
    );
  }
  if (!await consumeSecondFactor(enrollment, code, now)) {
    await recordFailedCode(accountId, enrollment.id, now);
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
