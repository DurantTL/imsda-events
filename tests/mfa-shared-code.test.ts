import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  getServerEnv: vi.fn(),
  writeAuditLog: vi.fn(),
  createDatabaseSession: vi.fn(),
  scheduleLockoutEmails: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@/lib/env", () => ({ getServerEnv: dependencies.getServerEnv }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: dependencies.writeAuditLog }));
vi.mock("@/modules/communications/lockout-email", () => ({ scheduleLockoutEmails: dependencies.scheduleLockoutEmails }));
vi.mock("@/modules/access/session-store", () => ({ createDatabaseSession: dependencies.createDatabaseSession }));

import { sealSecret } from "@/lib/secret-box";
import { completeMfaChallenge } from "@/modules/access/mfa-service";
import { hashOpaqueToken } from "@/modules/access/tokens";
import { totpCodeForStep, totpStep } from "@/modules/access/totp";

const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const t0 = new Date("2026-10-09T14:00:10.000Z");
const step0 = totpStep(t0);
const atStep = (step: number) => new Date((step * 30 + 10) * 1000);

/** A small in-memory stand-in that applies the conditions the service writes. */
function world() {
  const enrollment = {
    id: "enrol-1",
    status: "ACTIVE" as const,
    sealedSecret: sealSecret(SECRET, "mfa-totp-secret"),
    lastUsedStep: null as bigint | null,
    lockedUntil: null as Date | null,
    failedAttempts: 0,
    updatedAt: new Date(0),
  };
  const challenges = new Map<string, { id: string; userId: string; expiresAt: Date; consumedAt: Date | null; attempts: number; userAgent: string | null }>();
  for (const name of ["a", "b", "c", "d"]) {
    challenges.set(hashOpaqueToken(`token-${name}`), { id: `challenge-${name}`, userId: "user-1", expiresAt: new Date(t0.getTime() + 600_000), consumedAt: null, attempts: 0, userAgent: null });
  }
  const noLiveLock = (now: Date) => enrollment.lockedUntil === null || enrollment.lockedUntil <= now;
  const prisma = {
    mfaChallenge: {
      findUnique: vi.fn(async ({ where }: { where: { tokenHash: string } }) => challenges.get(where.tokenHash) ?? null),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { attempts?: { increment: number }; consumedAt?: Date } }) => {
        const challenge = [...challenges.values()].find((entry) => entry.id === where.id)!;
        if (data.attempts) challenge.attempts += data.attempts.increment;
        if (data.consumedAt) challenge.consumedAt = data.consumedAt;
        return challenge;
      }),
    },
    userMfaEnrollment: {
      findUnique: vi.fn(async () => ({ ...enrollment })),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const now = currentNow;
        const attempts = where.failedAttempts as { lt?: number; gt?: number; gte?: number } | undefined;
        if (attempts?.lt !== undefined && !(enrollment.failedAttempts < attempts.lt)) return { count: 0 };
        if (attempts?.gt !== undefined && !(enrollment.failedAttempts > attempts.gt)) return { count: 0 };
        if (attempts?.gte !== undefined && !(enrollment.failedAttempts >= attempts.gte)) return { count: 0 };
        if (Array.isArray(where.OR)) {
          const spentGuard = (where.OR as Array<Record<string, unknown>>).some((clause) => "lastUsedStep" in clause);
          if (spentGuard) {
            const ok = enrollment.lastUsedStep === null || enrollment.lastUsedStep < ((where.OR as Array<{ lastUsedStep: { lt?: bigint } | null }>)[1].lastUsedStep!.lt as bigint);
            if (!ok) return { count: 0 };
          } else if (!noLiveLock(now)) {
            return { count: 0 };
          }
        }
        if (where.updatedAt) return { count: 0 };
        for (const [field, value] of Object.entries(data)) {
          if (value && typeof value === "object" && "increment" in value) enrollment.failedAttempts += (value as { increment: number }).increment;
          else if (value && typeof value === "object" && "decrement" in value) enrollment.failedAttempts -= (value as { decrement: number }).decrement;
          else (enrollment as Record<string, unknown>)[field] = value;
        }
        return { count: 1 };
      }),
    },
    mfaRecoveryCode: { updateMany: vi.fn(async () => ({ count: 0 })) },
    authCredential: { findUnique: vi.fn(async () => ({ disabledAt: null, user: { globalRole: null } })) },
  };
  dependencies.getPrisma.mockReturnValue(prisma);
  return { enrollment, challenges };
}

let currentNow = t0;
async function signIn(name: string, code: string, at: Date) {
  currentNow = at;
  return completeMfaChallenge(`token-${name}`, code, { now: at });
}

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.getServerEnv.mockReturnValue({
    APP_BASE_URL: "https://events.imsda.org",
    SECRET_ENCRYPTION_KEY: "an-encryption-key-long-enough-for-tests",
  });
  dependencies.createDatabaseSession.mockResolvedValue({ token: "session-token", expiresAt: new Date(t0.getTime() + 8 * 3_600_000) });
});

