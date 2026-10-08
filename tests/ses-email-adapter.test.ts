import nodemailer from "nodemailer";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  getActiveEmailProviderName,
  getEmailAvailability,
  getEmailConfiguration,
} from "@/integrations/email/provider";
import {
  buildSesMailOptions,
  createSendPacer,
  getSesEmailConfiguration,
  mapSesError,
  sendEmailWithSes,
  type SesEmailConfiguration,
} from "@/integrations/email/ses";
import {
  EmailProviderConfigurationError,
  EmailProviderRequestError,
} from "@/integrations/email/types";

const configuration: SesEmailConfiguration = {
  smtpHost: "127.0.0.1",
  smtpPort: 2587,
  username: "synthetic-smtp-user",
  password: "synthetic-smtp-password",
  region: "us-east-2",
  configurationSet: null,
  maxSendRate: 10,
};

const input = {
  fromName: "IMSDA Events",
  fromEmail: "Registration@IMSDA.org",
  toEmail: "attendee@example.test",
  replyToEmail: "help@imsda.org",
  subject: "Registration received",
  bodyText: "Your registration is saved.",
  idempotencyKey: "outbox:msg_123",
  messageId: "msg_123",
};

async function rawMime(options: Parameters<typeof buildSesMailOptions>[0], overrides: Partial<SesEmailConfiguration> = {}) {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" });
  const info = await transport.sendMail(buildSesMailOptions(options, { ...configuration, ...overrides }));
  return (info.message as Buffer).toString("utf8");
}

afterEach(() => vi.unstubAllEnvs());

describe("SES MIME building", () => {
  it("carries text, HTML, reply-to, and a stable message id", async () => {
    const mime = await rawMime({ ...input, bodyHtml: "<p>Saved.</p>" });
    expect(mime).toContain("From: IMSDA Events <registration@imsda.org>");
    expect(mime).toContain("To: attendee@example.test");
    expect(mime).toContain("Reply-To: help@imsda.org");
    expect(mime).toContain("Subject: Registration received");
    expect(mime).toContain("Message-ID: <msg_123@imsda.org>");
    expect(mime).toMatch(/x-imsda-message-id: msg_123/i);
    expect(mime).toContain("text/plain");
    expect(mime).toContain("text/html");
    expect(mime).toContain("Your registration is saved.");
  });

  it("sends plain text alone when there is no HTML", async () => {
    const mime = await rawMime(input);
    expect(mime).toContain("text/plain");
    expect(mime).not.toContain("text/html");
  });

  it("sends an attachment and an inline CID image", async () => {
    const mime = await rawMime({
      ...input,
      bodyHtml: '<img src="cid:qr-1">',
      attachments: [
        { filename: "invoice.pdf", contentType: "application/pdf", content: Buffer.from("%PDF-1.7 synthetic") },
        { filename: "qr.png", contentType: "image/png", content: Buffer.from("png-bytes"), contentId: "qr-1" },
      ],
    });
    expect(mime).toContain("filename=invoice.pdf");
    expect(mime).toContain("Content-Type: application/pdf");
    expect(mime).toContain(Buffer.from("%PDF-1.7 synthetic").toString("base64"));
    expect(mime).toContain("Content-ID: <qr-1>");
    expect(mime).toContain("Content-Disposition: inline");
    expect(mime).toContain("multipart/related");
  });

  it("adds the configuration set header only when one is configured", async () => {
    expect(await rawMime(input)).not.toMatch(/x-ses-configuration-set/i);
    expect(await rawMime(input, { configurationSet: "events-set" })).toMatch(/x-ses-configuration-set: events-set/i);
  });

  it("blocks header injection through the sender, subject, reply-to, filename, and message id", async () => {
    const mime = await rawMime({
      ...input,
      fromName: "Evil\r\nBcc: victim@example.test",
      subject: "Hello\r\nBcc: victim2@example.test",
      replyToEmail: "help@imsda.org\r\nBcc: victim3@example.test",
      messageId: "msg\r\nBcc: victim4@example.test",
      attachments: [{ filename: "a.pdf\r\nBcc: victim5@example.test", contentType: "application/pdf", content: Buffer.from("x") }],
    });
    expect(mime).not.toMatch(/^Bcc:/im);
  });
});

