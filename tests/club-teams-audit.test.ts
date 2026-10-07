import { describe, expect, it } from "vitest";
import { emptyClubAssignmentFields } from "@/modules/club-registrations/assignments";
import {
  churchAmountsOwedCsvRows,
  sortChurchAmountsOwed,
  type ChurchAmountOwedRow,
} from "@/modules/club-registrations/church-owed";
import {
  computeClubAssignmentPreview,
  type ClubAssignmentCandidate,
  type ClubAssignmentPreviewContext,
} from "@/modules/communications/club-assignment-audience";
import { registrationMoveBlocker, registrationMoveBlockerLabels } from "@/modules/club-transfers/domain";
import {
  assignmentKey,
  buildCampingReport,
  buildClubEventRecord,
  buildDutiesActivitiesReport,
  type ClubAssignmentSummary,
} from "@/modules/reporting/club-event-reports";
import { buildCheckInBook } from "@/modules/reporting/check-in-book";

/**
 * Where a club's several teams (#809) must stay apart: the church-owed report, the assignment email batch, the
 * Camporee-style reports, the check-in book and the staff move queue. Synthetic data only.
 */

const row = (overrides: Partial<ChurchAmountOwedRow> = {}): ChurchAmountOwedRow => ({
  organizationId: "org-1", organizationName: "Test Pathfinders", churchId: "church-1", churchName: "Test SDA Church",
  confirmationCode: "PBE-1", status: "CONFIRMED", attendeeCount: 6, isBilled: true, amountOwedCents: 0, ...overrides,
});

describe("church owed, with teams", () => {
  const teams = [
    row({ confirmationCode: "PBE-2", teamName: "Sword Drill" }),
    row({ confirmationCode: "PBE-1", teamName: "Bible Bees" }),
  ];

  it("lists each team as a billed row of its own, in team order within the club", () => {
    expect(sortChurchAmountsOwed(teams).map((entry) => entry.teamName)).toEqual(["Bible Bees", "Sword Drill"]);
  });

  it("adds a Team column to the CSV only when some club registered a team", () => {
    const withTeams = churchAmountsOwedCsvRows(teams);
    expect(withTeams[0]).toEqual(["Church", "Club", "Team", "Confirmation code", "Status", "Billed to church", "Attendees", "Estimated amount owed", "Church estimated total", "Note"]);
    expect(withTeams[1]!.slice(0, 4)).toEqual(["Test SDA Church", "Test Pathfinders", "Bible Bees", "PBE-1"]);
    // The church's total is the sum of its teams'.
    const priced = churchAmountsOwedCsvRows([row({ teamName: "A", amountOwedCents: 1000 }), row({ confirmationCode: "PBE-2", teamName: "B", amountOwedCents: 2500 })]);
    expect(priced[1]![8]).toBe("35.00");
    expect(priced[2]![8]).toBe("35.00");

    const without = churchAmountsOwedCsvRows([row()]);
    expect(without[0]).toEqual(["Church", "Club", "Confirmation code", "Status", "Billed to church", "Attendees", "Estimated amount owed", "Church estimated total", "Note"]);
  });
});

describe("assignment emails, with teams", () => {
  const context: ClubAssignmentPreviewContext = {
    eventId: "evt_1", deliveryMode: "EXTERNAL_EMAIL", senderName: "IMSDA Events", senderEmail: "notifications@imsda.org",
    replyToEmail: "registration@imsda.org", templateEnabled: true, templateVersionId: "msgver_1", templateVersionNumber: 1,
  };
  const candidate = (overrides: Partial<ClubAssignmentCandidate>): ClubAssignmentCandidate => ({
    organizationId: "org_1", organizationName: "Bible Bees (Test Pathfinders)", teamKey: "bible bees", clubEventRegistrationId: "cer_1",
    registrationId: "reg_1", confirmationCode: "PBE-1", registrationStatus: "CONFIRMED", recipientName: "Jordan Lee",
    recipientEmail: "jordan@example.test",
    fields: { ...emptyClubAssignmentFields, campsiteLocation: "Room 1", dutyLabel: "Greeter", activityLabel: "Quiz" },
    version: 1, lastEmailedVersion: null, ...overrides,
  });
  const both = [
    candidate({}),
    candidate({ organizationName: "Sword Drill (Test Pathfinders)", teamKey: "sword drill", clubEventRegistrationId: "cer_2", registrationId: "reg_2", confirmationCode: "PBE-2" }),
  ];

  it("addresses every team of a club in a send to every club", () => {
    const preview = computeClubAssignmentPreview(both, context, { scope: "ALL_SET" });
    expect(preview.recipients.map((recipient) => recipient.confirmationCode)).toEqual(["PBE-1", "PBE-2"]);
    expect(preview.recipients.map((recipient) => recipient.teamKey)).toEqual(["bible bees", "sword drill"]);
  });

  it("sends to one team of the club when one is named, and never to its other teams", () => {
    const preview = computeClubAssignmentPreview(both, context, { scope: "ONE", organizationId: "org_1", teamKey: "sword drill" });
    expect(preview.recipients.map((recipient) => recipient.confirmationCode)).toEqual(["PBE-2"]);
  });

  it("makes a different reviewed preview for each team, so one cannot send as the other", () => {
    const first = computeClubAssignmentPreview(both, context, { scope: "ONE", organizationId: "org_1", teamKey: "bible bees" });
    const second = computeClubAssignmentPreview(both, context, { scope: "ONE", organizationId: "org_1", teamKey: "sword drill" });
    expect(first.fingerprint).not.toBe(second.fingerprint);
  });

  it("finds nothing for a team the club never registered", () => {
    const preview = computeClubAssignmentPreview(both, context, { scope: "ONE", organizationId: "org_1", teamKey: "nope" });
    expect(preview.includedCount).toBe(0);
    expect(preview.skipped[0]).toMatchObject({ code: "NOT_FOUND", teamKey: "nope" });
  });

  it("is exactly as before for a club with no team: the same target, the same shape", () => {
    const plain = candidate({ teamKey: undefined, organizationName: "Pathfinder Pioneers" });
    const preview = computeClubAssignmentPreview([plain], context, { scope: "ONE", organizationId: "org_1" });
    expect(preview.recipients).toHaveLength(1);
    expect(preview.recipients[0]).not.toHaveProperty("teamKey");
  });
});

