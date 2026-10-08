import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { enqueueSelectedAudienceMessage } from "@/modules/communications/transactional-messages";
import {
  CUSTOM_MESSAGE_TOKEN_KEYS,
  MESSAGE_TEMPLATE_KEYS,
  MESSAGE_TEMPLATE_TOKEN_KEYS,
  showsPerAttendeeQrs,
  validateMessageTemplate,
} from "@/modules/communications/templates";
import {
  selectedAudienceBatchInputSchema,
  selectedAudienceTemplateKeys,
  selectedAudienceTemplateLabels,
} from "@/modules/communications/selected-audience";

// Synthetic data only.
const seminarDefinition = {
  title: "Synthetic retreat",
  description: "Synthetic form.",
  confirmationMessage: "Received.",
  sections: [{
    id: "seminars",
    title: "Seminars",
    description: "",
    fields: [{
      id: "seminar_field",
      key: "seminar_preferences",
      label: "Seminar preferences",
      helpText: "",
      type: "RANKED_CHOICE",
      scope: "ATTENDEE",
      required: true,
      options: ["Prayer", "Service", "Music"],
      minSelections: 2,
      maxSelections: 2,
      availabilityMode: "RANKED_INTEREST",
      choiceLimits: {},
    }],
  }],
};

function attendees(count: number) {
  const named = [
    { id: "attendee-ann", first: "Ann", seminars: ["Service", "Prayer"] },
    { id: "attendee-bo", first: "Bo", seminars: ["Music", "Service"] },
  ];
  return Array.from({ length: count }, (_, index) => {
    const base = named[index] ?? { id: `attendee-${index}`, first: `Guest${index}`, seminars: ["Prayer", "Music"] };
    return {
      id: base.id,
      profileSnapshot: { firstName: base.first, lastName: "Synthetic" },
      formResponses: { seminar_preferences: base.seminars },
      person: { firstName: base.first, lastName: "Synthetic" },
    };
  });
}

function registrationRow(attendeeCount: number) {
  return {
    id: "registration-1",
    confirmationCode: "REG-CUSTOM",
    status: "CONFIRMED",
    totalAmount: { toString: () => "100.00" },
    contactSnapshot: { firstName: "Pat", lastName: "Party", email: "pat@example.test" },
    publicFormSubmission: {
      pricingSnapshot: {},
      formVersion: { formId: "form-1", definition: seminarDefinition },
    },
    operations: [],
    location: null,
    accountHolderPerson: { firstName: "Pat", lastName: "Party", normalizedEmail: "pat@example.test" },
    event: {
      name: "Synthetic Retreat",
      startsAt: new Date("2026-10-09T21:00:00.000Z"),
      endsAt: new Date("2026-10-11T17:00:00.000Z"),
      timezone: "America/Chicago",
      location: "Camp",
      supportContact: "office@example.test",
      billingMode: "ATTENDEE_PAY",
      paymentInstructionVersions: [],
    },
    attendees: attendees(attendeeCount),
    payments: [],
    waitlistEntry: null,
    groupRegistration: null,
  };
}

const CUSTOM_BODY = [
  "Hello {{recipient_name}},",
  "",
  "**Bring this to check-in.**",
  "",
  "![Check-in QR code]({{checkin_qr_image}})",
  "",
  "### Your sessions",
  "",
  "{{seminar_preferences}}",
].join("\n");

function customFixture(attendeeCount: number, body = CUSTOM_BODY) {
  const upsert = vi.fn(async (args: { create: Record<string, unknown> }) => ({
    id: "message-1",
    status: args.create.status,
  }));
  const tx = {
    eventMessageSettings: {
      findUnique: vi.fn().mockResolvedValue({
        deliveryMode: "LOCAL_CAPTURE",
        senderName: "IMSDA Events",
        senderEmail: "events@example.test",
        replyToEmail: "help@example.test",
      }),
    },
    eventMessageTemplate: {
      findUnique: vi.fn().mockResolvedValue({
        isEnabled: true,
        versions: [{ id: "version-1", subjectTemplate: "News for {{recipient_name}}", bodyTemplate: body, files: [] }],
      }),
    },
    registration: { findFirst: vi.fn().mockImplementation(async () => registrationRow(attendeeCount)) },
    programAttendeeAssignment: {
      findMany: vi.fn().mockResolvedValue([
        { attendeeIdSnapshot: "attendee-ann", optionValue: "Prayer", run: { fieldKeySnapshot: "seminar_preferences" } },
      ]),
    },
    messageOutbox: { upsert },
  };
  return { tx, upsert };
}

function sendCustom(tx: unknown) {
  return enqueueSelectedAudienceMessage(tx as never, {
    eventId: "event-1",
    registrationId: "registration-1",
    templateKey: "CUSTOM_MESSAGE",
    batchId: "batch-1",
    correlationId: "batch-1",
  });
}

beforeEach(() => vi.clearAllMocks());

