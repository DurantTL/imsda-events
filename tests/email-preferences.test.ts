import nodemailer from "nodemailer";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { sendEmailWithResend } from "@/integrations/email/resend";
import { buildSesMailOptions, type SesEmailConfiguration } from "@/integrations/email/ses";
import { listUnsubscribeHeaders } from "@/integrations/email/types";
import {
  announcementOptOutFor,
  deriveUnsubscribeToken,
  hashUnsubscribeToken,
  isOptOutEligibleTemplate,
  isWellFormedUnsubscribeToken,
  maskEmailAddress,
  normalizeEmailAddress,
  unsubscribeHeadersAllowed,
  unsubscribeSigningSecret,
} from "@/modules/communications/email-preferences";

const SECRET = "synthetic-signing-secret-at-least-32-chars-long";
const OTHER_SECRET = "another-synthetic-secret-at-least-32-chars";

describe("opaque unsubscribe tokens (#838)", () => {
  const subject = { email: "  Avery@Example.TEST ", eventId: "event-1" };

  it("is 43 URL-safe characters that reveal nothing: no address, event, or readable payload", () => {
    const token = deriveUnsubscribeToken(subject, SECRET);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isWellFormedUnsubscribeToken(token)).toBe(true);
    const decoded = Buffer.from(token, "base64url").toString("latin1");
    expect(token.toLowerCase()).not.toContain("avery");
    expect(token).not.toContain("event-1");
    expect(token).not.toContain(".");
    expect(decoded).not.toMatch(/avery|event-1|example/i);
  });

  it("is stable for an address and event (normalised), and different for every other pair", () => {
    const token = deriveUnsubscribeToken(subject, SECRET);
    expect(deriveUnsubscribeToken({ email: "avery@example.test", eventId: "event-1" }, SECRET)).toBe(token);
    expect(new Set([
      token,
      deriveUnsubscribeToken({ email: "b@example.test", eventId: "event-1" }, SECRET),
      deriveUnsubscribeToken({ email: "avery@example.test", eventId: "event-2" }, SECRET),
      deriveUnsubscribeToken(subject, OTHER_SECRET),
    ]).size).toBe(4);
  });

  it("cannot be confused across the address and event boundary", () => {
    expect(deriveUnsubscribeToken({ email: "a@b.test", eventId: "cde" }, SECRET))
      .not.toBe(deriveUnsubscribeToken({ email: "a@b.testc", eventId: "de" }, SECRET));
  });

  it("is not a registration link derived from the same secret", async () => {
    const { createHmac } = await import("node:crypto");
    const registrationStyle = createHmac("sha256", SECRET).update("imsda:manage-link:v1:avery@example.test").digest("base64url");
    expect(deriveUnsubscribeToken(subject, SECRET)).not.toBe(registrationStyle);
  });

  it("rejects anything that is not the shape of a token before any lookup", () => {
    for (const bad of ["", "not-a-token", "a".repeat(42), "a".repeat(44), `${"a".repeat(42)}.`, `${"a".repeat(42)}=`, "v1.abc.def", undefined, 5]) {
      expect(isWellFormedUnsubscribeToken(bad)).toBe(false);
    }
  });

  it("stores only a hash, so a copy of the table cannot unsubscribe anyone", () => {
    const token = deriveUnsubscribeToken(subject, SECRET);
    const hash = hashUnsubscribeToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(isWellFormedUnsubscribeToken(hash)).toBe(false);
  });

  it("reads the current secret, and refuses to issue in production without a long enough one", () => {
    expect(unsubscribeSigningSecret({ MANAGE_LINK_DERIVATION_SECRET: SECRET })).toBe(SECRET);
    expect(() => unsubscribeSigningSecret({ NODE_ENV: "production", MANAGE_LINK_DERIVATION_SECRET: "short" })).toThrow(/32 characters/);
    expect(unsubscribeSigningSecret({ NODE_ENV: "development" })).toBeTruthy();
  });
});

describe("one-click headers need https in production (#838)", () => {
  it("omits them only for a non-https base URL in production", () => {
    expect(unsubscribeHeadersAllowed("https://events.imsda.org", "production")).toBe(true);
    expect(unsubscribeHeadersAllowed("http://events.imsda.org", "production")).toBe(false);
    expect(unsubscribeHeadersAllowed("http://localhost:3000", "development")).toBe(true);
    expect(unsubscribeHeadersAllowed("http://localhost:3000", undefined)).toBe(true);
  });
});

