import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));

import {
  authenticateWithPassword,
  describeAccountToken,
  issueAccountToken,
  resetPassword,
} from "@/modules/access/auth-service";
import { hashPassword } from "@/modules/access/passwords";
import { hashOpaqueToken } from "@/modules/access/tokens";

const knownPassword = "correct-horse-battery-staple";

function prismaFixture(overrides: {
  user?: Record<string, unknown> | null;
  resetToken?: Record<string, unknown> | null;
  activePasskeys?: number;
} = {}) {
  const tx = {
    passwordResetToken: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi.fn().mockResolvedValue({}),
    },
    authCredential: { update: vi.fn().mockResolvedValue({}) },
    user: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    userSession: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    userPasskey: { updateMany: vi.fn().mockResolvedValue({ count: overrides.activePasskeys ?? 0 }) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    user: {
      findUnique: vi.fn().mockResolvedValue(overrides.user ?? null),
    },
    authCredential: { update: vi.fn().mockResolvedValue({}) },
    passwordResetToken: {
      findUnique: vi.fn().mockResolvedValue(overrides.resetToken ?? null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi.fn().mockResolvedValue({}),
    },
    userSession: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(async (argument: unknown) =>
      typeof argument === "function"
        ? (argument as (client: typeof tx) => unknown)(tx)
        : Promise.all(argument as unknown[])),
  };
  dependencies.getPrisma.mockReturnValue(prisma);
  return { prisma, tx };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("password sign-in for an admin whose second factor is a passkey (#429)", () => {
  it("won't finish sign-in or offer authenticator enrolment on the password alone", async () => {
    const passwordHash = await hashPassword(knownPassword);
    const { prisma } = prismaFixture({
      user: {
        id: "user-1",
        accountStatus: "ACTIVE",
        globalRole: "SYSTEM_ADMIN",
        memberships: [],
        mfaEnrollment: null,
        passkeys: [{ id: "pk-1" }],
        credential: { id: "cred-1", passwordHash, failedAttempts: 0, lockedUntil: null, disabledAt: null },
      },
    });

    expect(await authenticateWithPassword("admin@imsda.org", knownPassword, null))
      .toEqual({ outcome: "passkey_required", userId: "user-1" });
    expect(prisma.userSession.create).not.toHaveBeenCalled();
  });

  it("still asks an admin with no second factor at all to enrol one", async () => {
    const passwordHash = await hashPassword(knownPassword);
    prismaFixture({
      user: {
        id: "user-1",
        accountStatus: "ACTIVE",
        globalRole: "SYSTEM_ADMIN",
        memberships: [],
        mfaEnrollment: null,
        passkeys: [],
        credential: { id: "cred-1", passwordHash, failedAttempts: 0, lockedUntil: null, disabledAt: null },
      },
    });

    expect(await authenticateWithPassword("admin@imsda.org", knownPassword, null))
      .toEqual({ outcome: "mfa", userId: "user-1", gate: "enrol" });
  });
});

describe("invited accounts stay pending until activated", () => {
  it("refuses sign-in for a pending account even with the right password", async () => {
    const passwordHash = await hashPassword(knownPassword);
    prismaFixture({
      user: {
        id: "user-1",
        accountStatus: "PENDING_ACTIVATION",
        credential: {
          id: "cred-1",
          passwordHash,
          failedAttempts: 0,
          lockedUntil: null,
          disabledAt: null,
        },
      },
    });

    expect(await authenticateWithPassword("new@imsda.org", knownPassword, null)).toBeNull();
  });

  it("admits the same account once it is active", async () => {
    const passwordHash = await hashPassword(knownPassword);
    const { prisma } = prismaFixture({
      user: {
        id: "user-1",
        accountStatus: "ACTIVE",
        globalRole: null,
        memberships: [],
        mfaEnrollment: null,
        credential: {
          id: "cred-1",
          passwordHash,
          failedAttempts: 0,
          lockedUntil: null,
          disabledAt: null,
        },
      },
    });

    const authentication = await authenticateWithPassword("staff@imsda.org", knownPassword, null);
    expect(authentication).toMatchObject({
      outcome: "session",
      session: { token: expect.any(String) },
    });
    expect(prisma.userSession.create).toHaveBeenCalledOnce();
  });
});

describe("account token issuance", () => {
  it("issues a seven-day activation token for a pending account", async () => {
    const now = new Date("2026-07-24T12:00:00.000Z");
    const { prisma } = prismaFixture({
      user: { id: "user-1", accountStatus: "PENDING_ACTIVATION", credential: { disabledAt: null } },
    });

    const issued = await issueAccountToken("new@imsda.org", { now });

    expect(issued?.purpose).toBe("ACCOUNT_ACTIVATION");
    expect(issued?.expiresAt.toISOString()).toBe("2026-07-31T12:00:00.000Z");
    expect(prisma.passwordResetToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        purpose: "ACCOUNT_ACTIVATION",
        tokenHash: hashOpaqueToken(issued!.token),
      }),
    });
  });

  it("issues a thirty-minute reset token for an active account", async () => {
    const now = new Date("2026-07-24T12:00:00.000Z");
    prismaFixture({
      user: { id: "user-1", accountStatus: "ACTIVE", credential: { disabledAt: null } },
    });

    const issued = await issueAccountToken("staff@imsda.org", { now });

    expect(issued?.purpose).toBe("PASSWORD_RESET");
    expect(issued?.expiresAt.toISOString()).toBe("2026-07-24T12:30:00.000Z");
  });

  it("stores only the digest, never the token itself", async () => {
    const { prisma } = prismaFixture({
      user: { id: "user-1", accountStatus: "ACTIVE", credential: { disabledAt: null } },
    });

    const issued = await issueAccountToken("staff@imsda.org");
    const stored = prisma.passwordResetToken.create.mock.calls[0][0].data;

    expect(stored.tokenHash).not.toBe(issued!.token);
    expect(JSON.stringify(stored)).not.toContain(issued!.token);
  });

  it("consumes any outstanding link so only one is ever live", async () => {
    const { prisma } = prismaFixture({
      user: { id: "user-1", accountStatus: "ACTIVE", credential: { disabledAt: null } },
    });

    await issueAccountToken("staff@imsda.org");

    expect(prisma.passwordResetToken.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", usedAt: null },
      data: { usedAt: expect.any(Date) },
    });
  });

  it("issues nothing for an unknown or disabled account", async () => {
    prismaFixture({ user: null });
    expect(await issueAccountToken("nobody@imsda.org")).toBeNull();

    prismaFixture({
      user: { id: "user-1", accountStatus: "ACTIVE", credential: { disabledAt: new Date() } },
    });
    expect(await issueAccountToken("disabled@imsda.org")).toBeNull();
  });
});

