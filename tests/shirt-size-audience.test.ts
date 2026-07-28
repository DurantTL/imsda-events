import { describe, expect, it } from "vitest";
import {
  computeShirtSizeRequestPreview,
  shirtSizeAttendeeSummary,
  type ShirtSizeCandidate,
  type ShirtSizePreviewContext,
} from "@/modules/communications/shirt-size-audience";

const context: ShirtSizePreviewContext = {
  eventId: "evt_wr26",
  eventSupportsShirtSizes: true,
  deliveryMode: "EXTERNAL_EMAIL",
  senderName: "IMSDA Events",
  senderEmail: "notifications@imsda.org",
  replyToEmail: "registration@imsda.org",
  templateEnabled: true,
  templateVersionId: "msgver_1",
  templateVersionNumber: 1,
  eventSnapshot: {
    name: "Women’s Retreat 2026",
    startsAt: "2026-10-09T00:00:00.000Z",
    endsAt: "2026-10-11T00:00:00.000Z",
    timezone: "America/Chicago",
    location: "Des Moines, IA",
  },
};

function candidate(overrides: Partial<ShirtSizeCandidate> = {}): ShirtSizeCandidate {
  return {
    registrationId: "reg_1",
    confirmationCode: "WR26-1780602786558-7AC3",
    status: "CONFIRMED",
    recipientName: "Caleb Durant",
    recipientEmail: "cdurant@imsda.org",
    attendees: [
      { attendeeId: "att_1", fullName: "Caleb Durant", shirtSize: null },
      { attendeeId: "att_2", fullName: "Cashmere Durant", shirtSize: null },
    ],
    ...overrides,
  };
}

describe("computeShirtSizeRequestPreview", () => {
  it("includes a registration where every attendee is missing a size", () => {
    const preview = computeShirtSizeRequestPreview([candidate()], context);

    expect(preview.includedCount).toBe(1);
    expect(preview.missingAttendeeCount).toBe(2);
    expect(preview.recipients[0].missingAttendeeNames).toEqual([
      "Caleb Durant",
      "Cashmere Durant",
    ]);
  });

  it("includes a partly answered registration and names only who is missing", () => {
    const preview = computeShirtSizeRequestPreview(
      [candidate({
        attendees: [
          { attendeeId: "att_1", fullName: "Caleb Durant", shirtSize: "Adult L" },
          { attendeeId: "att_2", fullName: "Cashmere Durant", shirtSize: null },
        ],
      })],
      context,
    );

    expect(preview.includedCount).toBe(1);
    expect(preview.missingAttendeeCount).toBe(1);
    expect(preview.recipients[0].missingAttendeeNames).toEqual(["Cashmere Durant"]);
    expect(preview.recipients[0].attendeeCount).toBe(2);
  });

  it("skips a registration once every size is recorded", () => {
    const preview = computeShirtSizeRequestPreview(
      [candidate({
        attendees: [
          { attendeeId: "att_1", fullName: "Caleb Durant", shirtSize: "Adult L" },
          { attendeeId: "att_2", fullName: "Cashmere Durant", shirtSize: "Adult M" },
        ],
      })],
      context,
    );

    expect(preview.includedCount).toBe(0);
    expect(preview.skipReasons.find((r) => r.code === "ALL_SIZES_RECORDED")?.count).toBe(1);
  });

  it("treats a whitespace-only size as missing", () => {
    const preview = computeShirtSizeRequestPreview(
      [candidate({ attendees: [{ attendeeId: "att_1", fullName: "Caleb Durant", shirtSize: "   " }] })],
      context,
    );

    expect(preview.includedCount).toBe(1);
  });

  it("skips cancelled and waitlisted registrations", () => {
    const preview = computeShirtSizeRequestPreview(
      [
        candidate({ registrationId: "reg_1", status: "CANCELLED" }),
        candidate({ registrationId: "reg_2", status: "WAITLISTED" }),
      ],
      context,
    );

    expect(preview.includedCount).toBe(0);
    expect(preview.skipReasons.find((r) => r.code === "INACTIVE_REGISTRATION")?.count).toBe(2);
  });

  it("skips a registration with no usable contact email", () => {
    const preview = computeShirtSizeRequestPreview(
      [candidate({ recipientEmail: "not-an-address" })],
      context,
    );

    expect(preview.includedCount).toBe(0);
    expect(preview.skipReasons.find((r) => r.code === "INVALID_CONTACT_EMAIL")?.count).toBe(1);
  });

  it("skips a registration that has no attendees at all", () => {
    const preview = computeShirtSizeRequestPreview(
      [candidate({ attendees: [] })],
      context,
    );

    expect(preview.skipReasons.find((r) => r.code === "NO_ATTENDEES")?.count).toBe(1);
  });

  it("is stable across candidate ordering", () => {
    const a = candidate({ registrationId: "reg_a", confirmationCode: "WR26-A" });
    const b = candidate({ registrationId: "reg_b", confirmationCode: "WR26-B" });

    expect(computeShirtSizeRequestPreview([a, b], context).fingerprint)
      .toBe(computeShirtSizeRequestPreview([b, a], context).fingerprint);
  });

  it("changes the fingerprint once an attendee answers", () => {
    const before = computeShirtSizeRequestPreview([candidate()], context).fingerprint;
    const after = computeShirtSizeRequestPreview(
      [candidate({
        attendees: [
          { attendeeId: "att_1", fullName: "Caleb Durant", shirtSize: "Adult L" },
          { attendeeId: "att_2", fullName: "Cashmere Durant", shirtSize: null },
        ],
      })],
      context,
    ).fingerprint;

    expect(after).not.toBe(before);
  });

  it("changes the fingerprint when the sending identity changes", () => {
    const before = computeShirtSizeRequestPreview([candidate()], context).fingerprint;
    const after = computeShirtSizeRequestPreview([candidate()], {
      ...context,
      senderEmail: "different@imsda.org",
    }).fingerprint;

    expect(after).not.toBe(before);
  });

  it("normalises the recipient email and falls back to a generic name", () => {
    const preview = computeShirtSizeRequestPreview(
      [candidate({ recipientEmail: "  CDurant@IMSDA.org ", recipientName: "  " })],
      context,
    );

    expect(preview.recipients[0].recipientEmail).toBe("cdurant@imsda.org");
    expect(preview.recipients[0].recipientName).toBe("Registrant");
  });
});

describe("shirtSizeAttendeeSummary", () => {
  it("lists only the attendees still missing a size", () => {
    const preview = computeShirtSizeRequestPreview([candidate()], context);

    expect(shirtSizeAttendeeSummary(preview.recipients[0]))
      .toBe("- Caleb Durant\n- Cashmere Durant");
  });
});
