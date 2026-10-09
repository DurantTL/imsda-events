import nodemailer from "nodemailer";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { sendEmailWithResend } from "@/integrations/email/resend";
import { buildSesMailOptions, type SesEmailConfiguration } from "@/integrations/email/ses";
import { listUnsubscribeHeaders } from "@/integrations/email/types";
import {
  announcementOptOutFor,
  createUnsubscribeToken,
  isOptOutEligibleTemplate,
  maskEmailAddress,
  normalizeEmailAddress,
  unsubscribeSigningSecrets,
  verifyUnsubscribeToken,
} from "@/modules/communications/email-preferences";

const SECRET = "synthetic-signing-secret-at-least-32-chars-long";
const OTHER_SECRET = "another-synthetic-secret-at-least-32-chars";

describe("unsubscribe tokens (#838)", () => {
  it("round-trips an address and an event, normalising the address", () => {
    const token = createUnsubscribeToken({ email: "  Avery@Example.TEST ", eventId: "event-1" }, SECRET);
    expect(verifyUnsubscribeToken(token, [SECRET])).toEqual({ email: "avery@example.test", eventId: "event-1" });
  });

  it("is URL-safe and carries no registration data", () => {
    const token = createUnsubscribeToken({ email: "avery@example.test", eventId: "event-1" }, SECRET);
    expect(token).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    expect(Object.keys(payload).sort()).toEqual(["e", "v"]);
  });

  it("is different for every address and event", () => {
    const tokens = new Set([
      createUnsubscribeToken({ email: "a@example.test", eventId: "event-1" }, SECRET),
      createUnsubscribeToken({ email: "b@example.test", eventId: "event-1" }, SECRET),
      createUnsubscribeToken({ email: "a@example.test", eventId: "event-2" }, SECRET),
    ]);
    expect(tokens.size).toBe(3);
  });

  it("refuses a tampered payload, a swapped signature, another secret, and malformed input", () => {
    const token = createUnsubscribeToken({ email: "avery@example.test", eventId: "event-1" }, SECRET);
    const [version, payload, signature] = token.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ e: "someone-else@example.test", v: "event-1" })).toString("base64url");
    expect(verifyUnsubscribeToken(`${version}.${forgedPayload}.${signature}`, [SECRET])).toBeNull();
    const other = createUnsubscribeToken({ email: "avery@example.test", eventId: "event-2" }, SECRET);
    expect(verifyUnsubscribeToken(`${version}.${payload}.${other.split(".")[2]}`, [SECRET])).toBeNull();
    expect(verifyUnsubscribeToken(token, [OTHER_SECRET])).toBeNull();
    expect(verifyUnsubscribeToken(`${token}x`, [SECRET])).toBeNull();
    expect(verifyUnsubscribeToken(`v2.${payload}.${signature}`, [SECRET])).toBeNull();
    expect(verifyUnsubscribeToken("", [SECRET])).toBeNull();
    expect(verifyUnsubscribeToken("not-a-token", [SECRET])).toBeNull();
    expect(verifyUnsubscribeToken(`${version}.${payload}`, [SECRET])).toBeNull();
    expect(verifyUnsubscribeToken("a".repeat(5000), [SECRET])).toBeNull();
  });

  it("is not interchangeable with a registration link derived from the same secret", async () => {
    const { createHmac } = await import("node:crypto");
    const payload = Buffer.from(JSON.stringify({ e: "avery@example.test", v: "event-1" })).toString("base64url");
    const registrationStyle = createHmac("sha256", SECRET).update(`imsda:manage-link:v1:${payload}`).digest("base64url");
    expect(verifyUnsubscribeToken(`v1.${payload}.${registrationStyle}`, [SECRET])).toBeNull();
  });

  it("verifies against the previous secret during a rotation, and signs with the current one", () => {
    const secrets = unsubscribeSigningSecrets({ MANAGE_LINK_DERIVATION_SECRET: SECRET, MANAGE_LINK_DERIVATION_SECRET_PREVIOUS: OTHER_SECRET });
    expect(secrets).toEqual([SECRET, OTHER_SECRET]);
    const oldToken = createUnsubscribeToken({ email: "avery@example.test", eventId: "event-1" }, OTHER_SECRET);
    expect(verifyUnsubscribeToken(oldToken, secrets)).not.toBeNull();
  });

  it("refuses to sign in production without a long enough secret", () => {
    expect(() => unsubscribeSigningSecrets({ NODE_ENV: "production", MANAGE_LINK_DERIVATION_SECRET: "short" })).toThrow(/32 characters/);
    expect(unsubscribeSigningSecrets({ NODE_ENV: "development" })).toHaveLength(1);
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
