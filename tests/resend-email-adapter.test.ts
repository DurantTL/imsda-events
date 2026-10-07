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

  it("sends an attachment base64 encoded to the provider, and none when there is none (#168)", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ id: "email_provider_123" }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const configuration = { apiKey: "re_test_only", apiUrl: "https://api.resend.test" };
    const bytes = Buffer.from("%PDF-1.7 synthetic");

    await sendEmailWithResend({ ...input, attachments: [{ filename: "Invoice-SC27-0001.pdf", contentType: "application/pdf", content: bytes }] }, configuration, request);
    const withFile = JSON.parse(String(request.mock.calls[0][1]?.body));
    expect(withFile.attachments).toEqual([{ filename: "Invoice-SC27-0001.pdf", content: bytes.toString("base64"), content_type: "application/pdf" }]);

    await sendEmailWithResend(input, configuration, request);
    expect(JSON.parse(String(request.mock.calls[1][1]?.body))).not.toHaveProperty("attachments");
  });

  it("sends an inline image with a content_id and a plain attachment without one (#824)", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ id: "email_provider_123" }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const configuration = { apiKey: "re_test_only", apiUrl: "https://api.resend.test" };
    const pdf = Buffer.from("%PDF-1.7 synthetic");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

    await sendEmailWithResend({
      ...input,
      bodyHtml: '<img src="cid:abc@imsda-events" alt="QR" />',
      attachments: [
        { filename: "Agenda.pdf", contentType: "application/pdf", content: pdf },
        { filename: "check-in-qr.png", contentType: "image/png", content: png, contentId: "abc@imsda-events" },
      ],
    }, configuration, request);
    const body = JSON.parse(String(request.mock.calls[0][1]?.body));
    expect(body.attachments).toEqual([
      { filename: "Agenda.pdf", content: pdf.toString("base64"), content_type: "application/pdf" },
      { filename: "check-in-qr.png", content: png.toString("base64"), content_type: "image/png", content_id: "abc@imsda-events" },
    ]);
    expect(body.html).toContain("cid:abc@imsda-events");
  });

  it("sends an HTML part alongside the text fallback, and omits it when absent", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ id: "email_provider_123" }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const configuration = { apiKey: "re_test_only", apiUrl: "https://api.resend.test" };

    await sendEmailWithResend(
      { ...input, bodyHtml: "<!DOCTYPE html><html><body>Saved.</body></html>" },
      configuration,
      request,
    );
    const withHtml = JSON.parse(String(request.mock.calls[0]![1]?.body));
    expect(withHtml.html).toBe("<!DOCTYPE html><html><body>Saved.</body></html>");
    // The plain-text part is never replaced by the HTML one.
    expect(withHtml.text).toBe("Your registration is saved.");

    await sendEmailWithResend(input, configuration, request);
    expect(JSON.parse(String(request.mock.calls[1]![1]?.body))).not.toHaveProperty("html");
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
