import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #741 slice 3: free text containing the account-link placeholder queues and
 * "delivers" without minting a token or throwing. The body preparation for
 * MODULE_REQUEST_* messages never does sentinel replacement. Synthetic data only.
 */
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ issueAccountTokenForUser: vi.fn(), revokeAccountToken: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ getPrisma: vi.fn() }));
vi.mock("@/lib/env", () => ({ getServerEnv: () => ({ APP_BASE_URL: "https://events.imsda.test" }) }));
vi.mock("@/modules/access/auth-service", () => ({
  ACTIVATION_LIFETIME_MINUTES: 1,
  RESET_LIFETIME_MINUTES: 1,
  issueAccountTokenForUser: mocks.issueAccountTokenForUser,
  revokeAccountToken: mocks.revokeAccountToken,
}));
vi.mock("@/integrations/email/resend", () => ({ getResendEmailAvailability: () => ({ deliveryConfigured: false }) }));

import { ACCOUNT_ACTION_LINK_SENTINEL, prepareAccountEmailBodyForDelivery } from "@/modules/communications/account-email";

beforeEach(() => vi.clearAllMocks());

describe("module request email delivery", () => {
  it.each(["MODULE_REQUEST_SUBMITTED", "MODULE_REQUEST_DECIDED"])("leaves a %s body untouched and mints no token", async (templateKey) => {
    const bodyText = `Why: please ${ACCOUNT_ACTION_LINK_SENTINEL} now`;
    await expect(prepareAccountEmailBodyForDelivery({ messageId: "m1", accountUserId: null, templateKey, bodyText, now: new Date() }))
      .resolves.toEqual({ bodyText });
    expect(mocks.issueAccountTokenForUser).not.toHaveBeenCalled();
  });

  it("still mints a link for a real password reset, so the guard is specific", async () => {
    mocks.issueAccountTokenForUser.mockResolvedValue({ token: "synthetic-token" });
    const prepared = await prepareAccountEmailBodyForDelivery({
      messageId: "m2", accountUserId: "user-1", templateKey: "ACCOUNT_PASSWORD_RESET", bodyText: ACCOUNT_ACTION_LINK_SENTINEL, now: new Date(),
    });
    expect(prepared.bodyText).toContain("synthetic-token");
  });
});
