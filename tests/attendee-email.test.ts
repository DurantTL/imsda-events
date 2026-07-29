import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  getServerEnv: vi.fn(),
  getResendEmailAvailability: vi.fn(),
  attachVerificationCode: vi.fn(),
  attachPasswordResetCode: vi.fn(),
  reuseVerificationCode: vi.fn(),
  reusePasswordResetCode: vi.fn(),
  revokeVerificationCode: vi.fn(),
  attachAttendeeStepUpCode: vi.fn(),
  reuseAttendeeStepUpCode: vi.fn(),
  revokeAttendeeStepUpCode: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@/lib/env", () => ({ getServerEnv: dependencies.getServerEnv }));
vi.mock("@/integrations/email/resend", () => ({
  getResendEmailAvailability: dependencies.getResendEmailAvailability,
}));
vi.mock("@/modules/attendee-accounts/account-service", () => ({
  attachVerificationCode: dependencies.attachVerificationCode,
  attachPasswordResetCode: dependencies.attachPasswordResetCode,
  reuseVerificationCode: dependencies.reuseVerificationCode,
  reusePasswordResetCode: dependencies.reusePasswordResetCode,
  revokeVerificationCode: dependencies.revokeVerificationCode,
}));
vi.mock("@/modules/attendee-accounts/step-up-service", () => ({
  attachAttendeeStepUpCode: dependencies.attachAttendeeStepUpCode,
  reuseAttendeeStepUpCode: dependencies.reuseAttendeeStepUpCode,
  revokeAttendeeStepUpCode: dependencies.revokeAttendeeStepUpCode,
}));

import {
  PASSWORD_RESET_CODE_SENTINEL,
  EDIT_VERIFICATION_CODE_SENTINEL,
  VERIFICATION_CODE_SENTINEL,
  enqueueAttendeeEmail,
  prepareAttendeeEmailBodyForDelivery,
} from "@/modules/attendee-accounts/attendee-email";
const messageOutbox = { create: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.getServerEnv.mockReturnValue({
    APP_BASE_URL: "https://events.imsda.org",
    ACCOUNT_EMAIL_SENDER_NAME: "IMSDA Events",
    ACCOUNT_EMAIL_SENDER_ADDRESS: "no-reply@imsda.org",
    ACCOUNT_EMAIL_REPLY_TO: "help@imsda.org",
  });
  dependencies.getResendEmailAvailability.mockReturnValue({
    deliveryConfigured: true,
    webhookConfigured: true,
  });
  messageOutbox.create.mockResolvedValue({ id: "msg_1" });
  dependencies.getPrisma.mockReturnValue({ messageOutbox });
  dependencies.attachVerificationCode.mockResolvedValue(true);
  dependencies.attachPasswordResetCode.mockResolvedValue(true);
  dependencies.reuseVerificationCode.mockResolvedValue(null);
  dependencies.reusePasswordResetCode.mockResolvedValue(null);
  dependencies.attachAttendeeStepUpCode.mockResolvedValue(true);
  dependencies.reuseAttendeeStepUpCode.mockResolvedValue(null);
});

async function enqueue(alreadyRegistered: boolean) {
  await enqueueAttendeeEmail({
    accountId: "acct_1",
    email: "Someone@Example.COM",
    displayName: "Someone",
    selection: { kind: "verification", alreadyRegistered },
  });
  return messageOutbox.create.mock.calls[0][0].data;
}

async function enqueueReset(federatedOnly: boolean) {
  await enqueueAttendeeEmail({
    accountId: "acct_1",
    email: "Someone@Example.COM",
    displayName: "Someone",
    selection: { kind: "password-reset", federatedOnly },
  });
  return messageOutbox.create.mock.calls[0][0].data;
}

describe("what sign-up puts in the outbox", () => {
  it("queues a sentinel, never a code", async () => {
    const data = await enqueue(false);
    expect(data.bodyTextSnapshot).toContain(VERIFICATION_CODE_SENTINEL);
    expect(data.bodyTextSnapshot).not.toMatch(/\b\d{6}\b/);
  });

  it("attributes the message to the attendee, not to a staff user", async () => {
    const data = await enqueue(false);
    expect(data.accountAttendeeId).toBe("acct_1");
    expect(data.accountUserId).toBeUndefined();
    expect(data.eventId).toBeNull();
    expect(data.recipientEmail).toBe("someone@example.com");
  });

  it("sends the address owner a different message when an account exists", async () => {
    const data = await enqueue(true);
    // No sentinel, so the delivery step mints nothing and there is nothing for
    // whoever asked to complete.
    expect(data.bodyTextSnapshot).not.toContain(VERIFICATION_CODE_SENTINEL);
    expect(data.bodyTextSnapshot).toContain("already exists");
    expect(data.bodyTextSnapshot).toContain("Forgot password");
  });

  it("uses one template key for both, so the outbox leaks no more than the response", async () => {
    // Whether an address was already known is the fact sign-up refuses to
    // disclose. Two keys would restate it to anyone reading the queue.
    const fresh = await enqueue(false);
    messageOutbox.create.mockClear();
    const taken = await enqueue(true);
    expect(fresh.templateKey).toBe("ATTENDEE_EMAIL_VERIFICATION");
    expect(taken.templateKey).toBe(fresh.templateKey);
    expect(taken.subjectSnapshot).toBe(fresh.subjectSnapshot);
  });
});

