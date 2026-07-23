import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  EmailProviderRequestError,
  sendEmailWithResend,
} from "@/integrations/email/resend";

const input = {
  fromName: "IMSDA Events",
  fromEmail: "registration@imsda.org",
  toEmail: "attendee@example.test",
  replyToEmail: "help@imsda.org",
  subject: "Registration received",
  bodyText: "Your registration is saved.",
  idempotencyKey: "message/msg_123/attempt_1",
  messageId: "msg_123",
};

describe("Resend email adapter", () => {
  it("sends the immutable message snapshot with provider idempotency", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ id: "email_provider_123" }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    await expect(sendEmailWithResend(
      input,
      { apiKey: "re_test_only", apiUrl: "https://api.resend.test" },
      request,
    )).resolves.toEqual({
      provider: "RESEND",
      providerMessageId: "email_provider_123",
    });

    expect(request).toHaveBeenCalledOnce();
    const [url, options] = request.mock.calls[0];
    expect(url).toBe("https://api.resend.test/emails");
    expect(options?.headers).toMatchObject({
      Authorization: "Bearer re_test_only",
      "Idempotency-Key": input.idempotencyKey,
    });
    expect(JSON.parse(String(options?.body))).toMatchObject({
      from: "IMSDA Events <registration@imsda.org>",
      to: ["attendee@example.test"],
      reply_to: "help@imsda.org",
      subject: "Registration received",
      text: "Your registration is saved.",
    });
  });

  it("marks throttling and provider outages as retryable", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ name: "rate_limit_exceeded", message: "Try again later." }),
      { status: 429, headers: { "content-type": "application/json" } },
    ));

    await expect(sendEmailWithResend(
      input,
      { apiKey: "re_test_only", apiUrl: "https://api.resend.test" },
      request,
    )).rejects.toEqual(expect.objectContaining<Partial<EmailProviderRequestError>>({
      code: "rate_limit_exceeded",
      retryable: true,
      status: 429,
    }));
  });

  it("rejects missing sender configuration before making a request", async () => {
    const request = vi.fn<typeof fetch>();
    await expect(sendEmailWithResend(
      { ...input, fromEmail: "" },
      { apiKey: "re_test_only", apiUrl: "https://api.resend.test" },
      request,
    )).rejects.toThrow("verified sender email");
    expect(request).not.toHaveBeenCalled();
  });
});