describe("devices sharing one authenticator code (#825)", () => {
  it("four challenges, one code in one step: one signs in, three are told to wait, nothing locks", async () => {
    const { enrollment, challenges } = world();
    const shared = totpCodeForStep(SECRET, step0);

    await expect(signIn("a", shared, t0)).resolves.toMatchObject({ userId: "user-1" });
    for (const name of ["b", "c", "d"]) {
      await expect(signIn(name, shared, t0)).rejects.toMatchObject({
        code: "MFA_CODE_ALREADY_USED",
        message: "That code was just used on another device. Wait for the next code, then enter it.",
      });
    }

    expect(enrollment.lockedUntil).toBeNull();
    expect(enrollment.failedAttempts).toBe(0);
    expect(dependencies.scheduleLockoutEmails).not.toHaveBeenCalled();
    // The waiting devices' challenges stay live.
    for (const name of ["b", "c", "d"]) expect(challenges.get(hashOpaqueToken(`token-${name}`))!.consumedAt).toBeNull();
    expect(dependencies.createDatabaseSession).toHaveBeenCalledTimes(1);
  });

  it("then each waiting device signs in with the next step's code", async () => {
    const { enrollment } = world();
    await signIn("a", totpCodeForStep(SECRET, step0), t0);
    for (const name of ["b", "c", "d"]) {
      await expect(signIn(name, totpCodeForStep(SECRET, step0), t0)).rejects.toMatchObject({ code: "MFA_CODE_ALREADY_USED" });
    }

    await expect(signIn("b", totpCodeForStep(SECRET, step0 + 1), atStep(step0 + 1))).resolves.toBeDefined();
    // Another device entering the same next code still just waits.
    await expect(signIn("c", totpCodeForStep(SECRET, step0 + 1), atStep(step0 + 1))).rejects.toMatchObject({ code: "MFA_CODE_ALREADY_USED" });
    await expect(signIn("c", totpCodeForStep(SECRET, step0 + 2), atStep(step0 + 2))).resolves.toBeDefined();
    await expect(signIn("d", totpCodeForStep(SECRET, step0 + 3), atStep(step0 + 3))).resolves.toBeDefined();

    expect(dependencies.createDatabaseSession).toHaveBeenCalledTimes(4);
    expect(enrollment.lockedUntil).toBeNull();
    expect(enrollment.failedAttempts).toBe(0);
  });

  it("a code from a spent adjacent step is also just 'already used'", async () => {
    const { enrollment } = world();
    await signIn("a", totpCodeForStep(SECRET, step0 + 1), t0);
    await expect(signIn("b", totpCodeForStep(SECRET, step0), t0)).rejects.toMatchObject({ code: "MFA_CODE_ALREADY_USED" });
    expect(enrollment.failedAttempts).toBe(0);
  });

  it("wrong codes still count and still lock after 3", async () => {
    const { enrollment } = world();
    const wrong = totpCodeForStep(SECRET, step0 + 40);

    await expect(signIn("a", wrong, t0)).rejects.toMatchObject({ code: "MFA_CODE_INVALID" });
    await expect(signIn("b", wrong, t0)).rejects.toMatchObject({ code: "MFA_CODE_INVALID" });
    expect(enrollment.failedAttempts).toBe(2);
    await expect(signIn("c", wrong, t0)).rejects.toMatchObject({ code: "MFA_CODE_INVALID" });

    expect(enrollment.lockedUntil).not.toBeNull();
    expect(dependencies.scheduleLockoutEmails).toHaveBeenCalledTimes(1);
    await expect(signIn("d", totpCodeForStep(SECRET, step0), t0)).rejects.toMatchObject({ code: "MFA_LOCKED" });
  });

  it("a spent-code answer gives a guesser nothing back: it never resets or advances the count", async () => {
    const { enrollment } = world();
    await signIn("a", totpCodeForStep(SECRET, step0), t0);
    await expect(signIn("b", totpCodeForStep(SECRET, step0 + 40), t0)).rejects.toMatchObject({ code: "MFA_CODE_INVALID" });
    expect(enrollment.failedAttempts).toBe(1);

    await expect(signIn("c", totpCodeForStep(SECRET, step0), t0)).rejects.toMatchObject({ code: "MFA_CODE_ALREADY_USED" });
    expect(enrollment.failedAttempts).toBe(1);
  });

  it("each challenge still has its own small attempt cap, which bounds repeated spent-code tries", async () => {
    world();
    const spent = totpCodeForStep(SECRET, step0);
    await signIn("a", spent, t0);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(signIn("b", spent, t0)).rejects.toMatchObject({ code: "MFA_CODE_ALREADY_USED" });
    }
    await expect(signIn("b", spent, t0)).rejects.toMatchObject({ code: "MFA_CHALLENGE_INVALID" });
  });
});
