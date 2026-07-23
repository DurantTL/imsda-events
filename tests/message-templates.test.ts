import { describe, expect, it } from "vitest";
import {
  ALLOWED_MESSAGE_TEMPLATE_TOKENS,
  DEFAULT_MESSAGE_TEMPLATE_LIST,
  DEFAULT_MESSAGE_TEMPLATES,
  MESSAGE_TEMPLATE_KEYS,
  MESSAGE_TEMPLATE_TOKEN_KEYS,
  SAMPLE_MESSAGE_TEMPLATE_CONTEXT,
  extractMessageTemplateTokens,
  formatMessageDateRange,
  formatMessageMoney,
  formatMessageTemplateToken,
  renderMessageTemplate,
  renderTemplateText,
  selectRegistrationMessageTemplate,
  validateMessageTemplate,
} from "@/modules/communications/templates";

describe("message templates", () => {
  it("ships thirteen valid plaintext defaults", () => {
    expect(MESSAGE_TEMPLATE_KEYS).toEqual([
      "REGISTRATION_CONFIRMATION_PAID",
      "REGISTRATION_CONFIRMATION_UNPAID",
      "WORKER_CONFIRMATION",
      "INTERNAL_NEW_REGISTRATION",
      "WAITLIST_JOINED",
      "WAITLIST_PROMOTED",
      "REGISTRATION_CANCELLED",
      "REGISTRATION_CONTACT_UPDATED",
      "PAYMENT_RECEIPT",
      "BALANCE_REMINDER",
      "REGISTRATION_TRANSFERRED_NEW_CONTACT",
      "REGISTRATION_TRANSFERRED_PRIOR_CONTACT",
      "ATTENDEE_SUBSTITUTED",
    ]);
    expect(DEFAULT_MESSAGE_TEMPLATE_LIST).toHaveLength(13);

    for (const key of MESSAGE_TEMPLATE_KEYS) {
      const template = DEFAULT_MESSAGE_TEMPLATES[key];
      expect(template.key).toBe(key);
      expect(template.name).not.toBe("");
      expect(template.description).not.toBe("");
      expect(validateMessageTemplate(template)).toEqual({
        isValid: true,
        issues: [],
        unknownTokens: [],
      });
    }
  });

  it("publishes the allowed token set and formats tokens for insertion", () => {
    expect([...ALLOWED_MESSAGE_TEMPLATE_TOKENS]).toEqual(MESSAGE_TEMPLATE_TOKEN_KEYS);
    expect(ALLOWED_MESSAGE_TEMPLATE_TOKENS.has("registrant_name")).toBe(true);
    expect(ALLOWED_MESSAGE_TEMPLATE_TOKENS.has("reply_to_email")).toBe(true);
    expect(formatMessageTemplateToken("confirmation_code")).toBe("{{confirmation_code}}");
  });

  it("rejects unknown tokens in either field and line breaks in a subject", () => {
    const result = validateMessageTemplate({
      subject: "Hello {{mystery_token}}\r\nBcc: someone@example.test",
      body: "Known: {{event_name}}\nUnknown: {{other_token}}",
    });

    expect(result.isValid).toBe(false);
    expect(result.unknownTokens).toEqual(["mystery_token", "other_token"]);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "subject", code: "SUBJECT_LINE_BREAK" }),
        expect.objectContaining({
          field: "subject",
          code: "UNKNOWN_TOKEN",
          token: "mystery_token",
        }),
        expect.objectContaining({
          field: "body",
          code: "UNKNOWN_TOKEN",
          token: "other_token",
        }),
      ]),
    );
  });

  it("reports empty subjects and bodies", () => {
    const result = validateMessageTemplate({ subject: "  ", body: "\n" });
    expect(result.isValid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(["REQUIRED", "REQUIRED"]);
  });

  it("extracts tokens once in first-use order", () => {
    expect(
      extractMessageTemplateTokens(
        "{{event_name}} / {{ confirmation_code }} / {{event_name}}",
      ),
    ).toEqual(["event_name", "confirmation_code"]);
  });

  it("renders values literally in one pass and reports unresolved tokens", () => {
    const result = renderTemplateText(
      "Hi {{recipient_name}} — {{event_name}} — {{balance_amount}} — {{unknown}}",
      {
        recipient_name: "$& is literal",
        event_name: "{{confirmation_code}}",
      },
    );

    expect(result.text).toBe(
      "Hi $& is literal — {{confirmation_code}} — {{balance_amount}} — {{unknown}}",
    );
    expect(result.missingTokens).toEqual(["balance_amount"]);
    expect(result.unresolvedTokens).toEqual(["balance_amount", "unknown"]);
  });

  it("renders every default completely with the sample context", () => {
    for (const template of DEFAULT_MESSAGE_TEMPLATE_LIST) {
      const rendered = renderMessageTemplate(template, SAMPLE_MESSAGE_TEMPLATE_CONTEXT);
      expect(rendered.isComplete).toBe(true);
      expect(rendered.missingTokens).toEqual([]);
      expect(rendered.unresolvedTokens).toEqual([]);
      expect(rendered.subject).toContain("IMSDA Women's Retreat 2026");
      expect(rendered.body).not.toMatch(/\{\{[^{}]+\}\}/);
    }
  });

  it("selects worker first, then unpaid or paid by balance", () => {
    expect(
      selectRegistrationMessageTemplate({ isWorker: true, balanceCents: 12_500 }),
    ).toBe("WORKER_CONFIRMATION");
    expect(
      selectRegistrationMessageTemplate({ isWorker: false, balanceCents: 1 }),
    ).toBe("REGISTRATION_CONFIRMATION_UNPAID");
    expect(
      selectRegistrationMessageTemplate({ isWorker: false, balanceCents: 0 }),
    ).toBe("REGISTRATION_CONFIRMATION_PAID");
    expect(
      selectRegistrationMessageTemplate({ isWorker: false, balanceCents: -100 }),
    ).toBe("REGISTRATION_CONFIRMATION_PAID");
  });

  it("formats currency and event date ranges for template context", () => {
    expect(formatMessageMoney(12_905)).toBe("$129.05");
    expect(
      formatMessageDateRange(
        new Date("2026-09-25T17:00:00.000Z"),
        new Date("2026-09-27T17:00:00.000Z"),
        { timeZone: "America/Chicago" },
      ),
    ).toBe("September 25 – 27, 2026");
    expect(formatMessageDateRange(null)).toBe("Dates to be announced");
  });
});
