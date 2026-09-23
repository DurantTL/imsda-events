import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listDirectedClubs: vi.fn(),
  session: vi.fn(),
  enrollment: vi.fn(),
  passkeyCount: vi.fn(),
  passkeysConfigured: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    attendeeSession: { findUnique: mocks.session },
    attendeeMfaEnrollment: { findUnique: mocks.enrollment },
    attendeePasskey: { count: mocks.passkeyCount },
  }),
}));
vi.mock("@/modules/organizations/director-access", () => ({ listDirectedClubs: mocks.listDirectedClubs }));
vi.mock("@/modules/attendee-accounts/passkeys", () => ({ passkeysConfigured: mocks.passkeysConfigured }));

import { disableAttendeeMfa } from "@/modules/attendee-accounts/mfa-service";
import { accountNeedsSecondStep } from "@/modules/attendee-accounts/sign-in-gate";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listDirectedClubs.mockResolvedValue([{ organizationId: "club-1", role: "REPORTER" }]);
  mocks.session.mockResolvedValue({ secondFactorVerifiedAt: null });
  mocks.enrollment.mockResolvedValue({ status: "ACTIVE" });
  mocks.passkeyCount.mockResolvedValue(0);
  mocks.passkeysConfigured.mockResolvedValue(true);
});

describe("second step after the password (decision 2026-09-23)", () => {
  it("leaves ordinary attendees on password-only sign-in", async () => {
    mocks.listDirectedClubs.mockResolvedValue([]);
    await expect(accountNeedsSecondStep("account-1", "session-1")).resolves.toBe("OK");
    expect(mocks.session).not.toHaveBeenCalled();
  });

  it("asks any club role for a code or passkey once per sign-in", async () => {
    await expect(accountNeedsSecondStep("account-1", "session-1")).resolves.toBe("VERIFY");
    mocks.session.mockResolvedValue({ secondFactorVerifiedAt: new Date() });
    await expect(accountNeedsSecondStep("account-1", "session-1")).resolves.toBe("OK");
  });

  it("makes a club role with nothing set up add a second step first", async () => {
    mocks.enrollment.mockResolvedValue(null);
    await expect(accountNeedsSecondStep("account-1", "session-1")).resolves.toBe("SETUP");
    mocks.passkeyCount.mockResolvedValue(1);
    await expect(accountNeedsSecondStep("account-1", "session-1")).resolves.toBe("VERIFY");
    // A passkey can't be used while passkeys are switched off for the site.
    mocks.passkeysConfigured.mockResolvedValue(false);
    await expect(accountNeedsSecondStep("account-1", "session-1")).resolves.toBe("SETUP");
  });

  it("never lets anyone turn two-step sign-in off", async () => {
    await expect(disableAttendeeMfa("account-1", "123456")).rejects.toMatchObject({ code: "MFA_REMOVAL_NOT_ALLOWED" });
  });
});
