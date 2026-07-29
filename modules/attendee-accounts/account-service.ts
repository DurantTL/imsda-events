import "server-only";

import { getPrisma } from "@/lib/prisma";
import { hashPassword, spendPasswordCheck, verifyPassword } from "@/modules/access/passwords";
import { createOpaqueToken, hashOpaqueToken } from "@/modules/access/tokens";
import {
  EMAIL_VERIFICATION_LIFETIME_MINUTES,
  ONE_TIME_CODE_MAX_ATTEMPTS,
  oneTimeCodeMatches,
} from "@/modules/attendee-accounts/codes";
import {
  createAttendeeSession,
  revokeAllAttendeeSessions,
} from "@/modules/attendee-accounts/session-store";

/**
 * Sign-up, email verification, and password sign-in for registrants (ADR 0003).
 *
 * Two properties shape almost every decision in this file.
 *
 * **Verification is the whole control.** An account claims every registration
 * whose contact address matches its own, and nothing else. An unverified address
 * claims nothing, because claiming on an unverified address is just asking to be
 * handed somebody else's registration.
 *
 * **Nothing here may reveal whether an address is known.** Sign-up is a public,
 * unauthenticated, email-sending endpoint — the most abusable surface the
 * platform has — and "an account exists for this address" is not something a
 * stranger may learn from it. Every path through {@link beginAttendeeSignUp}
 * therefore does the same work and returns the same shape.
 */

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

/**
 * The normalisation the rest of the platform applies to an address, applied
 * here too. `Person.normalizedEmail` is written this way, and matching a
 * registration to an account is a comparison between the two — so this rule and
 * that one have to stay the same rule.
 */
export function normalizeAttendeeEmail(email: string) {
  return email.trim().toLowerCase();
}

export type AttendeeSignUp = {
  /**
   * The handle for the verification about to be emailed, held by the browser
   * that asked. Always present, including for an address that already has an
   * account — the caller must not be able to tell those cases apart.
   */
  pendingToken: string;
  expiresAt: Date;
  /**
   * Server-side only. Says which email to send, and is never returned to the
   * browser: `existing` and `created` are exactly the distinction sign-up
   * refuses to leak.
   */
  outcome: "created" | "resumed" | "existing";
  accountId: string;
};

/**
 * Starts a sign-up, or resumes one that was never finished.
 *
 * Three cases, one shape:
 *
 * - **No account.** Create one, unverified, holding the chosen password.
 * - **An unverified account.** Replace the name and password and issue a fresh
 *   verification. Nothing is claimed until an address is verified, so there is
 *   nothing here for an overwrite to take.
 * - **An active account.** Change nothing, and issue a token whose code is never
 *   minted, so it can never be completed. The address owner gets an email saying
 *   an account already exists; whoever asked gets the same response either way.
 */
export async function beginAttendeeSignUp(input: {
  email: string;
  displayName: string;
  password: string;
  now?: Date;
}): Promise<AttendeeSignUp> {
  const email = normalizeAttendeeEmail(input.email);
  const displayName = input.displayName.trim();
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + EMAIL_VERIFICATION_LIFETIME_MINUTES * 60 * 1000);

  const existing = await getPrisma().attendeeAccount.findUnique({
    where: { email },
    select: { id: true, status: true },
  });

  // Hashing is the expensive step, and skipping it for an address that already
  // has an account would make sign-up a timing oracle for exactly the fact this
  // function refuses to state. The hash for an active account is computed and
  // discarded.
  const passwordHash = await hashPassword(input.password);

  const token = createOpaqueToken();
  const tokenHash = hashOpaqueToken(token);

  if (existing?.status === "ACTIVE") {
    await issueVerificationToken(existing.id, tokenHash, expiresAt, now);
    return { pendingToken: token, expiresAt, outcome: "existing", accountId: existing.id };
  }

  const accountId = existing
    ? (await getPrisma().attendeeAccount.update({
      where: { id: existing.id },
      data: {
        displayName,
        credential: {
          upsert: {
            create: { passwordHash },
            update: { passwordHash, passwordUpdatedAt: now, failedAttempts: 0, lockedUntil: null },
          },
        },
      },
      select: { id: true },
    })).id
    : (await getPrisma().attendeeAccount.create({
      data: {
        email,
        displayName,
        status: "PENDING_VERIFICATION",
        credential: { create: { passwordHash } },
      },
      select: { id: true },
    })).id;

  await issueVerificationToken(accountId, tokenHash, expiresAt, now);
  return {
    pendingToken: token,
    expiresAt,
    outcome: existing ? "resumed" : "created",
    accountId,
  };
}

