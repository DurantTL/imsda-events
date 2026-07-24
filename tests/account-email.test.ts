import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  getServerEnv: vi.fn(),
  issueAccountTokenForUser: vi.fn(),
  revokeAccountToken: vi.fn(),
  getResendEmailAvailability: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@/lib/env", () => ({ getServerEnv: dependencies.getServerEnv }));
vi.mock("@/modules/access/auth-service", () => ({
  ACTIVATION_LIFETIME_MINUTES: 7 * 24 * 60,
  RESET_LIFETIME_MINUTES: 30,
  issueAccountTokenForUser: dependencies.issueAccountTokenForUser,
  revokeAccountToken: dependencies.revokeAccountToken,
}));
vi.mock("@/integrations/email/resend", () => ({
  getResendEmailAvailability: dependencies.getResendEmailAvailability,
}));

import {
  ACCOUNT_ACTION_LINK_SENTINEL,
  accountEmailContent,
  enqueueAccountEmail,
  getAccountEmailSender,
  isAccountEmailConfigured,
  prepareAccountEmailBodyForDelivery,
} from "@/modules/communications/account-email";

const configuredEnv = {
  APP_BASE_URL: "https://events.imsda.org",
  ACCOUNT_EMAIL_SENDER_NAME: "IMSDA Events",
  ACCOUNT_EMAIL_SENDER_ADDRESS: "no-reply@imsda.org",
  ACCOUNT_EMAIL_REPLY_TO: "help@imsda.org",
};

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.getServerEnv.mockReturnValue(configuredEnv);
  dependencies.getResendEmailAvailability.mockReturnValue({
    deliveryConfigured: true,
    webhookConfigured: true,
  });
});

describe("account email content", () => {
  it("carries a sentinel rather than a link, for both purposes", () => {
    for (const purpose of ["ACCOUNT_ACTIVATION", "PASSWORD_RESET"] as const) {
      const content = accountEmailContent(purpose, { displayName: "Alex Staff" });
      expect(content.bodyText).toContain(ACCOUNT_ACTION_LINK_SENTINEL);
      expect(content.bodyText).not.toContain("token=");
      expect(content.bodyText).toContain("Alex Staff");
    }
  });

  it("states the lifetime each link actually has", () => {
    expect(accountEmailContent("ACCOUNT_ACTIVATION", { displayName: "Alex" }).bodyText)
      .toContain("expires in 7 days");
    expect(accountEmailContent("PASSWORD_RESET", { displayName: "Alex" }).bodyText)
      .toContain("expires in 30 minutes");
  });

  it("addresses someone whose display name is blank", () => {
    expect(accountEmailContent("PASSWORD_RESET", { displayName: "  " }).bodyText)
      .toContain("Hello there,");
  });
});

describe("account email configuration", () => {
  it("needs both a sender address and a delivery key", () => {
    expect(isAccountEmailConfigured()).toBe(true);

    dependencies.getServerEnv.mockReturnValue({
      ...configuredEnv,
      ACCOUNT_EMAIL_SENDER_ADDRESS: undefined,
    });
    expect(isAccountEmailConfigured()).toBe(false);

    dependencies.getServerEnv.mockReturnValue(configuredEnv);
    dependencies.getResendEmailAvailability.mockReturnValue({
      deliveryConfigured: false,
      webhookConfigured: false,
    });
    expect(isAccountEmailConfigured()).toBe(false);
  });

  it("refuses to invent a sender", () => {
    dependencies.getServerEnv.mockReturnValue({
      ...configuredEnv,
      ACCOUNT_EMAIL_SENDER_ADDRESS: undefined,
    });

    expect(() => getAccountEmailSender()).toThrowError(/ACCOUNT_EMAIL_SENDER_ADDRESS/);
  });
});