describe("club event reports, with teams", () => {
  const record = (teamName: string | null, registrationId: string, confirmationCode: string) => buildClubEventRecord({
    organizationId: "org-1",
    organizationName: teamName ? `${teamName} (Test Pathfinders)` : "Test Pathfinders",
    ...(teamName ? { teamKey: teamName.toLowerCase(), teamName } : {}),
    sponsoringChurch: "Test SDA Church", registrationId, confirmationCode, status: "CONFIRMED", submittedAt: null,
    registrationResponses: {}, attendees: [{ id: `${registrationId}-a`, firstName: "Alex", lastName: "Sample", responses: { attendee_type: "Pathfinder" } }],
    amountOwedCents: 0, pricingSnapshot: {}, lateRateLabel: null,
  });
  const teams = [record("Bible Bees", "reg-1", "PBE-1"), record("Sword Drill", "reg-2", "PBE-2")];

  it("gives each team its own row, name and key in the reports", () => {
    const camping = buildCampingReport(teams);
    expect(camping.map((entry) => entry.organizationName)).toEqual(["Bible Bees (Test Pathfinders)", "Sword Drill (Test Pathfinders)"]);
    expect(camping.map((entry) => entry.teamKey)).toEqual(["bible bees", "sword drill"]);
  });

  it("keeps each team's own assignment, not one club-wide assignment", () => {
    const assignments = new Map<string, ClubAssignmentSummary>([
      [assignmentKey("org-1", "bible bees"), { ...emptyClubAssignmentFields, campsiteLocation: "Room 1" }],
      [assignmentKey("org-1", "sword drill"), { ...emptyClubAssignmentFields, campsiteLocation: "Room 2" }],
    ]);
    const rows = buildDutiesActivitiesReport(teams, assignments);
    expect(rows.map((entry) => entry.assignment?.campsiteLocation)).toEqual(["Room 1", "Room 2"]);
  });

  it("leaves a registration with no team without a key, so its rows are as they were", () => {
    const plain = record(null, "reg-9", "CAMP-9");
    expect(plain).not.toHaveProperty("teamKey");
    expect(buildCampingReport([plain])[0]).not.toHaveProperty("teamKey");
  });

  it("prints a page for each team in the check-in book, under its own name and id", () => {
    const book = buildCheckInBook({
      event: { name: "Synthetic PBE", startsOn: "2027-01-16T15:00:00.000Z", endsOn: "2027-01-16T22:00:00.000Z", timezone: "America/Chicago" },
      mode: "CLUB", clubs: teams, registrations: [],
    });
    expect(book.pages.map((page) => page.title)).toEqual(["Bible Bees (Test Pathfinders)", "Sword Drill (Test Pathfinders)"]);
    expect(new Set(book.pages.map((page) => page.id)).size).toBe(2);
  });
});

describe("a member's move into a club with several teams", () => {
  const input = {
    attendeeOnSource: true, sourceStatus: "CONFIRMED", receivingMemberActive: true, destination: null, classLimitExceeded: false,
  };

  it("is blocked as unclear, not as 'no registration', when the new club has more than one team", () => {
    expect(registrationMoveBlocker({ ...input, destinationAmbiguous: true })).toBe("DESTINATION_AMBIGUOUS");
    expect(registrationMoveBlockerLabels.DESTINATION_AMBIGUOUS).toContain("more than one team");
  });

  it("still says the new club has not registered when it has no registration at all", () => {
    expect(registrationMoveBlocker({ ...input, destinationAmbiguous: false })).toBe("NO_DESTINATION");
    expect(registrationMoveBlocker(input)).toBe("NO_DESTINATION");
  });
});
