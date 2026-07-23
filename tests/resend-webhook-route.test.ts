import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class ConfigurationError extends Error {}
  class VerificationError extends Error {}
  return {
    ConfigurationError,
    VerificationError,
    verifyResendWebhook: vi.fn(),
    recordResendWebhookEvent: vi.fn(),
  };
});

vi.mock("@/integrations/email/resend-webhook", () => ({
  ResendWebhookConfigurationError: mocks.ConfigurationError,
  ResendWebhookVerificationError: mocks.VerificationError,
  verifyResendWebhook: mocks.verifyResendWebhook,
}));
vi.mock("@/modules/communications/resend-webhook-repository", () => ({
  recordResendWebhookEvent: mocks.recordResendWebhookEvent,
}));

import { POST } from "@/app/api/webhooks/resend/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyResendWebhook.mockReturnValue({
    providerEventId: "webhook-1",
    event: {
      type: "email.delivered",
      created_at: "2026-07-23T12:00:00.000Z",
      data: { email_id: "email-provider-1" },
    },
  });
  mocks.recordResendWebhookEvent.mockResolvedValue({
    duplicate: false,
    matchedMessageId: "message-1",
    mappedStatus: "DELIVERED",
  });
});

describe("Resend webhook route", () => {
  it("passes the unmodified raw body through verification and accepts duplicates", async () => {
    const rawBody = '{ "type": "email.delivered", "spacing": true }';
    mocks.recordResendWebhookEvent.mockResolvedValue({
      duplicate: true,
      matchedMessageId: "message-1",
      mappedStatus: "DELIVERED",
    });
    const request = new Request("https://events.imsda.test/api/webhooks/resend", {
      method: "POST",
      headers: {
        "svix-id": "webhook-1",
        "svix-timestamp": "1784808000",
        "svix-signature": "v1,test",
      },
      body: rawBody,
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(mocks.verifyResendWebhook).toHaveBeenCalledWith(
      rawBody,
      request.headers,
    );
    expect(await response.json()).toEqual({
      received: true,
      duplicate: true,
    });
  });

  it("returns 400 without writing when signature verification fails", async () => {
    mocks.verifyResendWebhook.mockImplementation(() => {
      throw new mocks.VerificationError("invalid");
    });
    const response = await POST(new Request(
      "https://events.imsda.test/api/webhooks/resend",
      { method: "POST", body: "{}" },
    ));
    expect(response.status).toBe(400);
    expect(mocks.recordResendWebhookEvent).not.toHaveBeenCalled();
  });
});
