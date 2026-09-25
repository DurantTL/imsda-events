import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  getServerEnv: vi.fn(),
  sealSecret: vi.fn(),
  openSecret: vi.fn(),
  dispatchLockoutEmails: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@/lib/env", () => ({ getServerEnv: dependencies.getServerEnv }));
vi.mock("@/lib/secret-box", () => ({
  sealSecret: dependencies.sealSecret,
  openSecret: dependencies.openSecret,
}));
vi.mock("@/modules/communications/lockout-email", () => ({
  dispatchLockoutEmails: dependencies.dispatchLockoutEmails,
}));

import {
  beginAttendeeMfaEnrollment,
  confirmAttendeeMfaEnrollment,
  getAttendeeMfaStatus,
  verifyAttendeeSecondFactor,
} from "@/modules/attendee-accounts/mfa-service";
import { totpCode } from "@/modules/access/totp";

const SECRET = "JBSWY3DPEHPK3PXP";
const NOW = new Date("2026-07-29T12:00:00Z");

function prismaStub() {
  const stub = {
    attendeeAccount: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        email: "person@example.com",
        mfaEnrollment: null,
      }),
    },
    attendeeMfaEnrollment: {
      findUnique: vi.fn(),
      upsert: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      delete: vi.fn().mockResolvedValue({}),
    },
    attendeeMfaRecoveryCode: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 10 }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: vi.fn(async (values: Promise<unknown>[]) => Promise.all(values)),
  };
  return stub;
}

let prisma: ReturnType<typeof prismaStub>;

beforeEach(() => {
  vi.clearAllMocks();
  prisma = prismaStub();
  dependencies.getPrisma.mockReturnValue(prisma);
  dependencies.getServerEnv.mockReturnValue({ APP_BASE_URL: "https://events.imsda.org" });
  dependencies.sealSecret.mockReturnValue("sealed-secret");
  dependencies.openSecret.mockReturnValue(SECRET);
});

describe("attendee authenticator enrollment", () => {
  it("offers a secret and stores only its sealed form", async () => {
    const offer = await beginAttendeeMfaEnrollment("acct-1");

    expect(offer.secret).toMatch(/^[A-Z2-7]+$/);
    expect(offer.otpauthUri).toContain("otpauth://totp/");
    expect(prisma.attendeeMfaEnrollment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ sealedSecret: "sealed-secret" }),
      }),
    );
  });

  it("confirms a current code and issues single-use recovery codes", async () => {
    prisma.attendeeMfaEnrollment.findUnique.mockResolvedValue({
      id: "mfa-1",
      status: "PENDING",
      sealedSecret: "sealed-secret",
      lastUsedStep: null,
    });

    const result = await confirmAttendeeMfaEnrollment(
      "acct-1",
      totpCode(SECRET, NOW),
      NOW,
    );

    expect(result.recoveryCodes).toHaveLength(10);
    expect(prisma.attendeeMfaEnrollment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "ACTIVE", confirmedAt: NOW }),
      }),
    );
    expect(prisma.attendeeMfaRecoveryCode.createMany).toHaveBeenCalledOnce();
  });

  it("provides a reusable guard for future medical and club scopes", async () => {
    prisma.attendeeMfaEnrollment.findUnique.mockResolvedValue({
      id: "mfa-1",
      status: "ACTIVE",
      sealedSecret: "sealed-secret",
      lastUsedStep: null,
    });

    await expect(verifyAttendeeSecondFactor(
      "acct-1",
      totpCode(SECRET, NOW),
      NOW,
    )).resolves.toBeUndefined();
  });

  it("reports no enrollment without treating it as required for basic access", async () => {
    prisma.attendeeMfaEnrollment.findUnique.mockResolvedValue(null);
    await expect(getAttendeeMfaStatus("acct-1")).resolves.toEqual({
      required: false,
      status: "NONE",
      confirmedAt: null,
      lastVerifiedAt: null,
      unusedRecoveryCodes: 0,
    });
  });
});

describe("the second-factor lockout (#456)", () => {
  function enrollmentFixture(overrides: { failedAttempts?: number; lockedUntil?: Date | null } = {}) {
    let failedAttempts = overrides.failedAttempts ?? 0;
    prisma.attendeeMfaEnrollment.findUnique.mockResolvedValue({
      id: "mfa-1",
      status: "ACTIVE",
      sealedSecret: "sealed-secret",
      lastUsedStep: null,
      lockedUntil: overrides.lockedUntil ?? null,
    });
    prisma.attendeeMfaEnrollment.update.mockImplementation(async (query: { data: Record<string, unknown> }) => {
      const increment = query.data.failedAttempts as { increment?: number } | undefined;
      if (increment && typeof increment === "object" && "increment" in increment) {
        failedAttempts += 1;
        return { failedAttempts };
      }
      return {};
    });
  }

  it("locks after three wrong codes, not five", async () => {
    enrollmentFixture();

    await expect(verifyAttendeeSecondFactor("acct-1", "000001", NOW))
      .rejects.toMatchObject({ code: "MFA_CODE_INVALID" });
    await expect(verifyAttendeeSecondFactor("acct-1", "000002", NOW))
      .rejects.toMatchObject({ code: "MFA_CODE_INVALID" });
    expect(dependencies.dispatchLockoutEmails).not.toHaveBeenCalled();

    await expect(verifyAttendeeSecondFactor("acct-1", "000003", NOW))
      .rejects.toMatchObject({ code: "MFA_CODE_INVALID" });
    expect(dependencies.dispatchLockoutEmails).toHaveBeenCalledTimes(1);
    expect(dependencies.dispatchLockoutEmails).toHaveBeenCalledWith({
      audience: "ATTENDEE",
      kind: "CODE",
      accountAttendeeId: "acct-1",
      lockedUntil: expect.any(Date),
      now: NOW,
    });
  });

  it("refuses while locked, without counting the attempt or emailing again", async () => {
    enrollmentFixture({ lockedUntil: new Date(NOW.getTime() + 60_000) });

    await expect(verifyAttendeeSecondFactor("acct-1", "000000", NOW))
      .rejects.toMatchObject({ code: "MFA_LOCKED" });

    expect(prisma.attendeeMfaEnrollment.update).not.toHaveBeenCalled();
    expect(dependencies.dispatchLockoutEmails).not.toHaveBeenCalled();
  });

  it("clears the counter on a correct code", async () => {
    enrollmentFixture();

    await expect(verifyAttendeeSecondFactor("acct-1", totpCode(SECRET, NOW), NOW))
      .resolves.toBeUndefined();

    expect(prisma.attendeeMfaEnrollment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ failedAttempts: 0, lockedUntil: null }),
      }),
    );
  });
});
