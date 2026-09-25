import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Staff sign-in security policy (#456): the lockout email is scheduled only
 * by the attempt that wins the claim on the not-locked -> locked transition —
 * never on the attempts before it, never again while the account stays
 * locked, and once when two wrong attempts race. `scheduleLockoutEmails`
 * itself is covered separately (tests/lockout-email.test.ts); this asserts
 * the call sites trigger it correctly and only then.
 */

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  getServerEnv: vi.fn(),
  verifyPassword: vi.fn(),
  spendPasswordCheck: vi.fn(),
  hashPassword: vi.fn(),
  createDatabaseSession: vi.fn(),
  scheduleLockoutEmails: vi.fn(),
  writeAuditLog: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@/lib/env", () => ({ getServerEnv: dependencies.getServerEnv }));
vi.mock("@/modules/access/passwords", () => ({
  hashPassword: dependencies.hashPassword,
  verifyPassword: dependencies.verifyPassword,
  spendPasswordCheck: dependencies.spendPasswordCheck,
}));
vi.mock("@/modules/access/session-store", () => ({
  createDatabaseSession: dependencies.createDatabaseSession,
}));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: dependencies.writeAuditLog }));
vi.mock("@/modules/communications/lockout-email", () => ({
  scheduleLockoutEmails: dependencies.scheduleLockoutEmails,
}));

import { authenticateWithPassword } from "@/modules/access/auth-service";
import { completeMfaChallenge } from "@/modules/access/mfa-service";
import { sealSecret } from "@/lib/secret-box";
import { totpCode } from "@/modules/access/totp";
import { lockableRowStub, type LockableRow } from "./lockable-row-stub";

const now = new Date("2026-09-25T18:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.spendPasswordCheck.mockResolvedValue(undefined);
  dependencies.getServerEnv.mockReturnValue({
    APP_BASE_URL: "https://events.imsda.org",
    SECRET_ENCRYPTION_KEY: "an-encryption-key-long-enough-for-tests",
  });
});

describe("wrong password (#456)", () => {
  function userFixture(row: LockableRow) {
    return {
      id: "user-1",
      accountStatus: "ACTIVE",
      globalRole: null,
      memberships: [],
      mfaEnrollment: null,
      passkeys: [],
      credential: {
        id: "cred-1",
        passwordHash: "hash",
        failedAttempts: row.failedAttempts,
        lockedUntil: row.lockedUntil,
        disabledAt: null,
      },
    };
  }

  /** Each sign-in reads the credential as it stands at that moment. */
  function prismaFixture(initial: Partial<LockableRow> = {}) {
    const credential = lockableRowStub(initial);
    const stub = {
      user: { findUnique: vi.fn(async () => userFixture({ ...credential.row })) },
      authCredential: { update: credential.update, updateMany: credential.updateMany },
    };
    dependencies.getPrisma.mockReturnValue(stub);
    return { stub, credential };
  }

  it("sends no email on the first four wrong passwords", async () => {
    const { credential } = prismaFixture();
    dependencies.verifyPassword.mockResolvedValue(false);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await authenticateWithPassword("staff@imsda.org", "wrong", null);
    }
    expect(credential.row.failedAttempts).toBe(4);
    expect(credential.row.lockedUntil).toBeNull();
    expect(dependencies.scheduleLockoutEmails).not.toHaveBeenCalled();
  });

  it("locks, resets the counter, and schedules exactly one email on the fifth wrong password", async () => {
    const { credential } = prismaFixture({ failedAttempts: 4 });
    dependencies.verifyPassword.mockResolvedValue(false);

    await authenticateWithPassword("staff@imsda.org", "wrong", null);

    expect(credential.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { failedAttempts: { increment: 1 } },
    }));
    expect(credential.row.lockedUntil).toBeInstanceOf(Date);
    expect(credential.row.failedAttempts).toBe(0);
    expect(dependencies.scheduleLockoutEmails).toHaveBeenCalledTimes(1);
    expect(dependencies.scheduleLockoutEmails).toHaveBeenCalledWith({
      audience: "STAFF",
      kind: "PASSWORD",
      accountUserId: "user-1",
      lockedUntil: credential.row.lockedUntil,
      now: expect.any(Date),
    });
  });

  it("claims the lock once when two wrong passwords race, and schedules one email", async () => {
    const { stub, credential } = prismaFixture({ failedAttempts: 4 });
    // Both requests read the credential before either writes.
    stub.user.findUnique.mockImplementation(async () => userFixture({ failedAttempts: 4, lockedUntil: null }));
    dependencies.verifyPassword.mockResolvedValue(false);

    await Promise.all([
      authenticateWithPassword("staff@imsda.org", "wrong-1", null),
      authenticateWithPassword("staff@imsda.org", "wrong-2", null),
    ]);

    expect(credential.updateMany).toHaveBeenCalledTimes(2);
    const claims = await Promise.all(credential.updateMany.mock.results.map((result) => result.value));
    expect(claims.map((claim) => claim.count).sort()).toEqual([0, 1]);
    expect(dependencies.scheduleLockoutEmails).toHaveBeenCalledTimes(1);
  });

  it("needs five new wrong passwords to lock again once the lock expires", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(now);
      const { credential } = prismaFixture({ failedAttempts: 4 });
      dependencies.verifyPassword.mockResolvedValue(false);
      await authenticateWithPassword("staff@imsda.org", "wrong", null);
      expect(dependencies.scheduleLockoutEmails).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date(now.getTime() + 16 * 60 * 1000));
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await authenticateWithPassword("staff@imsda.org", "wrong", null);
      }
      expect(credential.row.lockedUntil!.getTime()).toBeLessThan(Date.now());
      expect(dependencies.scheduleLockoutEmails).toHaveBeenCalledTimes(1);

      await authenticateWithPassword("staff@imsda.org", "wrong", null);
      expect(credential.row.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
      expect(dependencies.scheduleLockoutEmails).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends no further email for an attempt made while already locked", async () => {
    const { credential } = prismaFixture({ lockedUntil: new Date(Date.now() + 60_000) });

    await authenticateWithPassword("staff@imsda.org", "wrong-again", null);

    expect(dependencies.scheduleLockoutEmails).not.toHaveBeenCalled();
    expect(credential.update).not.toHaveBeenCalled();
  });
});

