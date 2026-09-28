import { describe, expect, it } from "vitest";
import {
  applyEventTemplateInputSchema,
  asEventMessageTemplateKey,
  EventTemplateReferenceError,
  eventTemplatePayloadSchema,
  moduleEnablementSchema,
  parseEventTemplatePayload,
  validateEventTemplatePayloadReferences,
} from "@/modules/event-templates/domain";
import { eventSettingsInputSchema } from "@/modules/events/schemas";
import {
  requireEventTemplateApplyPermission,
  requireEventTemplateManagementPermission,
} from "@/modules/event-templates/authorization";

const staff = { id: "usr_staff", email: "staff@example.test", displayName: "Staff", globalRole: null };
const systemAdmin = { id: "usr_admin", email: "admin@example.test", displayName: "Admin", globalRole: "SYSTEM_ADMIN" as const };

describe("event template payload schema", () => {
  it("fills in every default for an empty payload", () => {
    const payload = eventTemplatePayloadSchema.parse({});
    expect(payload).toMatchObject({
      audience: "GENERAL",
      formTemplateKeys: [],
      attendeeTypes: [],
      attendeeClassifications: [],
      reportSelections: [],
      messageTemplateDefaults: [],
      moduleEnablement: {
        waitlistEnabled: false,
        autoPromoteWaitlist: false,
        collectsShirtSizes: false,
        checksAdultBackgrounds: false,
      },
      brandingDefaults: { publicInfoUrl: null, supportContact: null, calendarCategory: null },
    });
  });

  it("rejects a module enablement key that is not one of the fixed, real event toggles", () => {
    expect(() => moduleEnablementSchema.parse({ waitlistEnabled: true, somethingMadeUp: true })).toThrow();
    expect(() => eventTemplatePayloadSchema.parse({ moduleEnablement: { unknownModule: true } })).toThrow();
  });

  it("rejects a repeated attendee type code", () => {
    expect(() => eventTemplatePayloadSchema.parse({
      attendeeTypes: [
        { code: "ADULT", label: "Adult" },
        { code: "ADULT", label: "Adult (duplicate)" },
      ],
    })).toThrow(/repeated/);
  });

  it("accepts a well-formed payload with attendee types, a form template, and a message default", () => {
    const payload = eventTemplatePayloadSchema.parse({
      audience: "CLUB",
      formTemplateKeys: ["simple_rsvp"],
      attendeeTypes: [{ code: "ADULT", label: "Adult" }],
      moduleEnablement: { waitlistEnabled: true, autoPromoteWaitlist: true },
      messageTemplateDefaults: [{
        key: "EVENT_ANNOUNCEMENT",
        subjectTemplate: "Update on {{event_name}}",
        bodyTemplate: "Details inside.",
      }],
    });
    expect(payload.audience).toBe("CLUB");
    expect(payload.formTemplateKeys).toEqual(["simple_rsvp"]);
    expect(payload.moduleEnablement.autoPromoteWaitlist).toBe(true);
  });
});

describe("message template defaults use the communications rules (#152 B2)", () => {
  const withDefault = (entry: Record<string, unknown>) => eventTemplatePayloadSchema.safeParse({
    messageTemplateDefaults: [{ key: "REGISTRATION_CONFIRMATION", subjectTemplate: "Subject", bodyTemplate: "Body", ...entry }],
  });

  it("rejects an unknown token and a header-injecting line break in the subject", () => {
    const result = withDefault({ subjectTemplate: "Hi {{not_a_token}}\nBcc: someone@example.test" });
    expect(result.success).toBe(false);
    const messages = result.error!.issues.map((issue) => issue.message).join(" | ");
    expect(messages).toMatch(/one line/);
    expect(messages).toMatch(/not_a_token/);
    expect(result.error!.issues.every((issue) => issue.path.join(".") === "messageTemplateDefaults.0.subjectTemplate")).toBe(true);
  });

  it("rejects an unknown token in the body", () => {
    const result = withDefault({ bodyTemplate: "Hello {{made_up_field}}" });
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]!.path).toEqual(["messageTemplateDefaults", 0, "bodyTemplate"]);
  });

  it("enforces the communications editor's length limits (180 / 12,000)", () => {
    expect(withDefault({ subjectTemplate: "s".repeat(180) }).success).toBe(true);
    expect(withDefault({ subjectTemplate: "s".repeat(181) }).success).toBe(false);
    expect(withDefault({ bodyTemplate: "b".repeat(12_000) }).success).toBe(true);
    expect(withDefault({ bodyTemplate: "b".repeat(12_001) }).success).toBe(false);
  });

  it("accepts known tokens", () => {
    expect(withDefault({ subjectTemplate: "Welcome to {{event_name}}" }).success).toBe(true);
  });

  it("parseEventTemplatePayload reports a stale stored payload as a reference error, naming each problem", () => {
    try {
      parseEventTemplatePayload({ messageTemplateDefaults: [{ key: "REGISTRATION_CONFIRMATION", subjectTemplate: "Hi {{nope}}", bodyTemplate: "Body" }] });
      expect.unreachable("expected a reference error");
    } catch (error) {
      expect(error).toBeInstanceOf(EventTemplateReferenceError);
      expect((error as EventTemplateReferenceError).issues[0]).toMatch(/^messageTemplateDefaults\.0\.subjectTemplate: /);
    }
  });
});

