import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Sign-in security policy (#456): a session is never created for a staff
 * account that must carry a second factor until that factor is presented —
 * `authenticateWithPassword` returns an `"mfa"` gate, never `"session"`, for
 * every ACTIVE-membership role, not only EVENT_ADMIN and SYSTEM_ADMIN.
 */

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  verifyPassword: vi.fn(),
  spendPasswordCheck: vi.fn(),
  createDatabaseSession: vi.fn(),
  scheduleLockoutEmails: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@/modules/access/passwords", () => ({
  hashPassword: vi.fn(),
  verifyPassword: dependencies.verifyPassword,
  spendPasswordCheck: dependencies.spendPasswordCheck,
}));
vi.mock("@/modules/access/session-store", () => ({
  createDatabaseSession: dependencies.createDatabaseSession,
}));
vi.mock("@/modules/communications/lockout-email", () => ({
  scheduleLockoutEmails: dependencies.scheduleLockoutEmails,
}));

import { authenticateWithPassword } from "@/modules/access/auth-service";

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.verifyPassword.mockResolvedValue(true);
  dependencies.createDatabaseSession.mockResolvedValue({
    token: "session-token",
    expiresAt: new Date("2030-01-01T00:00:00Z"),
  });
});

function credentialFixture(user: {
  globalRole: "SYSTEM_ADMIN" | null;
  memberships: Array<{ role: string }>;
  mfaEnrollment: { status: "PENDING" | "ACTIVE" } | null;
}) {
  const prisma = {
    user: {
      findUnique: vi.fn().mockResolvedValue({
        id: "user-1",
        accountStatus: "ACTIVE",
        globalRole: user.globalRole,
        memberships: user.memberships,
        mfaEnrollment: user.mfaEnrollment,
        passkeys: [],
        credential: {
          id: "cred-1",
          passwordHash: "hash",
          failedAttempts: 0,
          lockedUntil: null,
          disabledAt: null,
        },
      }),
    },
    authCredential: { update: vi.fn().mockResolvedValue({}) },
  };
  dependencies.getPrisma.mockReturnValue(prisma);
  return prisma;
}

const cases: Array<[string, { globalRole: "SYSTEM_ADMIN" | null; memberships: Array<{ role: string }> }]> = [
  ["EVENT_ADMIN", { globalRole: null, memberships: [{ role: "EVENT_ADMIN" }] }],
  ["another event role (READ_ONLY_STAFF)", { globalRole: null, memberships: [{ role: "READ_ONLY_STAFF" }] }],
  ["SYSTEM_ADMIN", { globalRole: "SYSTEM_ADMIN", memberships: [] }],
];

describe.each(cases)("a correct password for %s", (_label, user) => {
  it("does not create a session before a second factor is presented", async () => {
    credentialFixture({ ...user, mfaEnrollment: null });

    const result = await authenticateWithPassword("staff@imsda.org", "correct password", null);

    expect(result?.outcome).not.toBe("session");
    expect(dependencies.createDatabaseSession).not.toHaveBeenCalled();
  });
});

describe("a correct password for a staff account with no active membership", () => {
  it("signs in on the password alone", async () => {
    credentialFixture({ globalRole: null, memberships: [], mfaEnrollment: null });

    const result = await authenticateWithPassword("staff@imsda.org", "correct password", null);

    expect(result?.outcome).toBe("session");
    expect(dependencies.createDatabaseSession).toHaveBeenCalledOnce();
  });
});