describe("SES sending", () => {
  it("returns the SES message id from the 250 reply", async () => {
    const sendMail = vi.fn(async () => ({ response: "250 Ok 0100019abc-def-000000", messageId: "<x@y>" }));
    const pace = vi.fn(async () => {});
    await expect(sendEmailWithSes(input, configuration, { transport: { sendMail }, pace })).resolves.toEqual({
      provider: "SES",
      providerMessageId: "0100019abc-def-000000",
    });
    expect(pace).toHaveBeenCalledWith(10);
  });

  it("requires a sender and a bounded idempotency key", async () => {
    const transport = { sendMail: vi.fn() };
    await expect(sendEmailWithSes({ ...input, fromEmail: " " }, configuration, { transport, pace: async () => {} }))
      .rejects.toBeInstanceOf(EmailProviderConfigurationError);
    await expect(sendEmailWithSes({ ...input, idempotencyKey: "" }, configuration, { transport, pace: async () => {} }))
      .rejects.toThrow(/idempotency/i);
    expect(transport.sendMail).not.toHaveBeenCalled();
  });

  it("refuses a recipient or reply-to that is not exactly one address, as a final error", async () => {
    const transport = { sendMail: vi.fn() };
    for (const overrides of [
      { toEmail: "a@example.test, b@example.test" },
      { toEmail: "Name <a@example.test>" },
      { replyToEmail: "help@imsda.org, other@example.test" },
    ]) {
      const failure = await sendEmailWithSes({ ...input, ...overrides }, configuration, { transport, pace: async () => {} }).catch((e) => e);
      expect(failure).toBeInstanceOf(EmailProviderRequestError);
      expect(failure).toMatchObject({ code: "INVALID_ADDRESS", retryable: false });
    }
    expect(transport.sendMail).not.toHaveBeenCalled();
  });

  it("maps a transport failure without leaking credentials or the message", async () => {
    const error = Object.assign(new Error("Daily message quota exceeded. synthetic-smtp-password"), { responseCode: 454 });
    const sendMail = vi.fn(async () => { throw error; });
    const failure = await sendEmailWithSes(input, configuration, { transport: { sendMail }, pace: async () => {} }).catch((e) => e);
    expect(failure).toBeInstanceOf(EmailProviderRequestError);
    expect(failure.code).toBe("PROVIDER_QUOTA");
    expect(failure.message).not.toContain("synthetic-smtp-password");
  });
});

describe("SES error mapping", () => {
  const smtp = (responseCode: number | undefined, response: string, code?: string) =>
    Object.assign(new Error(response), { responseCode, response, code });

  it("treats throttling as retryable", () => {
    const mapped = mapSesError(smtp(454, "454 Throttling failure: Maximum sending rate exceeded."));
    expect(mapped).toMatchObject({ code: "PROVIDER_RATE_LIMITED", retryable: true, status: 454 });
  });

  it("maps the daily quota to PROVIDER_QUOTA, retryable", () => {
    const mapped = mapSesError(smtp(454, "454 Throttling failure: Daily message quota exceeded."));
    expect(mapped).toMatchObject({ code: "PROVIDER_QUOTA", retryable: true });
  });

  it("retries any other 4xx", () => {
    expect(mapSesError(smtp(421, "421 Service not available"))).toMatchObject({ code: "SMTP_421", retryable: true });
  });

  it("treats network and TLS failures as retryable", () => {
    for (const code of ["ECONNECTION", "ETIMEDOUT", "ESOCKET", "ECONNREFUSED", "EDNS", "ETLS"]) {
      expect(mapSesError(smtp(undefined, "boom", code))).toMatchObject({ code: "NETWORK_ERROR", retryable: true, status: 0 });
    }
  });

  it("treats a failed STARTTLS upgrade as a transport fault even with a 5xx reply", () => {
    expect(mapSesError(smtp(500, "Error upgrading connection with STARTTLS", "ETLS"))).toMatchObject({ code: "NETWORK_ERROR", retryable: true });
  });

  it("treats 554 rejections as final with a staff-readable message", () => {
    const mapped = mapSesError(smtp(554, "554 Message rejected: Email address is not verified. The following identities failed the check"));
    expect(mapped).toMatchObject({ code: "SES_IDENTITY_NOT_VERIFIED", retryable: false });
    expect(mapped.message).toMatch(/verified domain/);
    expect(mapSesError(smtp(554, "554 Message rejected: Sending paused"))).toMatchObject({ code: "SES_MESSAGE_REJECTED", retryable: false });
  });

  it("retries a temporary authentication failure, but not a rejected password", () => {
    expect(mapSesError(smtp(454, "454 4.7.0 Temporary authentication failure", "EAUTH")))
      .toMatchObject({ code: "SES_AUTH_TEMPORARY", retryable: true, status: 454 });
    expect(mapSesError(smtp(535, "535 Authentication Credentials Invalid", "EAUTH"))).toBeInstanceOf(EmailProviderConfigurationError);
    expect(mapSesError(smtp(534, "534 mechanism too weak", "EAUTH"))).toBeInstanceOf(EmailProviderConfigurationError);
  });

  it("keeps timeouts and resets retryable, and an unrecognised fault final", () => {
    for (const code of ["ETIMEDOUT", "ECONNRESET", "EPIPE"]) {
      expect(mapSesError(smtp(undefined, "boom", code))).toMatchObject({ retryable: true });
    }
    for (const code of ["ERR_STREAM_PREMATURE_CLOSE", "EADDRNOTAVAIL", "ERR_SSL_WRONG_VERSION_NUMBER"]) {
      expect(mapSesError(smtp(undefined, "boom", code))).toMatchObject({ code: "NETWORK_ERROR", retryable: true });
    }
    expect(mapSesError(smtp(undefined, "bad", "EENVELOPE"))).toMatchObject({ code: "INVALID_MESSAGE", retryable: false });
    expect(mapSesError(new Error("something odd"))).toMatchObject({ code: "UNEXPECTED_PROVIDER_ERROR", retryable: false });
  });

  it("treats authentication failure as a configuration error", () => {
    expect(mapSesError(smtp(535, "535 Authentication Credentials Invalid", "EAUTH"))).toBeInstanceOf(EmailProviderConfigurationError);
    expect(mapSesError(smtp(undefined, "Invalid login", "EAUTH"))).toBeInstanceOf(EmailProviderConfigurationError);
  });
});

