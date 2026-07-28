import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  getServerEnv: vi.fn(),
  writeAuditLog: vi.fn(),
  createDatabaseSession: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@/lib/env", () => ({ getServerEnv: dependencies.getServerEnv }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: dependencies.writeAuditLog }));
vi.mock("@/modules/access/session-store", () => ({
  createDatabaseSession: dependencies.createDatabaseSession,
}));

import { sealSecret } from "@/lib/secret-box";
import {
  MfaError,
  beginMfaEnrollment,
  completeMfaChallenge,
  confirmMfaEnrollment,
  disableMfa,
  issueMfaChallenge,
} from "@/modules/access/mfa-service";
import { hashOpaqueToken } from "@/modules/access/tokens";
import { decodeBase32, totpCode, totpStep } from "@/modules/access/totp";

const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const now = new Date("2026-07-24T12:00:00.000Z");

type Fixture = {
  user?: {
    globalRole?: "SYSTEM_ADMIN" | null;
    memberships?: Array<{ role: string }>;
  };
  enrollment?: {
    id?: string;
    status?: "PENDING" | "ACTIVE";
    secret?: string;
    lastUsedStep?: bigint | null;
    lockedUntil?: Date | null;
  } | null;
  challenge?: {
    userId?: string;
    expiresAt?: Date;
    consumedAt?: Date | null;
    attempts?: number;
  } | null;
  recoveryCodeMatches?: number;
};

function prismaFixture(fixture: Fixture = {}) {
  const enrollment = fixture.enrollment === null ? null : {
    id: fixture.enrollment?.id ?? "enrol-1",
    status: fixture.enrollment?.status ?? "ACTIVE",
    sealedSecret: sealSecret(fixture.enrollment?.secret ?? SECRET, "mfa-totp-secret"),
    lastUsedStep: fixture.enrollment?.lastUsedStep ?? null,
    lockedUntil: fixture.enrollment?.lockedUntil ?? null,
    confirmedAt: null,
    lastVerifiedAt: null,
    _count: { recoveryCodes: 7 },
  };

  const state = {
    enrollmentUpdates: [] as Array<Record<string, unknown>>,
    enrollmentUpserts: [] as Array<Record<string, unknown>>,
    createdChallenges: [] as Array<Record<string, unknown>>,
    challengeUpdates: [] as Array<Record<string, unknown>>,
    recoveryCodeCreates: [] as Array<Record<string, unknown>>,
    deletedEnrollments: [] as string[],
    updateManyEnrollmentCount: 1,
  };

  const prisma = {
    user: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: "user-1",
        email: "alex@imsda.org",
        displayName: "Alex Staff",
        globalRole: fixture.user?.globalRole ?? null,
        memberships: fixture.user?.memberships ?? [],
        mfaEnrollment: enrollment ? { id: enrollment.id, status: enrollment.status } : null,
      })),
    },
    userMfaEnrollment: {
      findUnique: vi.fn(async () => enrollment),
      upsert: vi.fn(async (query: Record<string, unknown>) => {
        state.enrollmentUpserts.push(query);
        return { id: "enrol-1" };
      }),
      update: vi.fn(async (query: { data: Record<string, unknown> }) => {
        state.enrollmentUpdates.push(query.data);
        return { failedAttempts: 1 };
      }),
      updateMany: vi.fn(async (query: { data: Record<string, unknown> }) => {
        state.enrollmentUpdates.push(query.data);
        return { count: state.updateManyEnrollmentCount };
      }),
      delete: vi.fn(async (query: { where: { id: string } }) => {
        state.deletedEnrollments.push(query.where.id);
        return {};
      }),
    },
    mfaRecoveryCode: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async (query: { data: Array<Record<string, unknown>> }) => {
        state.recoveryCodeCreates.push(...query.data);
        return { count: query.data.length };
      }),
      updateMany: vi.fn(async () => ({ count: fixture.recoveryCodeMatches ?? 0 })),
      count: vi.fn(async () => 6),
    },
    // Re-read immediately before a session is minted, so a disable landing
    // mid-sign-in cannot produce a session that works once re-enabled.
    authCredential: { findUnique: vi.fn().mockResolvedValue({ disabledAt: null }) },
    mfaChallenge: {
      create: vi.fn(async (query: Record<string, unknown>) => {
        state.createdChallenges.push(query);
        return { id: "challenge-1" };
      }),
      findUnique: vi.fn(async () => (fixture.challenge === null ? null : {
        id: "challenge-1",
        userId: fixture.challenge?.userId ?? "user-1",
        expiresAt: fixture.challenge?.expiresAt ?? new Date(now.getTime() + 60_000),
        consumedAt: fixture.challenge?.consumedAt ?? null,
        attempts: fixture.challenge?.attempts ?? 0,
        userAgent: "Test Agent",
      })),
      update: vi.fn(async (query: { data: Record<string, unknown> }) => {
        state.challengeUpdates.push(query.data);
        return {};
      }),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    $transaction: vi.fn(async (operations: unknown) => (
      Array.isArray(operations) ? Promise.all(operations) : (operations as () => unknown)()
    )),
  };

  dependencies.getPrisma.mockReturnValue(prisma);
  return { prisma, state };
}

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.getServerEnv.mockReturnValue({
    APP_BASE_URL: "https://events.imsda.org",
    SECRET_ENCRYPTION_KEY: "an-encryption-key-long-enough-for-tests",
  });
  dependencies.createDatabaseSession.mockResolvedValue({
    token: "session-token",
    expiresAt: new Date(now.getTime() + 8 * 60 * 60 * 1000),
  });
});

