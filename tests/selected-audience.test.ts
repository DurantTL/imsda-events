import { describe, expect, it } from "vitest";
import {
  computeSelectedAudiencePreview,
  selectedAudienceBatchInputSchema,
  type SelectedAudienceCandidate,
  type SelectedAudiencePreviewContext,
} from "@/modules/communications/selected-audience";

const now = new Date("2026-09-15T12:00:00.000Z");

function context(
  overrides: Partial<SelectedAudiencePreviewContext> = {},
): SelectedAudiencePreviewContext {
  return {
    eventId: "event-1",
    templateKey: "BALANCE_REMINDER",
    deliveryMode: "LOCAL_CAPTURE",
    senderName: "IMSDA Events",
    senderEmail: "events@imsda.test",
    replyToEmail: "events@imsda.test",
    templateEnabled: true,
    templateVersionId: "version-1",
    templateVersionNumber: 3,
    ...overrides,
  };
}

function candidate(
  overrides: Partial<SelectedAudienceCandidate> = {},
): SelectedAudienceCandidate {
  return {
    registrationId: "reg-1",
    confirmationCode: "WR26-1001",
    status: "CONFIRMED",
    recipientName: "Marta Alvarez",
    recipientEmail: "marta@example.test",
    totalCents: 20_000,
    netPaidCents: 0,
    ...overrides,
  };
}

describe("selected-audience preview", () => {
  it("includes a chosen registration that owes money", () => {
    const preview = computeSelectedAudiencePreview(
      ["reg-1"],
      [candidate()],
      context(),
      now,
    );

    expect(preview.includedCount).toBe(1);
    expect(preview.skipped).toEqual([]);
    expect(preview.totalBalanceCents).toBe(20_000);
    expect(preview.recipients[0].recipientEmail).toBe("marta@example.test");
  });

  it("names every skipped registration rather than only counting them", () => {
    const preview = computeSelectedAudiencePreview(
      ["reg-1", "reg-2", "reg-3", "reg-4"],
      [
        candidate(),
        candidate({ registrationId: "reg-2", confirmationCode: "WR26-1002", status: "CANCELLED" }),
        candidate({ registrationId: "reg-3", confirmationCode: "WR26-1003", netPaidCents: 20_000 }),
        candidate({ registrationId: "reg-4", confirmationCode: "WR26-1004", recipientEmail: "  " }),
      ],
      context(),
      now,
    );

    expect(preview.includedCount).toBe(1);
    expect(preview.skipped.map((entry) => [entry.confirmationCode, entry.code])).toEqual([
      ["WR26-1002", "INACTIVE_REGISTRATION"],
      ["WR26-1003", "NO_BALANCE_DUE"],
      ["WR26-1004", "INVALID_CONTACT_EMAIL"],
    ]);
  });

  it("reports an identifier that is not a registration on this event", () => {
    const preview = computeSelectedAudiencePreview(
      ["reg-1", "reg-from-another-event"],
      [candidate()],
      context(),
      now,
    );

    expect(preview.skipped).toEqual([expect.objectContaining({
      registrationId: "reg-from-another-event",
      code: "NOT_FOUND",
    })]);
  });

  it("still sends an announcement to a settled registration", () => {
    const preview = computeSelectedAudiencePreview(
      ["reg-1"],
      [candidate({ netPaidCents: 20_000 })],
      context({ templateKey: "EVENT_ANNOUNCEMENT" }),
      now,
    );

    expect(preview.includedCount).toBe(1);
  });

  it("never reminds an organization-billed event about a balance", () => {
    const preview = computeSelectedAudiencePreview(
      ["reg-1"],
      [candidate()],
      context({ isDeferredOrganizationBilling: true }),
      now,
    );

    expect(preview.skipped[0].code).toBe("ORGANIZATION_BILLED");
  });

  it("collapses a repeated selection to one recipient", () => {
    const preview = computeSelectedAudiencePreview(
      ["reg-1", "reg-1"],
      [candidate()],
      context(),
      now,
    );

    expect(preview.selectedCount).toBe(1);
    expect(preview.includedCount).toBe(1);
  });

  it("changes the fingerprint when a reviewed balance is paid", () => {
    const before = computeSelectedAudiencePreview(["reg-1"], [candidate()], context(), now);
    const after = computeSelectedAudiencePreview(
      ["reg-1"],
      [candidate({ netPaidCents: 5_000 })],
      context(),
      now,
    );

    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it("changes the fingerprint when the template version moves", () => {
    const before = computeSelectedAudiencePreview(["reg-1"], [candidate()], context(), now);
    const after = computeSelectedAudiencePreview(
      ["reg-1"],
      [candidate()],
      context({ templateVersionId: "version-2", templateVersionNumber: 4 }),
      now,
    );

    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it("does not change the fingerprint with the time it was generated", () => {
    const before = computeSelectedAudiencePreview(["reg-1"], [candidate()], context(), now);
    const after = computeSelectedAudiencePreview(
      ["reg-1"],
      [candidate()],
      context(),
      new Date("2026-09-16T09:00:00.000Z"),
    );

    expect(after.fingerprint).toBe(before.fingerprint);
  });
});

describe("selected-audience batch input", () => {
  const base = {
    batchId: "3f6e1f52-52b4-4f5a-91e0-1f4f4f0f2a11",
    registrationIds: ["reg-1"],
    previewFingerprint: "a".repeat(64),
  };

  it("accepts a balance reminder with no announcement text", () => {
    expect(selectedAudienceBatchInputSchema.parse({
      ...base,
      templateKey: "BALANCE_REMINDER",
    }).announcementTitle).toBe("");
  });

  it("requires a title and a message for an announcement", () => {
    const result = selectedAudienceBatchInputSchema.safeParse({
      ...base,
      templateKey: "EVENT_ANNOUNCEMENT",
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path[0]))
      .toEqual(["announcementTitle", "announcementBody"]);
  });

  it("refuses a template that announces a state change", () => {
    expect(selectedAudienceBatchInputSchema.safeParse({
      ...base,
      templateKey: "WAITLIST_PROMOTED",
    }).success).toBe(false);
  });

  it("refuses an unbounded selection", () => {
    expect(selectedAudienceBatchInputSchema.safeParse({
      ...base,
      templateKey: "BALANCE_REMINDER",
      registrationIds: Array.from({ length: 251 }, (_, index) => `reg-${index}`),
    }).success).toBe(false);
  });
});
