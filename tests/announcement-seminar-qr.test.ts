import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  buildRegistrationCheckinTokens,
  buildSeminarPreferencesBlock,
  withPerAttendeeQrImages,
} from "@/modules/communications/message-blocks";
import { loadSeminarAttendees } from "@/modules/communications/seminar-preferences";
import {
  NO_VALUE_MESSAGE_TEMPLATE_CONTEXT,
  OPTIONAL_MESSAGE_TEMPLATE_TOKENS,
  SAMPLE_MESSAGE_TEMPLATE_CONTEXT,
  MESSAGE_TEMPLATE_TOKEN_KEYS,
  renderMessageTemplate,
} from "@/modules/communications/templates";
import { enqueueEventAnnouncementMessage } from "@/modules/communications/transactional-messages";

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

const attendeeRows = [
  {
    id: "attendee-ann",
    profileSnapshot: { firstName: "Ann", lastName: "Synthetic" },
    formResponses: { seminar_preferences: ["Service", "Prayer"] },
    person: { firstName: "Ann", lastName: "Synthetic" },
  },
  {
    id: "attendee-bo",
    profileSnapshot: { firstName: "Bo", lastName: "[Click](https://evil.example)" },
    formResponses: { seminar_preferences: ["Music", "Service"] },
    person: { firstName: "Bo", lastName: "Synthetic" },
  },
];

function registrationRow() {
  return {
    id: "registration-1",
    confirmationCode: "REG-ANNOUNCE",
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
    attendees: attendeeRows,
    payments: [],
    waitlistEntry: null,
    groupRegistration: null,
  };
}

function announcementFixture(body: string) {
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
        versions: [{ id: "version-1", subjectTemplate: "{{announcement_title}}", bodyTemplate: body }],
      }),
    },
    registration: { findFirst: vi.fn().mockImplementation(async () => registrationRow()) },
    programAttendeeAssignment: {
      findMany: vi.fn().mockResolvedValue([
        { attendeeIdSnapshot: "attendee-ann", optionValue: "Prayer", run: { fieldKeySnapshot: "seminar_preferences" } },
      ]),
    },
    messageOutbox: { upsert },
  };
  return { tx, upsert };
}

const ANNOUNCEMENT_BODY = [
  "# {{announcement_title}}",
  "",
  "{{announcement_body}}",
  "",
  "### Your seminars",
  "",
  "{{seminar_preferences}}",
  "",
  "![Check-in QR code]({{checkin_qr_image}})",
].join("\n");

beforeEach(() => vi.clearAllMocks());

describe("seminar choices block", () => {
  it("lists each attendee with the assigned seminar and ranked choices, escaping names and labels", () => {
    const block = buildSeminarPreferencesBlock([
      { name: "Ann Synthetic", fields: [{ label: "Seminar", choices: ["Service", "Prayer"], assigned: ["Prayer"] }] },
      { name: "[Bo](https://evil.example)", fields: [{ label: "Seminar", choices: ["*Music*"], assigned: [] }] },
    ]);

    expect(block).toBe([
      "**Ann Synthetic**",
      "- Assigned: Prayer",
      "- 1st choice: Service",
      "- 2nd choice: Prayer",
      "",
      "**\\[Bo\\]\\(https\\:\\/\\/evil\\.example\\)**",
      "- 1st choice: \\*Music\\*",
    ].join("\n"));
  });

  it("is empty when the form has no seminar choice, and ordinals read naturally", () => {
    expect(buildSeminarPreferencesBlock([{ name: "Ann", fields: [] }])).toBe("");
    const block = buildSeminarPreferencesBlock([{
      name: "Ann",
      fields: [{ label: "Seminar", choices: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"], assigned: [] }],
    }]);
    expect(block).toContain("- 3rd choice: c");
    expect(block).toContain("- 4th choice: d");
    expect(block).toContain("- 11th choice: k");
    expect(block).toContain("- 12th choice: l");
  });

  it("reads each attendee's own ranked answers and current assignment", async () => {
    const { tx } = announcementFixture(ANNOUNCEMENT_BODY);
    const attendees = await loadSeminarAttendees(tx as never, { eventId: "event-1", registrationId: "registration-1" });

    expect(attendees.map((attendee) => attendee.name)).toEqual(["Ann Synthetic", "Bo [Click](https://evil.example)"]);
    expect(attendees[0].fields[0]).toEqual({ label: "Seminar preferences", choices: ["Service", "Prayer"], assigned: ["Prayer"] });
    expect(attendees[1].fields[0]).toEqual({ label: "Seminar preferences", choices: ["Music", "Service"], assigned: [] });
    expect(tx.programAttendeeAssignment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        outcome: "ASSIGNED",
        run: expect.objectContaining({ invalidatedAt: null, supersededBy: { none: {} } }),
      }),
    }));
  });
});