describe("opt-out rules (#838)", () => {
  const rows = [
    { normalizedEmail: "one@example.test", scope: "EVENT" as const, eventId: "event-1" },
    { normalizedEmail: "two@example.test", scope: "ALL" as const, eventId: null },
  ];

  it("matches on the normalised address, per event, with a global opt-out covering every event", () => {
    expect(announcementOptOutFor(rows, " One@Example.test", "event-1")).toBe("EVENT");
    expect(announcementOptOutFor(rows, "one@example.test", "event-2")).toBeNull();
    expect(announcementOptOutFor(rows, "two@example.test", "event-1")).toBe("ALL");
    expect(announcementOptOutFor(rows, "two@example.test", "event-9")).toBe("ALL");
    expect(announcementOptOutFor(rows, "three@example.test", "event-1")).toBeNull();
  });

  it("reports the global opt-out when an address has both", () => {
    expect(announcementOptOutFor([
      { normalizedEmail: "x@example.test", scope: "EVENT", eventId: "event-1" },
      { normalizedEmail: "x@example.test", scope: "ALL", eventId: null },
    ], "x@example.test", "event-1")).toBe("ALL");
  });

  it("applies only to event announcements", () => {
    expect(isOptOutEligibleTemplate("EVENT_ANNOUNCEMENT")).toBe(true);
    for (const key of [
      "REGISTRATION_CONFIRMATION_PAID", "REGISTRATION_CONFIRMATION_UNPAID", "PAYMENT_RECEIPT", "BALANCE_REMINDER",
      "WAITLIST_JOINED", "WAITLIST_PROMOTED", "REGISTRATION_TRANSFERRED_NEW_CONTACT", "REGISTRATION_TRANSFERRED_PRIOR_CONTACT",
      "ATTENDEE_SUBSTITUTED", "REGISTRATION_ACCESS_RECOVERY", "CUSTOM_MESSAGE",
    ]) {
      expect(isOptOutEligibleTemplate(key)).toBe(false);
    }
  });

  it("masks an address for the public page", () => {
    expect(maskEmailAddress("Avery@Example.test")).toBe("av***@example.test");
    expect(maskEmailAddress("a@example.test")).toBe("a***@example.test");
    expect(maskEmailAddress("not-an-email")).toBe("***");
    expect(normalizeEmailAddress(" A@B.C ")).toBe("a@b.c");
  });
});

describe("one-click unsubscribe headers on both providers (#838)", () => {
  const url = "https://events.imsda.test/api/public/unsubscribe/v1.abc.def";
  const input = {
    fromName: "IMSDA Events",
    fromEmail: "registration@imsda.org",
    toEmail: "attendee@example.test",
    subject: "Friday arrival information",
    bodyText: "Doors open at 5 p.m.",
    idempotencyKey: "outbox:msg_1",
    messageId: "msg_1",
  };

  it("builds the RFC 2369 and RFC 8058 pair", () => {
    expect(listUnsubscribeHeaders({ url })).toEqual({
      "List-Unsubscribe": `<${url}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    expect(listUnsubscribeHeaders(null)).toEqual({});
  });

  it("refuses a URL that could break out of the header", () => {
    for (const bad of ["https://x.test/a>\r\nBcc: evil@example.test", "javascript:alert(1)", "https://x.test/a b", ""]) {
      expect(() => listUnsubscribeHeaders({ url: bad })).toThrow();
    }
  });

  it("sends the headers through Resend", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id: "email_1" }), { status: 200, headers: { "content-type": "application/json" } }));
    await sendEmailWithResend({ ...input, listUnsubscribe: { url } }, { apiKey: "re_test_only", apiUrl: "https://api.resend.test" }, request);
    const body = JSON.parse(String(request.mock.calls[0][1]?.body));
    expect(body.headers).toEqual({ "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
  });

  it("sends no headers through Resend for a message without an unsubscribe link", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id: "email_1" }), { status: 200, headers: { "content-type": "application/json" } }));
    await sendEmailWithResend(input, { apiKey: "re_test_only", apiUrl: "https://api.resend.test" }, request);
    expect(JSON.parse(String(request.mock.calls[0][1]?.body))).not.toHaveProperty("headers");
  });

  it("puts the headers in the SES MIME message", async () => {
    const configuration: SesEmailConfiguration = {
      smtpHost: "127.0.0.1", smtpPort: 2587, username: "u", password: "p", region: "us-east-2", configurationSet: null, maxSendRate: 10,
    };
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" });
    // Long header values are folded onto a continuation line; unfold before comparing.
    const mime = ((await transport.sendMail(buildSesMailOptions({ ...input, listUnsubscribe: { url } }, configuration))).message as Buffer).toString("utf8").replace(/\n[ \t]+/g, " ");
    expect(mime).toContain(`List-Unsubscribe: <${url}>`);
    expect(mime).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    const plain = ((await transport.sendMail(buildSesMailOptions(input, configuration))).message as Buffer).toString("utf8");
    expect(plain).not.toMatch(/List-Unsubscribe/i);
  });
});
