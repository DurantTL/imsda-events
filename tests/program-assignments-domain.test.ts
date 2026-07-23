import { describe, expect, it } from "vitest";
import {
  assignmentSourceFingerprint,
  buildRankedAssignmentPreview,
  programAssignmentRosterCsv,
  type RankedAssignmentSource,
} from "@/modules/program-assignments/domain";

function source(
  participants: RankedAssignmentSource["participants"],
  choiceLimits: Record<string, number> = { Prayer: 1, Service: 1 },
): RankedAssignmentSource {
  return {
    eventId: "event_one",
    formId: "form_one",
    formName: "Retreat",
    formVersionId: "version_one",
    formVersionNumber: 3,
    fieldId: "session_one",
    fieldKey: "session_one_preferences",
    fieldLabel: "Friday seminar",
    options: ["Prayer", "Service"],
    choiceLimits,
    participants,
  };
}

function participant(
  attendeeId: string,
  submittedAt: string,
  preferences: unknown,
  attendeePosition = 0,
) {
  return {
    attendeeId,
    registrationId: `registration_${attendeeId}`,
    registrationStatus: "SUBMITTED" as const,
    confirmationCode: `REG-${attendeeId.toUpperCase()}`,
    submittedAt,
    attendeePosition,
    firstName: attendeeId,
    lastName: "Attendee",
    attendeeType: "Adult",
    preferences,
  };
}

describe("ranked program assignment", () => {
  it("maximizes assigned attendees before preserving first choices", () => {
    const preview = buildRankedAssignmentPreview(source([
      participant("flexible", "2026-06-01T10:00:00.000Z", ["Prayer", "Service"]),
      participant("prayer_only", "2026-06-01T10:01:00.000Z", ["Prayer"]),
    ]));

    expect(preview.summary).toMatchObject({
      attendees: 2,
      assigned: 2,
      firstChoiceAssigned: 1,
      secondChoiceAssigned: 1,
      unassigned: 0,
    });
    expect(preview.assignments.find(({ attendeeId }) => attendeeId === "prayer_only"))
      .toMatchObject({ assignedOption: "Prayer", preferenceRank: 1 });
    expect(preview.assignments.find(({ attendeeId }) => attendeeId === "flexible"))
      .toMatchObject({ assignedOption: "Service", preferenceRank: 2 });
  });

  it("maximizes first-choice assignments once maximum attendance is fixed", () => {
    const preview = buildRankedAssignmentPreview(source([
      participant("early", "2026-06-01T10:00:00.000Z", ["Prayer", "Service"]),
      participant("later", "2026-06-01T10:01:00.000Z", ["Service", "Prayer"]),
    ]));

    expect(preview.summary).toMatchObject({
      assigned: 2,
      firstChoiceAssigned: 2,
      secondChoiceAssigned: 0,
    });
    expect(preview.assignments.map(({ assignedOption }) => assignedOption))
      .toEqual(["Prayer", "Service"]);
  });

  it("uses submitted, registration, position, and attendee order deterministically", () => {
    const later = participant("later", "2026-06-01T10:01:00.000Z", ["Prayer"]);
    const earlier = participant("earlier", "2026-06-01T10:00:00.000Z", ["Prayer"]);
    const preview = buildRankedAssignmentPreview(source(
      [later, earlier],
      { Prayer: 1, Service: 1 },
    ));

    expect(preview.assignments.map(({ attendeeId }) => attendeeId)).toEqual([
      "earlier",
      "later",
    ]);
    expect(preview.assignments[0]).toMatchObject({
      assignedOption: "Prayer",
      stableOrder: 0,
    });
    expect(preview.assignments[1]).toMatchObject({
      assignedOption: null,
      unassignedReason: "CAPACITY_FULL",
    });
  });

  it("reports missing limits as unlimited and separates missing choices from full rooms", () => {
    const preview = buildRankedAssignmentPreview(source([
      participant("no_response", "2026-06-01T10:00:00.000Z", "PRIVATE-NOTE"),
      participant("service", "2026-06-01T10:01:00.000Z", ["Service"]),
    ], { Prayer: 1 }));

    expect(preview.summary).toMatchObject({
      assigned: 1,
      unassigned: 1,
      noRankedChoices: 1,
      limitedOptions: 1,
      unlimitedOptions: 1,
    });
    expect(preview.choices.find(({ option }) => option === "Service")).toMatchObject({
      capacity: null,
      capacityMode: "UNLIMITED_MISSING",
      assigned: 1,
      remaining: null,
    });
    expect(JSON.stringify(preview)).not.toContain("PRIVATE-NOTE");
  });

  it("fingerprints exact assignment inputs independent of query order", () => {
    const first = participant("first", "2026-06-01T10:00:00.000Z", ["Prayer"]);
    const second = participant("second", "2026-06-01T10:01:00.000Z", ["Service"]);
    const baseline = source([first, second]);

    expect(assignmentSourceFingerprint(baseline)).toBe(
      assignmentSourceFingerprint({ ...baseline, participants: [second, first] }),
    );
    expect(assignmentSourceFingerprint({
      ...baseline,
      choiceLimits: { ...baseline.choiceLimits, Prayer: 2 },
    })).not.toBe(assignmentSourceFingerprint(baseline));
    expect(assignmentSourceFingerprint(source([
      first,
      { ...second, preferences: ["Prayer"] },
    ]))).not.toBe(assignmentSourceFingerprint(baseline));
  });

  it("creates formula-safe rosters without carrying source free text", () => {
    const preview = buildRankedAssignmentPreview(source([
      {
        ...participant("formula", "2026-06-01T10:00:00.000Z", ["Prayer"]),
        firstName: "=HYPERLINK(\"https://bad.example\")",
      },
    ]));
    const csv = programAssignmentRosterCsv({
      id: "run_one",
      eventName: "Retreat",
      formName: "Retreat",
      formVersionNumber: 3,
      fieldLabel: "Friday seminar",
      appliedAt: "2026-06-10T10:00:00.000Z",
      appliedByName: "Admin",
      assignments: preview.assignments,
    });

    expect(csv).toContain("\"'=HYPERLINK(\"\"https://bad.example\"\")\"");
    expect(csv).not.toContain("preferences");
  });
});