describe("wrong two-step code (#456)", () => {
  const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

  function prismaFixture(enrollmentOverrides: {
    lockedUntil?: Date | null;
    failedAttempts?: number;
    status?: "ACTIVE" | "PENDING";
  } = {}) {
    const enrollment = lockableRowStub(enrollmentOverrides);
    const stub = {
      mfaChallenge: {
        findUnique: vi.fn().mockResolvedValue({
          id: "challenge-1",
          userId: "user-1",
          expiresAt: new Date(now.getTime() + 60_000),
          consumedAt: null,
          attempts: 0,
          userAgent: "test",
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      userMfaEnrollment: {
        findUnique: vi.fn().mockResolvedValue({
          id: "enrol-1",
          status: enrollmentOverrides.status ?? "ACTIVE",
          sealedSecret: sealSecret(SECRET, "mfa-totp-secret"),
          lastUsedStep: null,
          lockedUntil: enrollmentOverrides.lockedUntil ?? null,
        }),
        update: enrollment.update,
        updateMany: enrollment.updateMany,
      },
      mfaRecoveryCode: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      authCredential: {
        findUnique: vi.fn().mockResolvedValue({ disabledAt: null, user: { globalRole: null } }),
      },
      $transaction: vi.fn(async (operations: unknown) => (
        Array.isArray(operations) ? Promise.all(operations) : (operations as () => unknown)()
      )),
    };
    dependencies.getPrisma.mockReturnValue(stub);
    return { stub, enrollment };
  }

  it("sends no email on the first two wrong codes, and exactly one on the third", async () => {
    prismaFixture();

    await expect(completeMfaChallenge("token", "000001", { now })).rejects.toMatchObject({ code: "MFA_CODE_INVALID" });
    await expect(completeMfaChallenge("token", "000002", { now })).rejects.toMatchObject({ code: "MFA_CODE_INVALID" });
    expect(dependencies.scheduleLockoutEmails).not.toHaveBeenCalled();

    await expect(completeMfaChallenge("token", "000003", { now })).rejects.toMatchObject({ code: "MFA_CODE_INVALID" });
    expect(dependencies.scheduleLockoutEmails).toHaveBeenCalledTimes(1);
    expect(dependencies.scheduleLockoutEmails).toHaveBeenCalledWith({
      audience: "STAFF",
      kind: "CODE",
      accountUserId: "user-1",
      lockedUntil: expect.any(Date),
      now: expect.any(Date),
    });
  });

  it("sends no further email for an attempt made while already locked", async () => {
    prismaFixture({ lockedUntil: new Date(now.getTime() + 60_000) });

    await expect(completeMfaChallenge("token", totpCode(SECRET, now), { now }))
      .rejects.toMatchObject({ code: "MFA_LOCKED" });

    expect(dependencies.scheduleLockoutEmails).not.toHaveBeenCalled();
  });

  it("claims the lock once when two wrong codes race, and schedules one email", async () => {
    const { enrollment } = prismaFixture({ failedAttempts: 2 });

    await Promise.allSettled([
      completeMfaChallenge("token", "000001", { now }),
      completeMfaChallenge("token", "000002", { now }),
    ]);

    const claims = enrollment.updateMany.mock.calls.filter(([query]) => query.where.failedAttempts);
    expect(claims).toHaveLength(2);
    expect(enrollment.row.lockedUntil).toBeInstanceOf(Date);
    expect(dependencies.scheduleLockoutEmails).toHaveBeenCalledTimes(1);
  });

  it("counts wrong confirmation codes during enrolment toward the lock, without a lockout email", async () => {
    const { enrollment } = prismaFixture({ status: "PENDING" });

    for (const code of ["000001", "000002", "000003"]) {
      await expect(completeMfaChallenge("token", code, { now })).rejects.toMatchObject({ code: "MFA_CODE_INVALID" });
    }

    // The lock still applies — it is only the "someone tried to sign in" email
    // that a typo while setting up an authenticator does not warrant.
    expect(enrollment.row.lockedUntil).toBeInstanceOf(Date);
    expect(dependencies.scheduleLockoutEmails).not.toHaveBeenCalled();
  });
});