/**
 * Retires any verification still outstanding for the account and records the
 * new one. `codeHash` stays null: the code is minted when the email is actually
 * sent, so a database read never yields a usable credential and the twenty
 * minutes start when the message leaves rather than when it was queued.
 */
async function issueVerificationToken(
  accountId: string,
  tokenHash: string,
  expiresAt: Date,
  now: Date,
) {
  await getPrisma().$transaction([
    getPrisma().attendeeAccountToken.updateMany({
      where: { accountId, purpose: "EMAIL_VERIFICATION", usedAt: null },
      data: { usedAt: now },
    }),
    getPrisma().attendeeAccountToken.create({
      data: { accountId, tokenHash, purpose: "EMAIL_VERIFICATION", expiresAt },
    }),
  ]);
}

/**
 * Writes the digest of the code that is being emailed right now. Called at
 * delivery, mirroring how a private registration link is minted at send time.
 *
 * Guarded on `codeHash: null` so a redelivery cannot overwrite a code the
 * recipient may already be typing.
 */
export async function attachVerificationCode(input: {
  accountId: string;
  codeHash: string;
  now: Date;
}) {
  const claimed = await getPrisma().attendeeAccountToken.updateMany({
    where: {
      accountId: input.accountId,
      purpose: "EMAIL_VERIFICATION",
      usedAt: null,
      codeHash: null,
      expiresAt: { gt: input.now },
    },
    data: { codeHash: input.codeHash },
  });
  return claimed.count > 0;
}

/**
 * Retires a code that was minted but never handed over — an email that failed
 * definitively. Spending it is safe to repeat.
 */
export async function revokeVerificationCode(codeHash: string, now = new Date()) {
  await getPrisma().attendeeAccountToken.updateMany({
    where: { codeHash, usedAt: null },
    data: { usedAt: now },
  });
}

export type AttendeeVerification =
  | { outcome: "verified"; accountId: string; session: { token: string; expiresAt: Date } }
  | { outcome: "rejected" };

/**
 * Spends a verification code and, on success, signs the account in.
 *
 * Both halves are required: the opaque token from the browser that asked, and
 * the code from the address being claimed. Holding one without the other proves
 * nothing, which is the entire point of not sending a link.
 */