describe("SES pacing", () => {
  it("spaces starts by 1/rate and does not delay a lone send", async () => {
    let clock = 1_000;
    const sleeps: number[] = [];
    const pace = createSendPacer({
      now: () => clock,
      sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    });
    await pace(10);
    expect(sleeps).toEqual([]);
    await pace(10);
    await pace(10);
    expect(sleeps).toEqual([100, 100]);
    clock += 5_000;
    await pace(10);
    expect(sleeps).toEqual([100, 100]);
  });

  it("holds a 50-message batch to the configured rate", async () => {
    let clock = 0;
    const pace = createSendPacer({ now: () => clock, sleep: async (ms) => { clock += ms; } });
    for (let i = 0; i < 50; i += 1) await pace(10);
    expect(clock).toBe(4_900);
  });

  it("reserves distinct slots for concurrent callers", async () => {
    const clock = 0;
    const waits: number[] = [];
    const pace = createSendPacer({ now: () => clock, sleep: async (ms) => { waits.push(ms); } });
    await Promise.all([pace(5), pace(5), pace(5)]);
    expect(waits).toEqual([200, 400]);
  });
});

describe("provider switch", () => {
  it("defaults to Resend when EMAIL_PROVIDER is unset or blank", () => {
    vi.stubEnv("EMAIL_PROVIDER", "");
    vi.stubEnv("RESEND_API_KEY", "re_test_only");
    expect(getActiveEmailProviderName()).toBe("RESEND");
    expect(getEmailAvailability().deliveryConfigured).toBe(true);
    expect(getEmailConfiguration()).toMatchObject({ apiKey: "re_test_only" });
  });

  it("selects SES and reads its configuration", () => {
    vi.stubEnv("EMAIL_PROVIDER", "ses");
    vi.stubEnv("SES_REGION", "us-east-2");
    vi.stubEnv("SES_SMTP_USERNAME", "u");
    vi.stubEnv("SES_SMTP_PASSWORD", "p");
    expect(getActiveEmailProviderName()).toBe("SES");
    expect(getEmailAvailability()).toEqual({ deliveryConfigured: true, webhookConfigured: false });
    expect(getEmailConfiguration()).toMatchObject({
      smtpHost: "email-smtp.us-east-2.amazonaws.com",
      smtpPort: 587,
      maxSendRate: 10,
      configurationSet: null,
    });
  });

  it("reports SES as unconfigured without credentials and refuses to build a configuration", () => {
    vi.stubEnv("EMAIL_PROVIDER", "ses");
    vi.stubEnv("SES_REGION", "us-east-2");
    vi.stubEnv("SES_SMTP_USERNAME", "");
    vi.stubEnv("SES_SMTP_PASSWORD", "");
    expect(getEmailAvailability().deliveryConfigured).toBe(false);
    expect(() => getSesEmailConfiguration()).toThrow(EmailProviderConfigurationError);
  });

  it("rejects a bad region, port, or rate rather than building a host from it", () => {
    vi.stubEnv("SES_SMTP_USERNAME", "u");
    vi.stubEnv("SES_SMTP_PASSWORD", "p");
    vi.stubEnv("SES_REGION", "us-east-2.evil.example");
    expect(() => getSesEmailConfiguration()).toThrow(/region/i);
    vi.stubEnv("SES_REGION", "us-east-2");
    vi.stubEnv("SES_SMTP_PORT", "99999");
    expect(() => getSesEmailConfiguration()).toThrow(/port/i);
    vi.stubEnv("SES_SMTP_PORT", "");
    vi.stubEnv("SES_MAX_SEND_RATE", "0");
    expect(() => getSesEmailConfiguration()).toThrow(/SES_MAX_SEND_RATE/);
  });

  it("does not silently route an unknown provider value", () => {
    vi.stubEnv("EMAIL_PROVIDER", "mailgun");
    expect(getEmailAvailability().deliveryConfigured).toBe(false);
    expect(() => getEmailConfiguration()).toThrow(EmailProviderConfigurationError);
  });
});
