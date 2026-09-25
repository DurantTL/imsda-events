import { describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ getPrisma: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: database.getPrisma }));

import {
  PlatformSettingsError,
  platformSettingsInputSchema,
  updatePlatformSettings,
} from "@/modules/system-admin/platform-settings";

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    organizationName: "IMSDA",
    defaultTimezone: "America/Chicago",
    defaultSenderName: "IMSDA Events",
    defaultAttendeeEditPolicy: "VERIFY_EVERY_EDIT",
    ...overrides,
  };
}

describe("platform settings input", () => {
  it("treats a cleared field as unset rather than an empty string", () => {
    const parsed = platformSettingsInputSchema.parse(validInput({
      defaultSenderEmail: "",
      logoUrl: "",
      supportContact: "",
    }));
    // Null, not "". Inheritance asks whether a default exists, and an empty
    // string would answer yes while supplying nothing.
    expect(parsed.defaultSenderEmail).toBeNull();
    expect(parsed.logoUrl).toBeNull();
    expect(parsed.supportContact).toBeNull();
  });

  it("normalises an address the way the rest of the system stores one", () => {
    const parsed = platformSettingsInputSchema.parse(validInput({
      defaultSenderEmail: "  Notifications@IMSDA.org ",
    }));
    expect(parsed.defaultSenderEmail).toBe("notifications@imsda.org");
  });

  it("rejects a malformed address and a malformed URL", () => {
    expect(platformSettingsInputSchema.safeParse(
      validInput({ defaultSenderEmail: "not-an-address" }),
    ).success).toBe(false);
    expect(platformSettingsInputSchema.safeParse(
      validInput({ logoUrl: "imsda.org/logo.png" }),
    ).success).toBe(false);
  });

  it("requires the fields an event cannot be created without", () => {
    expect(platformSettingsInputSchema.safeParse(
      validInput({ organizationName: "" }),
    ).success).toBe(false);
    expect(platformSettingsInputSchema.safeParse(
      validInput({ defaultTimezone: "" }),
    ).success).toBe(false);
    expect(platformSettingsInputSchema.safeParse(
      validInput({ defaultSenderName: "" }),
    ).success).toBe(false);
  });

  it("refuses unknown fields rather than silently dropping them", () => {
    expect(platformSettingsInputSchema.safeParse(
      validInput({ deliveryMode: "EXTERNAL_EMAIL" }),
    ).success).toBe(false);
  });

  it("validates the security alert email address and allows leaving it blank (#456)", () => {
    const blank = platformSettingsInputSchema.parse(validInput({ securityAlertEmail: "" }));
    expect(blank.securityAlertEmail).toBeNull();

    const normalized = platformSettingsInputSchema.parse(
      validInput({ securityAlertEmail: "  Security@IMSDA.org " }),
    );
    expect(normalized.securityAlertEmail).toBe("security@imsda.org");

    expect(platformSettingsInputSchema.safeParse(
      validInput({ securityAlertEmail: "not-an-address" }),
    ).success).toBe(false);
  });
});

describe("clearing the passkey domain", () => {
  function settingsDatabase(options: { currentRpId: string | null; passkeyOnlyStaff: number }) {
    const tx = {
      platformSettings: {
        findUnique: vi.fn().mockResolvedValue({
          id: "platform",
          organizationName: "IMSDA",
          passkeyRpId: options.currentRpId,
        }),
        upsert: vi.fn().mockResolvedValue({}),
      },
      user: { count: vi.fn().mockResolvedValue(options.passkeyOnlyStaff) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      ...tx,
      $transaction: vi.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx)),
    };
    prisma.platformSettings = {
      ...tx.platformSettings,
      // The read-back after saving.
      upsert: vi.fn().mockResolvedValue({
        organizationName: "IMSDA",
        updatedAt: new Date("2026-09-25T00:00:00Z"),
        updatedBy: null,
        passkeyRpId: null,
      }),
    };
    database.getPrisma.mockReturnValue(prisma);
    return tx;
  }

  const cleared = () => platformSettingsInputSchema.parse(validInput({ passkeyRpId: "" }));

  it("is refused while staff can sign in only with a passkey (#456)", async () => {
    const tx = settingsDatabase({ currentRpId: "events.imsda.org", passkeyOnlyStaff: 2 });

    const attempt = updatePlatformSettings(cleared(), "admin-1");
    await expect(attempt).rejects.toBeInstanceOf(PlatformSettingsError);
    await expect(attempt).rejects.toThrow("2 staff sign in only with a passkey; they'd be locked out.");

    // Counted as: active accounts with a live passkey and no active authenticator.
    expect(tx.user.count).toHaveBeenCalledWith({
      where: {
        accountStatus: "ACTIVE",
        passkeys: { some: { revokedAt: null } },
        NOT: { mfaEnrollment: { is: { status: "ACTIVE" } } },
      },
    });
    expect(tx.platformSettings.upsert).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("is allowed once every passkey user also has an authenticator", async () => {
    const tx = settingsDatabase({ currentRpId: "events.imsda.org", passkeyOnlyStaff: 0 });

    await updatePlatformSettings(cleared(), "admin-1");

    expect(tx.platformSettings.upsert).toHaveBeenCalled();
  });

  it("does not check when the domain is not being cleared", async () => {
    const tx = settingsDatabase({ currentRpId: "events.imsda.org", passkeyOnlyStaff: 3 });

    await updatePlatformSettings(
      platformSettingsInputSchema.parse(validInput({ passkeyRpId: "events.imsda.org" })),
      "admin-1",
    );

    expect(tx.user.count).not.toHaveBeenCalled();
    expect(tx.platformSettings.upsert).toHaveBeenCalled();
  });
});
