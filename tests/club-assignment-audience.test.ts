import { describe, expect, it } from "vitest";
import {
  computeClubAssignmentPreview,
  type ClubAssignmentCandidate,
  type ClubAssignmentPreviewContext,
} from "@/modules/communications/club-assignment-audience";
import { emptyClubAssignmentFields } from "@/modules/club-registrations/assignments";

const context: ClubAssignmentPreviewContext = {
  eventId: "evt_camp26",
  deliveryMode: "EXTERNAL_EMAIL",
  senderName: "IMSDA Events",
  senderEmail: "notifications@imsda.org",
  replyToEmail: "registration@imsda.org",
  templateEnabled: true,
  templateVersionId: "msgver_1",
  templateVersionNumber: 1,
};

function candidate(overrides: Partial<ClubAssignmentCandidate> = {}): ClubAssignmentCandidate {
  return {
    organizationId: "org_1",
    organizationName: "Pathfinder Pioneers",
    clubEventRegistrationId: "cer_1",
    registrationId: "reg_1",
    confirmationCode: "SC26-1-AAAA",
    registrationStatus: "CONFIRMED",
    recipientName: "Jordan Lee",
    recipientEmail: "jordan@example.test",
    fields: {
      ...emptyClubAssignmentFields,
      campsiteLocation: "Field C, site 12",
      dutyLabel: "Flag raising / lowering",
      activityLabel: "Campfire singing",
    },
    version: 2,
    lastEmailedVersion: null,
    ...overrides,
  };
}

describe("computeClubAssignmentPreview", () => {
  it("includes a fully assigned club in the ALL_SET scope", () => {
    const preview = computeClubAssignmentPreview([candidate()], context, { scope: "ALL_SET" });
    expect(preview.includedCount).toBe(1);
    expect(preview.recipients[0].organizationId).toBe("org_1");
    expect(preview.recipients[0].assignmentBlock).toContain("Campfire singing");
  });

  it("skips a club that is only partially assigned in the ALL_SET scope", () => {
    const preview = computeClubAssignmentPreview(
      [candidate({ fields: { ...emptyClubAssignmentFields, campsiteLocation: "Field C, site 12" } })],
      context,
      { scope: "ALL_SET" },
    );
    expect(preview.includedCount).toBe(0);
    expect(preview.skipped[0].code).toBe("NOT_FULLY_ASSIGNED");
  });

  it("skips an inactive registration even if fully assigned", () => {
    const preview = computeClubAssignmentPreview(
      [candidate({ registrationStatus: "CANCELLED" })],
      context,
      { scope: "ALL_SET" },
    );
    expect(preview.skipped[0].code).toBe("INACTIVE_REGISTRATION");
  });

  it("skips a missing or invalid contact email", () => {
    const preview = computeClubAssignmentPreview(
      [candidate({ recipientEmail: "not-an-email" })],
      context,
      { scope: "ALL_SET" },
    );
    expect(preview.skipped[0].code).toBe("INVALID_CONTACT_EMAIL");
  });

  it("ONE scope sends only the chosen club, even when others qualify", () => {
    const preview = computeClubAssignmentPreview(
      [candidate({ organizationId: "org_1" }), candidate({ organizationId: "org_2" })],
      context,
      { scope: "ONE", organizationId: "org_2" },
    );
    expect(preview.includedCount).toBe(1);
    expect(preview.recipients[0].organizationId).toBe("org_2");
  });

  it("ONE scope reports NOT_FOUND for a club not registered on this event", () => {
    const preview = computeClubAssignmentPreview([candidate()], context, { scope: "ONE", organizationId: "org_missing" });
    expect(preview.includedCount).toBe(0);
    expect(preview.skipped[0].code).toBe("NOT_FOUND");
  });

  it("ALL_SET skips a club whose current version was already emailed", () => {
    const preview = computeClubAssignmentPreview(
      [candidate({ version: 2, lastEmailedVersion: 2 })],
      context,
      { scope: "ALL_SET" },
    );
    expect(preview.includedCount).toBe(0);
    expect(preview.skipped).toEqual([expect.objectContaining({ organizationId: "org_1", code: "ALREADY_SENT" })]);
  });

  it("ONE scope still allows an explicit resend, flagged as already sent this version", () => {
    const preview = computeClubAssignmentPreview(
      [candidate({ version: 2, lastEmailedVersion: 2 })],
      context,
      { scope: "ONE", organizationId: "org_1" },
    );
    expect(preview.includedCount).toBe(1);
    expect(preview.recipients[0].alreadySentThisVersion).toBe(true);
    expect(preview.recipients[0].organizationName).toBe("Pathfinder Pioneers");
  });

  it("changes the fingerprint once a send stamps the version, so a stale reviewed batch can't resend it", () => {
    const beforeSend = computeClubAssignmentPreview([candidate({ lastEmailedVersion: null })], context, { scope: "ONE", organizationId: "org_1" });
    const afterSend = computeClubAssignmentPreview([candidate({ lastEmailedVersion: 2 })], context, { scope: "ONE", organizationId: "org_1" });
    expect(beforeSend.includedCount).toBe(1);
    expect(afterSend.includedCount).toBe(1);
    expect(beforeSend.fingerprint).not.toBe(afterSend.fingerprint);
  });

  it("changes the fingerprint when the published template version changes", () => {
    const first = computeClubAssignmentPreview([candidate()], context, { scope: "ALL_SET" });
    const republished = computeClubAssignmentPreview(
      [candidate()],
      { ...context, templateVersionId: "msgver_2", templateVersionNumber: 2 },
      { scope: "ALL_SET" },
    );
    expect(first.fingerprint).not.toBe(republished.fingerprint);
  });

  it("does not mark a recipient as already sent after a change bumped the version", () => {
    const preview = computeClubAssignmentPreview(
      [candidate({ version: 3, lastEmailedVersion: 2 })],
      context,
      { scope: "ALL_SET" },
    );
    expect(preview.recipients[0].alreadySentThisVersion).toBe(false);
  });

  it("produces the same fingerprint for the same audience and a different one for a changed assignment", () => {
    const first = computeClubAssignmentPreview([candidate()], context, { scope: "ALL_SET" });
    const same = computeClubAssignmentPreview([candidate()], context, { scope: "ALL_SET" });
    const changed = computeClubAssignmentPreview(
      [candidate({ fields: { ...emptyClubAssignmentFields, campsiteLocation: "Field D, site 3", dutyLabel: "Bathroom clean-up", activityLabel: "Oregon Trail" } })],
      context,
      { scope: "ALL_SET" },
    );
    expect(first.fingerprint).toBe(same.fingerprint);
    expect(first.fingerprint).not.toBe(changed.fingerprint);
  });
});