export async function verifyAttendeeEmail(input: {
  pendingToken: string;
  code: string;
  userAgent: string | null;
  now?: Date;
}): Promise<AttendeeVerification> {
  const now = input.now ?? new Date();
  const record = await getPrisma().attendeeAccountToken.findUnique({
    where: { tokenHash: hashOpaqueToken(input.pendingToken) },
    select: {
      id: true,
      accountId: true,
      codeHash: true,
      purpose: true,
      expiresAt: true,
      usedAt: true,
      attempts: true,
    },
  });

  if (
    !record
    || record.purpose !== "EMAIL_VERIFICATION"
    || record.usedAt
    || record.expiresAt <= now
    || record.attempts >= ONE_TIME_CODE_MAX_ATTEMPTS
  ) {
    return { outcome: "rejected" };
  }

  // Recorded before the comparison, so a guess that races another guess still
  // costs an attempt. Counting only failures would let a burst of concurrent
  // requests share one slot.
  const attempted = await getPrisma().attendeeAccountToken.updateMany({
    where: { id: record.id, attempts: record.attempts, usedAt: null },
    data: { attempts: record.attempts + 1 },
  });
  if (attempted.count !== 1) return { outcome: "rejected" };

  if (!oneTimeCodeMatches(input.code, record.codeHash)) {
    return { outcome: "rejected" };
  }

  const claimed = await getPrisma().$transaction(async (tx) => {
    const spent = await tx.attendeeAccountToken.updateMany({
      where: { id: record.id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (spent.count !== 1) return false;
    await tx.attendeeAccount.update({
      where: { id: record.accountId },
      data: { status: "ACTIVE", emailVerifiedAt: now },
    });
    return true;
  });
  if (!claimed) return { outcome: "rejected" };

  return {
    outcome: "verified",
    accountId: record.accountId,
    session: await createAttendeeSession(record.accountId, input.userAgent),
  };
}

/**
 * Password sign-in for an account that has already verified its address.
 *
 * An unverified account is refused here rather than signed in and shown an
 * empty page: until the address is verified there is nothing it may reach, and
 * a session that can reach nothing is a state worth not having.
 */
export async function authenticateAttendee(
  email: string,
  password: string,
  userAgent: string | null,
): Promise<{ accountId: string; session: { token: string; expiresAt: Date } } | null> {
  const account = await getPrisma().attendeeAccount.findUnique({
    where: { email: normalizeAttendeeEmail(email) },
    select: {
      id: true,
      status: true,
      disabledAt: true,
      credential: {
        select: { id: true, passwordHash: true, failedAttempts: true, lockedUntil: true, disabledAt: true },
      },
    },
  });

  // No credential is now an ordinary state, not a broken one: an account that
  // signed up with Google has never had a password. It is refused here in the
  // same words as a wrong one, so this route cannot be used to discover which
  // addresses are federated.
  if (!account?.credential || account.status !== "ACTIVE" || account.disabledAt) {
    await spendPasswordCheck(password);
    return null;
  }

  const credential = account.credential;
  if (credential.disabledAt || (credential.lockedUntil && credential.lockedUntil > new Date())) {
    await spendPasswordCheck(password);
    return null;
  }

  if (!await verifyPassword(password, credential.passwordHash)) {
    const failedAttempts = credential.failedAttempts + 1;
    await getPrisma().attendeeCredential.update({
      where: { id: credential.id },
      data: {
        failedAttempts,
        lockedUntil: failedAttempts >= MAX_FAILED_ATTEMPTS
          ? new Date(Date.now() + LOCK_MINUTES * 60 * 1000)
          : null,
      },
    });
    return null;
  }

  await getPrisma().attendeeCredential.update({
    where: { id: credential.id },
    data: { failedAttempts: 0, lockedUntil: null },
  });

  return {
    accountId: account.id,
    session: await createAttendeeSession(account.id, userAgent),
  };
}

/** Signs every device out of an account. Used when a password changes. */
export async function signOutEverywhere(accountId: string, now = new Date()) {
  await revokeAllAttendeeSessions(accountId, now);
}

export type AttendeePasswordResetRequest = {
  /** Always present, so a request for an unknown address looks like any other. */
  pendingToken: string;
  expiresAt: Date;
  /**
   * Server-side only: which email to send, or none at all. Never returned to
   * the browser — these three cases are exactly what the response conceals.
   */
  outcome: "issued" | "federated-only" | "no-account";
  accountId: string | null;
  displayName: string;
};

/**
 * Starts a password reset.
 *
 * Only an account that is ACTIVE and actually holds a password gets a code. An
 * unverified sign-up must not be resettable: letting a password be replaced
 * there would activate an account without anyone ever proving they can read the
 * address, which is the one thing verification exists to establish.
 *
 * An account that only ever signed in with Google gets an email saying so
 * rather than a code. Minting one would be worse than useless — it would offer
 * a way to put a password on an account whose owner deliberately has none.
 */
export async function beginAttendeePasswordReset(input: {
  email: string;
  now?: Date;
}): Promise<AttendeePasswordResetRequest> {
  const email = normalizeAttendeeEmail(input.email);
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + EMAIL_VERIFICATION_LIFETIME_MINUTES * 60 * 1000);
  const token = createOpaqueToken();

  const account = await getPrisma().attendeeAccount.findUnique({
    where: { email },
    select: {
      id: true,
      status: true,
      displayName: true,
      disabledAt: true,
      credential: { select: { id: true, disabledAt: true } },
      identities: { select: { id: true }, take: 1 },
    },
  });

  // The same dummy work `issueAccountToken` does, for the same reason: without
  // it, an address with no account answers measurably faster than one with.
  await spendPasswordCheck(email);

  if (!account || account.disabledAt || account.status !== "ACTIVE") {
    return { pendingToken: token, expiresAt, outcome: "no-account", accountId: null, displayName: "" };
  }

  if (!account.credential || account.credential.disabledAt) {
    return {
      pendingToken: token,
      expiresAt,
      outcome: account.identities.length > 0 ? "federated-only" : "no-account",
      accountId: account.id,
      displayName: account.displayName,
    };
  }

  await getPrisma().$transaction([
    getPrisma().attendeeAccountToken.updateMany({
      where: { accountId: account.id, purpose: "PASSWORD_RESET", usedAt: null },
      data: { usedAt: now },
    }),
    getPrisma().attendeeAccountToken.create({
      data: {
        accountId: account.id,
        tokenHash: hashOpaqueToken(token),
        purpose: "PASSWORD_RESET",
        expiresAt,
      },
    }),
  ]);

  return {
    pendingToken: token,
    expiresAt,
    outcome: "issued",
    accountId: account.id,
    displayName: account.displayName,
  };
}

/** The reset counterpart of {@link attachVerificationCode}. */
export async function attachPasswordResetCode(input: {
  accountId: string;
  codeHash: string;
  now: Date;
}) {
  const claimed = await getPrisma().attendeeAccountToken.updateMany({
    where: {
      accountId: input.accountId,
      purpose: "PASSWORD_RESET",
      usedAt: null,
      codeHash: null,
      expiresAt: { gt: input.now },
    },
    data: { codeHash: input.codeHash },
  });
  return claimed.count > 0;
}

export type AttendeePasswordReset =
  | { outcome: "reset"; accountId: string; session: { token: string; expiresAt: Date } }
  | { outcome: "rejected" };

/**
 * Spends a reset code and sets the new password.
 *
 * Every other session is revoked in the same transaction. Someone resetting a
 * password is often doing it because they think somebody else has the old one,
 * and leaving those sessions alive would answer the wrong half of that worry.
 * A fresh session is issued afterwards so the person is not made to sign in
 * again with the password they just chose.
 */
export async function completeAttendeePasswordReset(input: {
  pendingToken: string;
  code: string;
  passwordHash: string;
  userAgent: string | null;
  now?: Date;
}): Promise<AttendeePasswordReset> {
  const now = input.now ?? new Date();
  const record = await getPrisma().attendeeAccountToken.findUnique({
    where: { tokenHash: hashOpaqueToken(input.pendingToken) },
    select: {
      id: true,
      accountId: true,
      codeHash: true,
      purpose: true,
      expiresAt: true,
      usedAt: true,
      attempts: true,
    },
  });

  if (
    !record
    || record.purpose !== "PASSWORD_RESET"
    || record.usedAt
    || record.expiresAt <= now
    || record.attempts >= ONE_TIME_CODE_MAX_ATTEMPTS
  ) {
    return { outcome: "rejected" };
  }

  const attempted = await getPrisma().attendeeAccountToken.updateMany({
    where: { id: record.id, attempts: record.attempts, usedAt: null },
    data: { attempts: record.attempts + 1 },
  });
  if (attempted.count !== 1) return { outcome: "rejected" };

  if (!oneTimeCodeMatches(input.code, record.codeHash)) {
    return { outcome: "rejected" };
  }

  const applied = await getPrisma().$transaction(async (tx) => {
    const spent = await tx.attendeeAccountToken.updateMany({
      where: { id: record.id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (spent.count !== 1) return false;
    await tx.attendeeCredential.update({
      where: { accountId: record.accountId },
      data: {
        passwordHash: input.passwordHash,
        passwordUpdatedAt: now,
        failedAttempts: 0,
        lockedUntil: null,
      },
    });
    await tx.attendeeSession.updateMany({
      where: { accountId: record.accountId, revokedAt: null },
      data: { revokedAt: now },
    });
    return true;
  });
  if (!applied) return { outcome: "rejected" };

  return {
    outcome: "reset",
    accountId: record.accountId,
    session: await createAttendeeSession(record.accountId, input.userAgent),
  };
}
