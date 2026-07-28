import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { platformSettingsInputSchema } from "@/modules/system-admin/platform-settings";

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    organizationName: "IMSDA",
    defaultTimezone: "America/Chicago",
    defaultSenderName: "IMSDA Events",
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
});
