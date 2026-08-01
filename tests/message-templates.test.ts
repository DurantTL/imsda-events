import { describe, expect, it } from "vitest";
import {
  ALLOWED_MESSAGE_TEMPLATE_TOKENS,
  DEFAULT_MESSAGE_TEMPLATE_LIST,
  DEFAULT_MESSAGE_TEMPLATES,
  MESSAGE_TEMPLATE_KEYS,
  MESSAGE_TEMPLATE_TOKEN_KEYS,
  OPTIONAL_MESSAGE_TEMPLATE_TOKENS,
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
import { renderEmailBodyHtml } from "@/modules/communications/email-html";
import type { MessageTemplateKeyValue } from "@/modules/communications/types";

/**
 * `MessageTemplateKeyValue` restates the template keys by hand, and nothing at
 * runtime connects the two lists — a key added to one and missed in the other
 * only surfaces as a type error somewhere else entirely. These two assignments
 * fail to compile the moment the lists disagree, in either direction.
 */
type TemplateKey = (typeof MESSAGE_TEMPLATE_KEYS)[number];
const _keysAreTemplateKeyValues: MessageTemplateKeyValue = null as unknown as TemplateKey;
const _templateKeyValuesAreKeys: TemplateKey = null as unknown as MessageTemplateKeyValue;
void _keysAreTemplateKeyValues;
void _templateKeyValuesAreKeys;

describe("message templates", () => {
  it("ships sixteen valid plaintext defaults", () => {
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
      "SHIRT_SIZE_REQUEST",
      "REGISTRATION_ACCESS_RECOVERY",
      "EVENT_ANNOUNCEMENT",
    ]);
    expect(DEFAULT_MESSAGE_TEMPLATE_LIST).toHaveLength(16);

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

  it("renders an optional block as nothing instead of stopping the send", () => {
    const result = renderTemplateText(
      "Before\n\n{{hotel_information}}\n\nAfter",
      { hotel_information: "" },
    );

    expect(result.text).toBe("Before\n\n\n\nAfter");
    expect(result.missingTokens).toEqual([]);
    expect(result.unresolvedTokens).toEqual([]);
    expect(OPTIONAL_MESSAGE_TEMPLATE_TOKENS.has("hotel_information")).toBe(true);
  });

  it("still reports a required token that has no value", () => {
    const result = renderTemplateText("Hi {{recipient_name}}", { recipient_name: "  " });
    expect(result.missingTokens).toEqual(["recipient_name"]);
    expect(result.text).toBe("Hi {{recipient_name}}");
  });

  /**
   * An omitted block leaves the blank lines that framed its token behind. The
   * body has to close back up, or an event with no hotel sends a message with a
   * hole in the middle of it.
   */
  it("closes the gap an omitted block leaves in a rendered body", () => {
    const rendered = renderMessageTemplate(
      {
        subject: "{{event_name}}",
        body: "Hello.\n\n{{hotel_information}}\n\n{{checkin_block}}\n\nGoodbye.",
      },
      { event_name: "Retreat" },
    );

    expect(rendered.body).toBe("Hello.\n\nGoodbye.");
    expect(rendered.isComplete).toBe(true);
  });

  it("keeps the hotel block and its spacing when the event books rooms", () => {
    const rendered = renderMessageTemplate(
      { subject: "{{event_name}}", body: "Hello.\n\n{{hotel_information}}\n\nGoodbye." },
      { event_name: "Retreat", hotel_information: "### Hotel reservations\n\nStay at the lodge." },
    );

    expect(rendered.body).toBe(
      "Hello.\n\n### Hotel reservations\n\nStay at the lodge.\n\nGoodbye.",
    );
  });

  it("separates the event's contact address from the registration's own", () => {
    expect(ALLOWED_MESSAGE_TEMPLATE_TOKENS.has("contact_email")).toBe(true);
    expect(ALLOWED_MESSAGE_TEMPLATE_TOKENS.has("registration_contact_email")).toBe(true);
    // The contact-updated notice is the one template that means the
    // registration's destination rather than the organiser's address.
    expect(
      DEFAULT_MESSAGE_TEMPLATES.REGISTRATION_CONTACT_UPDATED.body,
    ).toContain("sent to {{registration_contact_email}}");
    expect(
      DEFAULT_MESSAGE_TEMPLATES.REGISTRATION_CONFIRMATION_PAID.body,
    ).toContain("Contact {{contact_email}}");
  });

  /**
   * The portal link is written as `[text]({{portal_url}})`. A preview value
   * carrying its own brackets renders as broken markup rather than a button,
   * which is exactly what the preview used to show.
   */
  it("keeps a valid, non-live URL in every preview link position", () => {
    expect(SAMPLE_MESSAGE_TEMPLATE_CONTEXT.portal_url).toMatch(/^https:\/\//);
    expect(SAMPLE_MESSAGE_TEMPLATE_CONTEXT.portal_url).not.toMatch(/[[\]]/);

    const rendered = renderMessageTemplate(
      DEFAULT_MESSAGE_TEMPLATES.REGISTRATION_CONFIRMATION_PAID,
      SAMPLE_MESSAGE_TEMPLATE_CONTEXT,
    );
    const html = renderEmailBodyHtml(rendered.body);
    expect(html).toContain(`<a href="${SAMPLE_MESSAGE_TEMPLATE_CONTEXT.portal_url}"`);
    expect(html).toContain("View, pay, or edit your registration");
  });

  it("keeps the sample event, venue, and lodging describing one event", () => {
    expect(SAMPLE_MESSAGE_TEMPLATE_CONTEXT.event_location).toBe("Des Moines, Iowa");
    expect(SAMPLE_MESSAGE_TEMPLATE_CONTEXT.event_dates).toContain("2026");
    expect(SAMPLE_MESSAGE_TEMPLATE_CONTEXT.hotel_information).toContain("Des Moines");
  });

  it("renders every default into HTML with no leftover markup or unsafe link", () => {
    for (const template of DEFAULT_MESSAGE_TEMPLATE_LIST) {
      const rendered = renderMessageTemplate(template, SAMPLE_MESSAGE_TEMPLATE_CONTEXT);
      const html = renderEmailBodyHtml(rendered.body);

      expect(html).not.toMatch(/\{\{[^{}]+\}\}/);
      expect(html).not.toMatch(/(^|[^&])\*\*/);
      expect(html).not.toContain('href="javascript:');
      expect(html).not.toContain('href="data:');
    }
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