describe("enrolment", () => {
  it("stores the secret sealed, and only offers the plaintext once", async () => {
    const { state } = prismaFixture({ enrollment: null });

    const offer = await beginMfaEnrollment("user-1");

    expect(decodeBase32(offer.secret)).toHaveLength(20);
    expect(offer.otpauthUri).toContain("otpauth://totp/");
    const written = state.enrollmentUpserts[0] as {
      create: { sealedSecret: string; status: string };
    };
    expect(written.create.status).toBe("PENDING");
    expect(written.create.sealedSecret).not.toContain(offer.secret);
    expect(written.create.sealedSecret.startsWith("v1.")).toBe(true);
  });

  it("will not replace an authenticator that is already in use", async () => {
    prismaFixture({ enrollment: { status: "ACTIVE" } });

    await expect(beginMfaEnrollment("user-1")).rejects.toMatchObject({
      code: "MFA_ALREADY_ACTIVE",
    });
  });

  it("activates only on a code from the real secret, and issues recovery codes", async () => {
    const { state } = prismaFixture({ enrollment: { status: "PENDING" } });

    const confirmed = await confirmMfaEnrollment("user-1", totpCode(SECRET, now), { now });

    expect(confirmed.recoveryCodes).toHaveLength(10);
    expect(confirmed.recoveryCodes[0]).toMatch(/^\d{5}-\d{5}$/);
    // Stored as digests, exactly like a session token.
    for (const [index, stored] of state.recoveryCodeCreates.entries()) {
      expect(stored.codeHash).toBe(hashOpaqueToken(confirmed.recoveryCodes[index]));
    }
    expect(state.enrollmentUpdates[0]).toMatchObject({
      status: "ACTIVE",
      lastUsedStep: BigInt(totpStep(now)),
    });
  });

  it("refuses a wrong code", async () => {
    prismaFixture({ enrollment: { status: "PENDING" } });

    await expect(confirmMfaEnrollment("user-1", "000000", { now }))
      .rejects.toMatchObject({ code: "MFA_CODE_INVALID" });
  });
});

