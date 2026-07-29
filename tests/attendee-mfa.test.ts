import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  getServerEnv: vi.fn(),
  sealSecret: vi.fn(),
  openSecret: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@/lib/env", () => ({ getServerEnv: dependencies.getServerEnv }));
vi.mock("@/lib/secret-box", () => ({
  sealSecret: dependencies.sealSecret,
  openSecret: dependencies.openSecret,
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