describe("custom message template kind", () => {
  it("is a template kind that Email selected offers, and nothing sends it automatically", () => {
    expect(MESSAGE_TEMPLATE_KEYS).toContain("CUSTOM_MESSAGE");
    expect(selectedAudienceTemplateKeys).toEqual([
      "BALANCE_REMINDER",
      "EVENT_ANNOUNCEMENT",
      "CUSTOM_MESSAGE",
      "REGISTRATION_CONFIRMATION",
    ]);
    expect(selectedAudienceTemplateLabels.CUSTOM_MESSAGE).toBe("Custom message");
    expect(selectedAudienceTemplateLabels.EVENT_ANNOUNCEMENT).toBe("Event announcement");
  });

  it("needs a subject and a body to publish, and has no required tokens", () => {
    expect(validateMessageTemplate({ subject: "", body: "" }).issues.map((issue) => issue.code))
      .toEqual(["REQUIRED", "REQUIRED"]);
    expect(validateMessageTemplate({ subject: "Hello", body: "Just words, no tokens." }).isValid).toBe(true);
  });

  it("offers the QR and seminar tokens first, and only real tokens", () => {
    expect(CUSTOM_MESSAGE_TOKEN_KEYS.slice(0, 5)).toEqual([
      "checkin_qr_images",
      "checkin_qr_image",
      "checkin_qr_url",
      "checkin_block",
      "seminar_preferences",
    ]);
    for (const token of CUSTOM_MESSAGE_TOKEN_KEYS) expect(MESSAGE_TEMPLATE_TOKEN_KEYS).toContain(token);
    expect(CUSTOM_MESSAGE_TOKEN_KEYS).not.toContain("announcement_body");
    expect(CUSTOM_MESSAGE_TOKEN_KEYS).not.toContain("refund_amount");
  });

  it("shows per-attendee QR codes for the announcement and the custom message only", () => {
    expect(showsPerAttendeeQrs("EVENT_ANNOUNCEMENT")).toBe(true);
    expect(showsPerAttendeeQrs("CUSTOM_MESSAGE")).toBe(true);
    expect(showsPerAttendeeQrs("BALANCE_REMINDER")).toBe(false);
    expect(showsPerAttendeeQrs(undefined)).toBe(false);
  });

  it("accepts a batch with no title or message, unlike an announcement", () => {
    const base = {
      batchId: "3f6e1f52-52b4-4f5a-91e0-1f4f4f0f2a11",
      registrationIds: ["reg-1"],
      previewFingerprint: "a".repeat(64),
    };
    expect(selectedAudienceBatchInputSchema.safeParse({ ...base, templateKey: "CUSTOM_MESSAGE" }).success).toBe(true);
    expect(selectedAudienceBatchInputSchema.safeParse({ ...base, templateKey: "EVENT_ANNOUNCEMENT" }).success).toBe(false);
  });
});

describe("custom message to a party on the selected-audience path", () => {
  it("fills one labelled QR image and both attendees' sessions for a party of two", async () => {
    const { tx, upsert } = customFixture(2);
    await sendCustom(tx);
    const created = (upsert.mock.calls[0][0] as { create: Record<string, string> }).create;
    const text = created.bodyTextSnapshot;
    const html = created.bodyHtmlSnapshot;

    expect(created.templateKey).toBe("CUSTOM_MESSAGE");
    expect(created.subjectSnapshot).toBe("News for Pat Party");
    expect(text).toContain("![Check-in QR code for Ann Synthetic](__IMSDA_PRIVATE_MANAGE_API__/attendee-passes/attendee-ann/qr?format=png)");
    expect(text).toContain("![Check-in QR code for Bo Synthetic](__IMSDA_PRIVATE_MANAGE_API__/attendee-passes/attendee-bo/qr?format=png)");
    expect(html.match(/<img /g)).toHaveLength(2);
    expect(html).toContain("<strong>Bring this to check-in.</strong>");
    expect(text).toContain("Ann Synthetic\n- Assigned: Prayer\n- 1st choice: Service\n- 2nd choice: Prayer");
    expect(text).toContain("Bo Synthetic\n- 1st choice: Music\n- 2nd choice: Service");
    expect(tx.programAttendeeAssignment.findMany).toHaveBeenCalledTimes(1);
  });

  it("fills the plural QR token for a party too", async () => {
    const { tx, upsert } = customFixture(2, "{{checkin_qr_images}}\n\n{{seminar_preferences}}");
    await sendCustom(tx);
    const html = (upsert.mock.calls[0][0] as { create: Record<string, string> }).create.bodyHtmlSnapshot;

    expect(html.match(/<img /g)).toHaveLength(2);
    expect(html).toContain("Assigned: Prayer");
  });

  it("links to the portal above 8 attendees, as the announcement does", async () => {
    const { tx, upsert } = customFixture(9);
    await sendCustom(tx);
    const created = (upsert.mock.calls[0][0] as { create: Record<string, string> }).create;

    expect(created.bodyHtmlSnapshot).not.toContain("<img ");
    expect(created.bodyTextSnapshot).toContain("Show our check-in passes");
  });

  it("keeps one attendee's own single QR image", async () => {
    const { tx, upsert } = customFixture(1);
    await sendCustom(tx);
    const html = (upsert.mock.calls[0][0] as { create: Record<string, string> }).create.bodyHtmlSnapshot;

    expect(html.match(/<img /g)).toHaveLength(1);
    expect(html).toContain("/attendee-passes/attendee-ann/qr?format=png");
  });

  it("reads the seminar data only when the template uses the token", async () => {
    const { tx } = customFixture(2, "Hello {{recipient_name}}");
    await sendCustom(tx);

    expect(tx.programAttendeeAssignment.findMany).not.toHaveBeenCalled();
  });

  it("uses the batch-loaded seminar block when the send supplies one", async () => {
    const { tx, upsert } = customFixture(2);
    await enqueueSelectedAudienceMessage(tx as never, {
      eventId: "event-1",
      registrationId: "registration-1",
      templateKey: "CUSTOM_MESSAGE",
      batchId: "batch-1",
      correlationId: "batch-1",
      seminarPreferencesBlock: "**Batch Person**\n- 1st choice: Music",
    });
    const text = (upsert.mock.calls[0][0] as { create: Record<string, string> }).create.bodyTextSnapshot;

    expect(text).toContain("Batch Person");
    expect(tx.programAttendeeAssignment.findMany).not.toHaveBeenCalled();
  });
});