describe("event announcement to a party", () => {
  it("fills seminar choices and one labelled QR image per attendee", async () => {
    const { tx, upsert } = announcementFixture(ANNOUNCEMENT_BODY);
    await enqueueEventAnnouncementMessage(tx as never, {
      eventId: "event-1",
      registrationId: "registration-1",
      correlationId: "batch-1",
      transitionKey: "announcement-broadcast:a:b",
      announcementTitle: "Friday arrival information",
      announcementBody: "Doors open at three.",
    });
    const created = (upsert.mock.calls[0][0] as { create: Record<string, string> }).create;
    const text = created.bodyTextSnapshot;
    const html = created.bodyHtmlSnapshot;

    expect(text).toContain("**Ann Synthetic**\n- Assigned: Prayer\n- 1st choice: Service\n- 2nd choice: Prayer");
    expect(text).toContain("- 1st choice: Music\n- 2nd choice: Service");
    expect(html).toContain("Assigned: Prayer");
    // The registrant-supplied name never becomes a live link.
    expect(html).not.toContain("evil.example\"");
    expect(html).not.toContain("<a ");
    // Not the sample value.
    expect(text).not.toContain("Avery Johnson");

    expect(text).toContain("![Check-in QR code for Ann Synthetic](__IMSDA_PRIVATE_MANAGE_API__/attendee-passes/attendee-ann/qr?format=png)");
    expect(text).toContain("/attendee-passes/attendee-bo/qr?format=png)");
    expect(html.match(/<img /g)).toHaveLength(2);
    expect(html).toContain('src="__IMSDA_PRIVATE_MANAGE_API__/attendee-passes/attendee-ann/qr?format=png"');
    expect(html).toContain('src="__IMSDA_PRIVATE_MANAGE_API__/attendee-passes/attendee-bo/qr?format=png"');
  });

  it("renders one separate paragraph per blank-line-separated block", async () => {
    const { tx, upsert } = announcementFixture(ANNOUNCEMENT_BODY);
    await enqueueEventAnnouncementMessage(tx as never, {
      eventId: "event-1",
      registrationId: "registration-1",
      correlationId: "batch-1",
      transitionKey: "announcement-broadcast:a:b",
      announcementTitle: "Title",
      announcementBody: "First paragraph\n\nSecond paragraph",
    });
    const html = (upsert.mock.calls[0][0] as { create: Record<string, string> }).create.bodyHtmlSnapshot;

    expect(html).toContain(">First paragraph</p>");
    expect(html).toContain(">Second paragraph</p>");
  });

  it("keeps a single-attendee QR image as before", () => {
    const tokens = buildRegistrationCheckinTokens({
      confirmationCode: "REG-1",
      attendeeIds: ["attendee-ann"],
      attendees: [{ id: "attendee-ann", name: "Ann" }],
    });

    expect(tokens.checkin_qr_image).toContain("/attendee-passes/attendee-ann/qr?format=png");
    expect(withPerAttendeeQrImages("![x]({{checkin_qr_image}})", 1)).toBe("![x]({{checkin_qr_image}})");
  });

  it("leaves other messages with the portal link for a party", () => {
    const tokens = buildRegistrationCheckinTokens({
      confirmationCode: "REG-1",
      attendeeIds: ["attendee-ann", "attendee-bo"],
    });

    expect(tokens.checkin_qr_image).toBe("");
    expect(tokens.checkin_qr_images).toBe("");
    expect(tokens.checkin_block).toContain("Show our check-in passes");
    expect(tokens.checkin_block).not.toContain("![");
  });
});

describe("a message built from a real registration never shows sample values", () => {
  it("has no sample value anywhere in the no-value baseline", () => {
    for (const token of MESSAGE_TEMPLATE_TOKEN_KEYS) {
      const value = NO_VALUE_MESSAGE_TEMPLATE_CONTEXT[token];
      expect(value).toBe(OPTIONAL_MESSAGE_TEMPLATE_TOKENS.has(token) ? "" : "(none)");
      expect(value).not.toBe(SAMPLE_MESSAGE_TEMPLATE_CONTEXT[token]);
    }
  });

  it("renders a missing real value empty or as (none)", () => {
    const rendered = renderMessageTemplate(
      {
        subject: "{{announcement_title}}",
        body: "{{announcement_body}}\n\n{{seminar_preferences}}\n\n{{hotel_information}}\n\nEnd",
      },
      { ...NO_VALUE_MESSAGE_TEMPLATE_CONTEXT },
    );

    expect(rendered.isComplete).toBe(true);
    expect(rendered.body).toBe("(none)\n\nEnd");
    expect(rendered.body).not.toContain("Avery Johnson");
    expect(rendered.body).not.toContain("Prayer, Service");
  });
});
