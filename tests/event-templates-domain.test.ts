import { describe, expect, it } from "vitest";
import {
  applyEventTemplateInputSchema,
  asEventMessageTemplateKey,
  EventTemplateReferenceError,
  eventTemplatePayloadSchema,
  moduleEnablementSchema,
  validateEventTemplatePayloadReferences,
} from "@/modules/event-templates/domain";
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