describe("queueing an account email", () => {
  function outboxFixture() {
    const queries: Array<{ data: Record<string, unknown> }> = [];
    const create = vi.fn(async (query: { data: Record<string, unknown> }) => {
      queries.push(query);
      return { id: "message-1" };
    });
    dependencies.getPrisma.mockReturnValue({ messageOutbox: { create } });
    return create;
  }

  it("queues a row that belongs to a person and to no event", async () => {
    const create = outboxFixture();

    const queued = await enqueueAccountEmail({
      userId: "user-1",
      email: "Alex@IMSDA.org",
      displayName: "Alex Staff",
      purpose: "ACCOUNT_ACTIVATION",
      requestKey: "invite-1",
    });

    expect(queued).toEqual({ messageId: "message-1", purpose: "ACCOUNT_ACTIVATION" });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventId: null,
        accountUserId: "user-1",
        templateKey: "ACCOUNT_ACTIVATION",
        recipientKind: "ACCOUNT",
        recipientEmail: "alex@imsda.org",
        senderNameSnapshot: "IMSDA Events",
        senderEmailSnapshot: "no-reply@imsda.org",
        replyToEmailSnapshot: "help@imsda.org",
        idempotencyKey: "account:ACCOUNT_ACTIVATION:invite-1",
        status: "PENDING",
      }),
      select: { id: true },
    });
  });

  it("writes no usable credential to the outbox", async () => {
    const create = outboxFixture();

    await enqueueAccountEmail({
      userId: "user-1",
      email: "alex@imsda.org",
      displayName: "Alex Staff",
      purpose: "PASSWORD_RESET",
    });

    // The whole point of minting at delivery: a database read yields no link.
    const stored = JSON.stringify(create.mock.calls[0][0]);
    expect(stored).toContain(ACCOUNT_ACTION_LINK_SENTINEL);
    expect(stored).not.toContain("/reset-password?token=");
    expect(dependencies.issueAccountTokenForUser).not.toHaveBeenCalled();
  });
});

describe("minting the link at delivery", () => {
  const now = new Date("2026-07-24T12:00:00.000Z");

  it("substitutes a one-time URL built from the configured base", async () => {
    dependencies.issueAccountTokenForUser.mockResolvedValue({
      token: "raw-token-value",
      purpose: "PASSWORD_RESET",
      expiresAt: new Date("2026-07-24T12:30:00.000Z"),
    });

    const prepared = await prepareAccountEmailBodyForDelivery({
      messageId: "message-1",
      accountUserId: "user-1",
      templateKey: "ACCOUNT_PASSWORD_RESET",
      bodyText: `Choose a new one: ${ACCOUNT_ACTION_LINK_SENTINEL}`,
      now,
    });

    expect(prepared.bodyText).toBe(
      "Choose a new one: https://events.imsda.org/reset-password?token=raw-token-value",
    );
    expect(dependencies.issueAccountTokenForUser).toHaveBeenCalledWith("user-1", {
      purpose: "PASSWORD_RESET",
      now,
    });
  });

  it("mints an activation token for the activation template", async () => {
    dependencies.issueAccountTokenForUser.mockResolvedValue({
      token: "raw-token-value",
      purpose: "ACCOUNT_ACTIVATION",
      expiresAt: now,
    });

    await prepareAccountEmailBodyForDelivery({
      messageId: "message-1",
      accountUserId: "user-1",
      templateKey: "ACCOUNT_ACTIVATION",
      bodyText: ACCOUNT_ACTION_LINK_SENTINEL,
      now,
    });

    expect(dependencies.issueAccountTokenForUser).toHaveBeenCalledWith("user-1", {
      purpose: "ACCOUNT_ACTIVATION",
      now,
    });
  });

  it("retires the token when the attempt fails definitively", async () => {
    dependencies.issueAccountTokenForUser.mockResolvedValue({
      token: "raw-token-value",
      purpose: "PASSWORD_RESET",
      expiresAt: now,
    });

    const prepared = await prepareAccountEmailBodyForDelivery({
      messageId: "message-1",
      accountUserId: "user-1",
      templateKey: "ACCOUNT_PASSWORD_RESET",
      bodyText: ACCOUNT_ACTION_LINK_SENTINEL,
      now,
    });
    await prepared.revokeOnDefinitiveFailure?.();

    expect(dependencies.revokeAccountToken).toHaveBeenCalledWith("raw-token-value", now);
  });

  it("mints nothing for a body that asks for nothing", async () => {
    const prepared = await prepareAccountEmailBodyForDelivery({
      messageId: "message-1",
      accountUserId: "user-1",
      templateKey: "ACCOUNT_PASSWORD_RESET",
      bodyText: "Your password was changed.",
      now,
    });

    expect(prepared.bodyText).toBe("Your password was changed.");
    expect(dependencies.issueAccountTokenForUser).not.toHaveBeenCalled();
  });

  it("refuses to mint a link with no account to mint it for", async () => {
    await expect(prepareAccountEmailBodyForDelivery({
      messageId: "message-1",
      accountUserId: null,
      templateKey: "ACCOUNT_PASSWORD_RESET",
      bodyText: ACCOUNT_ACTION_LINK_SENTINEL,
      now,
    })).rejects.toThrowError(/without an account/);
  });
});
