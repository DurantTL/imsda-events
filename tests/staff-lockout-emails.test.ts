import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Staff sign-in security policy (#456): the lockout email is dispatched only
 * on the attempt that crosses into locked — never on the attempts before it,
 * and never again while the account stays locked. `dispatchLockoutEmails`
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
  dispatchLockoutEmails: vi.fn(),
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
  dispatchLockoutEmails: dependencies.dispatchLockoutEmails,
}));

import { authenticateWithPassword } from "@/modules/access/auth-service";
import { completeMfaChallenge } from "@/modules/access/mfa-service";
import { sealSecret } from "@/lib/secret-box";
import { totpCode } from "@/modules/access/totp";

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
  function userFixture(failedAttempts: number, lockedUntil: Date | null = null) {
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
        failedAttempts,
        lockedUntil,
        disabledAt: null,
      },
    };
  }

  function prismaFixture() {
    const stub = {
      user: { findUnique: vi.fn() },
      authCredential: { update: vi.fn().mockResolvedValue({}) },
    };
    dependencies.getPrisma.mockReturnValue(stub);
    return stub;
  }

  it("sends no email on the first four wrong passwords", async () => {
    const prisma = prismaFixture();
    dependencies.verifyPassword.mockResolvedValue(false);
    for (let failedAttempts = 0; failedAttempts < 4; failedAttempts += 1) {
      prisma.user.findUnique.mockResolvedValueOnce(userFixture(failedAttempts));
      await authenticateWithPassword("staff@imsda.org", "wrong", null);
    }
    expect(dependencies.dispatchLockoutEmails).not.toHaveBeenCalled();
  });

  it("sends exactly one email on the fifth wrong password", async () => {
    const prisma = prismaFixture();
    dependencies.verifyPassword.mockResolvedValue(false);
    prisma.user.findUnique.mockResolvedValueOnce(userFixture(4));

    await authenticateWithPassword("staff@imsda.org", "wrong", null);

    expect(dependencies.dispatchLockoutEmails).toHaveBeenCalledTimes(1);
    expect(dependencies.dispatchLockoutEmails).toHaveBeenCalledWith({
      audience: "STAFF",
      kind: "PASSWORD",
      accountUserId: "user-1",
      lockedUntil: expect.any(Date),
      now: expect.any(Date),
    });
  });

  it("sends no further email for an attempt made while already locked", async () => {
    const prisma = prismaFixture();
    prisma.user.findUnique.mockResolvedValueOnce(userFixture(0, new Date(now.getTime() + 60_000)));

    await authenticateWithPassword("staff@imsda.org", "wrong-again", null);

    expect(dependencies.dispatchLockoutEmails).not.toHaveBeenCalled();
    expect(prisma.authCredential.update).not.toHaveBeenCalled();
  });
});

describe("wrong two-step code (#456)", () => {
  const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

  function prismaFixture(enrollmentOverrides: { lockedUntil?: Date | null } = {}) {
    let failedAttempts = 0;
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
          status: "ACTIVE",
          sealedSecret: sealSecret(SECRET, "mfa-totp-secret"),
          lastUsedStep: null,
          lockedUntil: enrollmentOverrides.lockedUntil ?? null,
        }),
        // The real service makes two calls once the threshold is crossed: one
        // that increments, one that sets lockedUntil and resets the counter.
        // A relational `increment` op is what distinguishes the first from the
        // second, exactly as Prisma's own update input does.
        update: vi.fn(async (query: { data: Record<string, unknown> }) => {
          const increment = query.data.failedAttempts as { increment?: number } | undefined;
          if (increment && typeof increment === "object" && "increment" in increment) {
            failedAttempts += 1;
            return { failedAttempts };
          }
          return {};
        }),
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
    return stub;
  }

  it("sends no email on the first two wrong codes, and exactly one on the third", async () => {
    prismaFixture();

    await expect(completeMfaChallenge("token", "000001", { now })).rejects.toMatchObject({ code: "MFA_CODE_INVALID" });
    await expect(completeMfaChallenge("token", "000002", { now })).rejects.toMatchObject({ code: "MFA_CODE_INVALID" });
    expect(dependencies.dispatchLockoutEmails).not.toHaveBeenCalled();

    await expect(completeMfaChallenge("token", "000003", { now })).rejects.toMatchObject({ code: "MFA_CODE_INVALID" });
    expect(dependencies.dispatchLockoutEmails).toHaveBeenCalledTimes(1);
    expect(dependencies.dispatchLockoutEmails).toHaveBeenCalledWith({
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

    expect(dependencies.dispatchLockoutEmails).not.toHaveBeenCalled();
  });
});