describe("what a password reset request puts in the outbox", () => {
  it("queues a sentinel, never a code", async () => {
    const data = await enqueueReset(false);
    expect(data.templateKey).toBe("ATTENDEE_PASSWORD_RESET");
    expect(data.bodyTextSnapshot).toContain(PASSWORD_RESET_CODE_SENTINEL);
    expect(data.bodyTextSnapshot).not.toMatch(/\b\d{6}\b/);
  });

  it("tells a Google-only account to use Google, and sends no code", async () => {
    // Minting one would be a way to put a password on an account whose owner
    // deliberately has none.
    const data = await enqueueReset(true);
    expect(data.bodyTextSnapshot).not.toContain(PASSWORD_RESET_CODE_SENTINEL);
    expect(data.bodyTextSnapshot).toContain("signs in with Google");
  });

  it("uses one subject for both, so the outbox leaks no more than the response", async () => {
    const withPassword = await enqueueReset(false);
    messageOutbox.create.mockClear();
    const federated = await enqueueReset(true);
    expect(federated.subjectSnapshot).toBe(withPassword.subjectSnapshot);
    expect(federated.templateKey).toBe(withPassword.templateKey);
  });

  it("does not collide with a verification already in the outbox", async () => {
    // Both are keyed per request, and the template key is part of the key, so a
    // reset cannot be swallowed as a duplicate of a sign-up.
    const verification = await enqueue(false);
    messageOutbox.create.mockClear();
    const reset = await enqueueReset(false);
    expect(reset.idempotencyKey).not.toBe(verification.idempotencyKey);
  });
});