describe("validateEventTemplatePayloadReferences", () => {
  it("passes for a known form template and a known event message template key", () => {
    const payload = eventTemplatePayloadSchema.parse({
      formTemplateKeys: ["simple_rsvp"],
      messageTemplateDefaults: [{ key: "EVENT_ANNOUNCEMENT", subjectTemplate: "Subject", bodyTemplate: "Body" }],
    });
    expect(() => validateEventTemplatePayloadReferences(payload)).not.toThrow();
  });

  it("names every unavailable reference at once, for an unknown form template", () => {
    const payload = eventTemplatePayloadSchema.parse({ formTemplateKeys: ["not_a_real_template"] });
    try {
      validateEventTemplatePayloadReferences(payload);
      expect.unreachable("expected a reference error");
    } catch (error) {
      expect(error).toBeInstanceOf(EventTemplateReferenceError);
      expect((error as EventTemplateReferenceError).issues).toEqual([
        'Registration form template "not_a_real_template" is not available.',
      ]);
    }
  });

  it("rejects a message template key that is not an event message template (e.g. an account-only key)", () => {
    const payload = eventTemplatePayloadSchema.parse({
      messageTemplateDefaults: [{ key: "ACCOUNT_ACTIVATION", subjectTemplate: "Subject", bodyTemplate: "Body" }],
    });
    expect(() => validateEventTemplatePayloadReferences(payload)).toThrow(EventTemplateReferenceError);
  });

  it("reports both a disabled form template and an unavailable message key together", () => {
    const payload = eventTemplatePayloadSchema.parse({
      formTemplateKeys: ["retired_template"],
      messageTemplateDefaults: [{ key: "NOT_A_TEMPLATE", subjectTemplate: "Subject", bodyTemplate: "Body" }],
    });
    try {
      validateEventTemplatePayloadReferences(payload);
      expect.unreachable("expected a reference error");
    } catch (error) {
      expect((error as EventTemplateReferenceError).issues).toHaveLength(2);
    }
  });
});

describe("asEventMessageTemplateKey", () => {
  it("narrows a valid event message template key", () => {
    expect(asEventMessageTemplateKey("EVENT_ANNOUNCEMENT")).toBe("EVENT_ANNOUNCEMENT");
  });

  it("rejects an account-only or unknown key", () => {
    expect(() => asEventMessageTemplateKey("ACCOUNT_ACTIVATION")).toThrow(EventTemplateReferenceError);
  });
});

describe("applyEventTemplateInputSchema", () => {
  it("requires a substantial idempotency key", () => {
    expect(() => applyEventTemplateInputSchema.parse({
      name: "Weekend retreat",
      slug: "weekend-retreat",
      startsOn: "2027-05-01",
      endsOn: "2027-05-03",
      requestKey: "short",
    })).toThrow();
  });

  it("accepts a complete apply request", () => {
    const parsed = applyEventTemplateInputSchema.parse({
      name: "Weekend retreat",
      slug: "weekend-retreat",
      startsOn: "2027-05-01",
      endsOn: "2027-05-03",
      requestKey: "idempotency-key-0001",
    });
    expect(parsed.slug).toBe("weekend-retreat");
  });

  const base = { name: "Weekend retreat", slug: "weekend-retreat", startsOn: "2027-05-01", endsOn: "2027-05-03", requestKey: "idempotency-key-0001" };

  it.each([
    ["an impossible day (would roll over to March)", { startsOn: "2027-02-30" }],
    ["month 13", { endsOn: "2027-13-01" }],
    ["an end before the start", { startsOn: "2027-05-04", endsOn: "2027-05-03" }],
    ["a slug with leading and repeated hyphens", { slug: "-x--y-" }],
    ["a two-character slug", { slug: "ab" }],
    ["a two-character name", { name: "ab" }],
    ["a name longer than event settings allow", { name: "n".repeat(121) }],
  ])("rejects %s, exactly as event settings would (#152 B3)", (_label, override) => {
    expect(applyEventTemplateInputSchema.safeParse({ ...base, ...override }).success).toBe(false);
  });

  it("accepts every value event settings accepts, so the created event can be re-saved", () => {
    const parsed = applyEventTemplateInputSchema.parse({ ...base, slug: "Weekend-Retreat", startsOn: "2028-02-29", endsOn: "2028-02-29" });
    expect(parsed.slug).toBe("weekend-retreat");
    expect(eventSettingsInputSchema.shape.name.safeParse(parsed.name).success).toBe(true);
    expect(eventSettingsInputSchema.shape.slug.safeParse(parsed.slug).success).toBe(true);
  });
});

describe("event template permissions (#152)", () => {
  it("management (draft/publish/archive) is system-admin only", () => {
    expect(() => requireEventTemplateManagementPermission({ user: staff }))
      .toThrowError(expect.objectContaining({ status: 403, code: "PERMISSION_DENIED" }));
    expect(requireEventTemplateManagementPermission({ user: systemAdmin }).id).toBe("usr_admin");
  });

  it("applying a template is system-admin only, matching direct event creation", () => {
    expect(() => requireEventTemplateApplyPermission({ user: staff }))
      .toThrowError(expect.objectContaining({ status: 403, code: "PERMISSION_DENIED" }));
    expect(requireEventTemplateApplyPermission({ user: systemAdmin }).id).toBe("usr_admin");
  });
});