describe("completing a token activates the account", () => {
  it("marks a pending account active and revokes its sessions", async () => {
    const { tx } = prismaFixture({
      resetToken: {
        id: "tok-1",
        userId: "user-1",
        purpose: "ACCOUNT_ACTIVATION",
        expiresAt: new Date(Date.now() + 60_000),
        usedAt: null,
      },
    });

    expect(await resetPassword("raw-token", knownPassword)).toBe(true);
    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: "user-1", accountStatus: "PENDING_ACTIVATION" },
      data: { accountStatus: "ACTIVE", activatedAt: expect.any(Date) },
    });
    expect(tx.userSession.updateMany).toHaveBeenCalledOnce();
  });

  it("revokes every staff passkey on a password reset, and audits the count (#453)", async () => {
    const { tx } = prismaFixture({
      resetToken: {
        id: "tok-1",
        userId: "user-1",
        purpose: "PASSWORD_RESET",
        expiresAt: new Date(Date.now() + 60_000),
        usedAt: null,
      },
      activePasskeys: 2,
    });

    expect(await resetPassword("raw-token", knownPassword)).toBe(true);
    expect(tx.userPasskey.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: "user-1",
        action: "USER_PASSKEYS_REVOKED_ON_PASSWORD_RESET",
        entityType: "User",
        entityId: "user-1",
        summary: "Password reset revoked 2 staff passkeys.",
        metadata: { passkeysRevoked: 2 },
      }),
    });
  });

  it("revokes nothing when the token was already claimed", async () => {
    const { tx } = prismaFixture({
      resetToken: {
        id: "tok-1",
        userId: "user-1",
        purpose: "PASSWORD_RESET",
        expiresAt: new Date(Date.now() + 60_000),
        usedAt: null,
      },
      activePasskeys: 1,
    });
    tx.passwordResetToken.updateMany.mockResolvedValueOnce({ count: 0 });

    expect(await resetPassword("raw-token", knownPassword)).toBe(false);
    expect(tx.userPasskey.updateMany).not.toHaveBeenCalled();
  });

  it("writes no passkey audit entry when there were none to revoke", async () => {
    const { tx } = prismaFixture({
      resetToken: {
        id: "tok-1",
        userId: "user-1",
        purpose: "PASSWORD_RESET",
        expiresAt: new Date(Date.now() + 60_000),
        usedAt: null,
      },
    });

    expect(await resetPassword("raw-token", knownPassword)).toBe(true);
    expect(tx.userPasskey.updateMany).toHaveBeenCalledOnce();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("rejects an expired or already-used token", async () => {
    prismaFixture({
      resetToken: {
        id: "tok-1",
        userId: "user-1",
        purpose: "ACCOUNT_ACTIVATION",
        expiresAt: new Date(Date.now() - 60_000),
        usedAt: null,
      },
    });
    expect(await resetPassword("raw-token", knownPassword)).toBe(false);

    prismaFixture({
      resetToken: {
        id: "tok-1",
        userId: "user-1",
        purpose: "PASSWORD_RESET",
        expiresAt: new Date(Date.now() + 60_000),
        usedAt: new Date(),
      },
    });
    expect(await resetPassword("raw-token", knownPassword)).toBe(false);
  });
});

describe("describing a token for the page that consumes it", () => {
  it("reports the purpose of a live token, and its owner for the policy check", async () => {
    prismaFixture({
      resetToken: {
        purpose: "ACCOUNT_ACTIVATION",
        expiresAt: new Date(Date.now() + 60_000),
        usedAt: null,
        user: { email: "alex@imsda.org", displayName: "Alex Staff" },
      },
    });

    // The owner is server-side only: the password policy rejects a password
    // containing the account holder's own name or address, which it cannot do
    // without knowing them. The page that consumes a token reads purpose alone.
    expect(await describeAccountToken("raw-token")).toEqual({
      purpose: "ACCOUNT_ACTIVATION",
      owner: { email: "alex@imsda.org", displayName: "Alex Staff" },
    });
  });

  it("treats unknown, used, and expired tokens identically", async () => {
    prismaFixture({ resetToken: null });
    expect(await describeAccountToken("raw-token")).toBeNull();

    prismaFixture({
      resetToken: { purpose: "PASSWORD_RESET", expiresAt: new Date(Date.now() - 1), usedAt: null },
    });
    expect(await describeAccountToken("raw-token")).toBeNull();
  });
});