describe("minting the code at delivery", () => {
  it("mints a reset code against the reset token, not the verification one", async () => {
    // The two purposes can be outstanding at once, and attaching a reset code
    // to a verification token would produce a code that verifies nothing and a
    // reset nobody can finish.
    const prepared = await prepareAttendeeEmailBodyForDelivery({
      messageId: "message-reset",
      accountAttendeeId: "acct_1",
      templateKey: "ATTENDEE_PASSWORD_RESET",
      bodyText: `Here it is:\n${PASSWORD_RESET_CODE_SENTINEL}`,
      now: new Date("2026-07-29T12:00:00Z"),
    });

    expect(prepared.bodyText).toMatch(/\b\d{6}\b/);
    expect(dependencies.attachPasswordResetCode).toHaveBeenCalledOnce();
    expect(dependencies.attachVerificationCode).not.toHaveBeenCalled();
  });

  it("leaves a verification sentinel alone in a reset body, and the reverse", async () => {
    // Each message only ever replaces its own sentinel, so a mismatched pair
    // fails loudly rather than sending the wrong code.
    const prepared = await prepareAttendeeEmailBodyForDelivery({
      messageId: "message-mismatch",
      accountAttendeeId: "acct_1",
      templateKey: "ATTENDEE_PASSWORD_RESET",
      bodyText: VERIFICATION_CODE_SENTINEL,
      now: new Date("2026-07-29T12:00:00Z"),
    });
    expect(prepared.bodyText).toBe(VERIFICATION_CODE_SENTINEL);
    expect(dependencies.attachPasswordResetCode).not.toHaveBeenCalled();
  });

  it("replaces the sentinel with a six-digit code and stores that code's digest", async () => {
    const prepared = await prepareAttendeeEmailBodyForDelivery({
      messageId: "message-verification",
      accountAttendeeId: "acct_1",
      templateKey: "ATTENDEE_EMAIL_VERIFICATION",
      bodyText: `Here it is:\n${VERIFICATION_CODE_SENTINEL}\nThanks.`,
      now: new Date("2026-07-28T12:00:00Z"),
    });

    const code = prepared.bodyText.match(/\b(\d{6})\b/)?.[1];
    expect(code).toMatch(/^\d{6}$/);
    expect(prepared.bodyText).not.toContain(VERIFICATION_CODE_SENTINEL);
    expect(dependencies.attachVerificationCode).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct_1",
        messageId: "message-verification",
        code,
      }),
    );
  });

  it("retires the code if the send fails for good", async () => {
    const prepared = await prepareAttendeeEmailBodyForDelivery({
      messageId: "message-definitive-failure",
      accountAttendeeId: "acct_1",
      templateKey: "ATTENDEE_EMAIL_VERIFICATION",
      bodyText: VERIFICATION_CODE_SENTINEL,
      now: new Date("2026-07-28T12:00:00Z"),
    });
    await prepared.revokeOnDefinitiveFailure?.();
    // Otherwise a code nobody received stays spendable for its full lifetime.
    expect(dependencies.revokeVerificationCode).toHaveBeenCalledOnce();
  });

  it("leaves a body with no sentinel alone", async () => {
    const bodyText = "An account already exists for this address.";
    const prepared = await prepareAttendeeEmailBodyForDelivery({
      messageId: "message-no-sentinel",
      accountAttendeeId: "acct_1",
      templateKey: "ATTENDEE_EMAIL_VERIFICATION",
      bodyText,
      now: new Date("2026-07-28T12:00:00Z"),
    });
    expect(prepared.bodyText).toBe(bodyText);
    expect(dependencies.attachVerificationCode).not.toHaveBeenCalled();
  });

  it("refuses to send a code no verification will accept", async () => {
    // The verification was superseded, spent, or expired while the message sat
    // in the queue. Delivering a dead code is worse than not delivering.
    dependencies.attachVerificationCode.mockResolvedValue(false);
    await expect(prepareAttendeeEmailBodyForDelivery({
      messageId: "message-dead-code",
      accountAttendeeId: "acct_1",
      templateKey: "ATTENDEE_EMAIL_VERIFICATION",
      bodyText: VERIFICATION_CODE_SENTINEL,
      now: new Date("2026-07-28T12:00:00Z"),
    })).rejects.toThrow(/no live attendee code/i);
  });

  it("refuses to mint without an account", async () => {
    await expect(prepareAttendeeEmailBodyForDelivery({
      messageId: "message-no-account",
      accountAttendeeId: null,
      templateKey: "ATTENDEE_EMAIL_VERIFICATION",
      bodyText: VERIFICATION_CODE_SENTINEL,
      now: new Date("2026-07-28T12:00:00Z"),
    })).rejects.toThrow();
  });

  it("reuses the first sealed code on a retry instead of minting another", async () => {
    dependencies.reuseVerificationCode.mockResolvedValue("246810");

    const prepared = await prepareAttendeeEmailBodyForDelivery({
      messageId: "message-retry",
      accountAttendeeId: "acct_1",
      templateKey: "ATTENDEE_EMAIL_VERIFICATION",
      bodyText: VERIFICATION_CODE_SENTINEL,
      now: new Date("2026-07-28T12:01:00Z"),
    });

    expect(prepared.bodyText).toBe("246810");
    expect(dependencies.attachVerificationCode).not.toHaveBeenCalled();
    expect(dependencies.reuseVerificationCode).toHaveBeenCalledWith({
      accountId: "acct_1",
      messageId: "message-retry",
      now: new Date("2026-07-28T12:01:00Z"),
    });
  });

  it("binds an edit code to the step-up record and reuses it on delivery retry", async () => {
    dependencies.reuseAttendeeStepUpCode.mockResolvedValue("135790");
    const prepared = await prepareAttendeeEmailBodyForDelivery({
      messageId: "message-edit-retry",
      accountAttendeeId: "acct_1",
      templateKey: "ATTENDEE_EDIT_VERIFICATION",
      bodyText: EDIT_VERIFICATION_CODE_SENTINEL,
      now: new Date("2026-07-28T12:01:00Z"),
    });

    expect(prepared.bodyText).toBe("135790");
    expect(dependencies.attachAttendeeStepUpCode).not.toHaveBeenCalled();
    expect(dependencies.reuseAttendeeStepUpCode).toHaveBeenCalledWith({
      accountId: "acct_1",
      messageId: "message-edit-retry",
      now: new Date("2026-07-28T12:01:00Z"),
    });
  });
});

describe("the delivery worker routes by template key", () => {
  const source = readFileSync(
    new URL("../modules/communications/email-delivery.ts", import.meta.url),
    "utf8",
  );

  it("carries the attendee recipient through the claim", () => {
    // The eventless slice of the outbox holds both populations now. Without
    // this column on the claim, an attendee message reaches the preparer with
    // no account and its sentinel goes out verbatim.
    expect(source).toContain("accountAttendeeId: true");
    expect(source).toContain("accountAttendeeId: message.accountAttendeeId");
  });

  it("chooses the code preparer for an attendee verification", () => {
    expect(source).toContain('input.templateKey?.startsWith("ATTENDEE_")');
    expect(source).toContain("prepareAttendeeEmailBodyForDelivery");
  });
});