describe("the sign-in challenge", () => {
  it("stores only a digest of the challenge token", async () => {
    const { state } = prismaFixture();

    const issued = await issueMfaChallenge("user-1", "challenge", { now });

    const created = state.createdChallenges[0] as { data: { tokenHash: string } };
    expect(created.data.tokenHash).toBe(hashOpaqueToken(issued.challengeToken));
    expect(JSON.stringify(created)).not.toContain(issued.challengeToken);
  });

  it("issues a session only after a valid code", async () => {
    prismaFixture();

    const result = await completeMfaChallenge("token", totpCode(SECRET, now), { now });

    expect(result.session.token).toBe("session-token");
    expect(dependencies.createDatabaseSession).toHaveBeenCalledOnce();
  });

  it("issues no session when the account was disabled mid-sign-in", async () => {
    const { prisma } = prismaFixture();
    // The code is correct and the challenge was already read and verified. An
    // administrator disabled the account in between. Without the re-read the
    // session is merely inert — refused while disabled, and usable the moment
    // somebody re-enables the account, with no password entered again.
    prisma.authCredential.findUnique.mockResolvedValue({ disabledAt: new Date() });

    await expect(completeMfaChallenge("token", totpCode(SECRET, now), { now }))
      .rejects.toMatchObject({ code: "MFA_CHALLENGE_INVALID" });
    expect(dependencies.createDatabaseSession).not.toHaveBeenCalled();
  });

  it("issues no session when the account has no credential at all", async () => {
    const { prisma } = prismaFixture();
    prisma.authCredential.findUnique.mockResolvedValue(null);

    await expect(completeMfaChallenge("token", totpCode(SECRET, now), { now }))
      .rejects.toMatchObject({ code: "MFA_CHALLENGE_INVALID" });
    expect(dependencies.createDatabaseSession).not.toHaveBeenCalled();
  });

  it("issues no session for a wrong code", async () => {
    prismaFixture();

    await expect(completeMfaChallenge("token", "000000", { now }))
      .rejects.toMatchObject({ code: "MFA_CODE_INVALID" });
    expect(dependencies.createDatabaseSession).not.toHaveBeenCalled();
  });

  it("refuses a code whose step has already been spent", async () => {
    prismaFixture({ enrollment: { lastUsedStep: BigInt(totpStep(now)) } });

    await expect(completeMfaChallenge("token", totpCode(SECRET, now), { now }))
      .rejects.toMatchObject({ code: "MFA_CODE_INVALID" });
    expect(dependencies.createDatabaseSession).not.toHaveBeenCalled();
  });

  it("accepts an unused recovery code and records that it was spent", async () => {
    prismaFixture({ recoveryCodeMatches: 1 });

    const result = await completeMfaChallenge("token", "12345-67890", { now });

    expect(result.usedRecoveryCode).toBe(true);
    expect(dependencies.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "MFA_RECOVERY_CODE_USED",
    }));
  });

  it("rejects an expired, consumed, or over-attempted challenge identically", async () => {
    for (const challenge of [
      { expiresAt: new Date(now.getTime() - 1) },
      { consumedAt: now },
      { attempts: 5 },
    ]) {
      prismaFixture({ challenge });
      await expect(completeMfaChallenge("token", totpCode(SECRET, now), { now }))
        .rejects.toMatchObject({ code: "MFA_CHALLENGE_INVALID" });
    }
    prismaFixture({ challenge: null });
    await expect(completeMfaChallenge("token", totpCode(SECRET, now), { now }))
      .rejects.toMatchObject({ code: "MFA_CHALLENGE_INVALID" });
  });

  it("refuses while locked out after repeated wrong codes", async () => {
    prismaFixture({ enrollment: { lockedUntil: new Date(now.getTime() + 60_000) } });

    await expect(completeMfaChallenge("token", totpCode(SECRET, now), { now }))
      .rejects.toMatchObject({ code: "MFA_LOCKED" });
  });

  it("signs in and confirms in one step when the challenge is an enrolment", async () => {
    const { state } = prismaFixture({ enrollment: { status: "PENDING" } });

    const result = await completeMfaChallenge("token", totpCode(SECRET, now), { now });

    expect(result.recoveryCodes).toHaveLength(10);
    expect(result.session.token).toBe("session-token");
    expect(state.enrollmentUpdates[0]).toMatchObject({ status: "ACTIVE" });
  });
});

describe("removing a second factor", () => {
  it("is refused for an account whose role requires one", async () => {
    prismaFixture({ user: { globalRole: "SYSTEM_ADMIN" } });

    await expect(disableMfa("user-1", totpCode(SECRET, now), { now }))
      .rejects.toMatchObject({ code: "MFA_REQUIRED_BY_ROLE" });

    prismaFixture({ user: { memberships: [{ role: "EVENT_ADMIN" }] } });
    await expect(disableMfa("user-1", totpCode(SECRET, now), { now }))
      .rejects.toBeInstanceOf(MfaError);
  });

  it("removes it for an account that is not obliged to have one", async () => {
    const { state } = prismaFixture({ user: { memberships: [{ role: "CHECK_IN_STAFF" }] } });

    await disableMfa("user-1", totpCode(SECRET, now), { now });

    expect(state.deletedEnrollments).toEqual(["enrol-1"]);
    expect(dependencies.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "MFA_DISABLED",
    }));
  });

  it("will not remove it on a wrong code", async () => {
    const { state } = prismaFixture({ user: { memberships: [{ role: "CHECK_IN_STAFF" }] } });

    await expect(disableMfa("user-1", "000000", { now }))
      .rejects.toMatchObject({ code: "MFA_CODE_INVALID" });
    expect(state.deletedEnrollments).toEqual([]);
  });
});
