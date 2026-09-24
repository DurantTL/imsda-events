import { describe, expect, it } from "vitest";
import {
  buildCampingReport,
  buildClubEventRecord,
  buildDutiesActivitiesReport,
  buildSpecialRolesReport,
  buildSpiritualMilestonesReport,
  campingReportCsv,
  clubHeadcounts,
  dutiesActivitiesReportCsv,
  roleAbbreviation,
  specialRolesReportCsv,
  spiritualMilestonesReportCsv,
  type BuildClubEventRecordInput,
} from "@/modules/reporting/club-event-reports";

function attendee(overrides: Partial<BuildClubEventRecordInput["attendees"][number]> & { id: string }) {
  return {
    firstName: "First",
    lastName: "Last",
    responses: {},
    ...overrides,
  };
}

function clubInput(overrides: Partial<BuildClubEventRecordInput> = {}): BuildClubEventRecordInput {
  return {
    organizationId: "org-1",
    organizationName: "Trailblazers",
    sponsoringChurch: "Ankeny SDA",
    registrationId: "reg-1",
    confirmationCode: "CAMP-001",
    status: "CONFIRMED",
    submittedAt: "2026-01-05T00:00:00.000Z",
    registrationResponses: {
      director_name: "Pat Rivera",
      email: "pat@example.org",
      phone: "555-0100",
      tents: "3 large",
      trailers: "1",
      kitchen_canopy: "20x20",
      total_sqft: "900",
      camp_next_to: "Eagles",
      duty_areas: ["Flag raising / lowering"],
      flag_slots: ["Friday morning"],
      bathroom_days: ["Friday"],
      special_activities: ["Lead mixer Thursday night at vespers"],
      partner_club: "Eagles",
      event_ribbons: "Yes",
      sabbath_skit: "Noah's Ark",
      sponsoring_meals: "Yes",
      meal_sponsorship_count: "10",
      meal_times: ["Friday lunch"],
      baptism_names: "Jamie Lee",
      bible_names: "Sam Ortiz",
    },
    attendees: [
      attendee({
        id: "att-1", firstName: "Jamie", lastName: "Lee",
        responses: { attendee_type: "Pathfinder", attendee_age: 12, gender: "Female", dietary_needs: "PRIVATE-PEANUT-ALLERGY" },
      }),
      attendee({
        id: "att-2", firstName: "Robin", lastName: "Diaz",
        responses: { attendee_type: "Staff", attendee_age: 34, gender: "Male", medical_personnel: true },
      }),
      attendee({
        id: "att-3", firstName: "Sam", lastName: "Ortiz",
        responses: { attendee_type: "Staff", attendee_age: 40, master_guide_investiture: true },
      }),
      attendee({ id: "att-4", firstName: "Lee", lastName: "Kim", responses: { attendee_type: "TLT", attendee_age: 16 } }),
      attendee({ id: "att-5", firstName: "Ali", lastName: "Nguyen", responses: { attendee_type: "Child", attendee_age: 6 } }),
    ],
    amountOwedCents: 4500,
    pricingSnapshot: { lineItems: [{ key: "fee-1", pricingLabel: "Late registration pricing" }] },
    lateRateLabel: "Late registration pricing",
    ...overrides,
  };
}

describe("buildClubEventRecord", () => {
  it("reads only the well-known Spring Camporee response keys, keeping protected free text out of every derived field", () => {
    const record = buildClubEventRecord(clubInput());
    expect(record.directorName).toBe("Pat Rivera");
    expect(record.camping).toEqual({
      tents: "3 large", trailers: "1", kitchenCanopy: "20x20", totalSqft: "900", campNextTo: "Eagles",
    });
    expect(record.baptismNames).toBe("Jamie Lee");
    expect(record.lateRateApplied).toBe(true);
    const jamie = record.attendees.find((a) => a.id === "att-1")!;
    expect(jamie.hasDietaryNeed).toBe(true);
    expect(JSON.stringify(record)).not.toContain("PRIVATE-PEANUT-ALLERGY");
  });

  it("marks medical personnel and Master Guide investiture only for the flagged attendees", () => {
    const record = buildClubEventRecord(clubInput());
    const robin = record.attendees.find((a) => a.id === "att-2")!;
    const sam = record.attendees.find((a) => a.id === "att-3")!;
    expect(robin.medicalPersonnel).toBe(true);
    expect(robin.masterGuideInvestiture).toBe(false);
    expect(sam.masterGuideInvestiture).toBe(true);
  });

  it("leaves lateRateApplied false when no line item carries the late-pricing label", () => {
    const record = buildClubEventRecord(clubInput({ pricingSnapshot: { lineItems: [{ key: "fee-1", pricingLabel: undefined }] } }));
    expect(record.lateRateApplied).toBe(false);
  });
});

describe("clubHeadcounts", () => {
  it("counts each roster role plus a total, matching the underlying registration", () => {
    const record = buildClubEventRecord(clubInput());
    expect(clubHeadcounts(record.attendees)).toEqual({ pathfinder: 1, tlt: 1, staff: 2, child: 1, total: 5 });
  });

  it("excludes an attendee with no answered role from every role bucket but still counts the total", () => {
    const record = buildClubEventRecord(clubInput({
      attendees: [attendee({ id: "att-1", responses: {} })],
    }));
    expect(clubHeadcounts(record.attendees)).toEqual({ pathfinder: 0, tlt: 0, staff: 0, child: 0, total: 1 });
  });
});

describe("roleAbbreviation", () => {
  it("maps every roster role to its packet abbreviation", () => {
    expect(roleAbbreviation("Pathfinder")).toBe("PF");
    expect(roleAbbreviation("TLT")).toBe("TLT");
    expect(roleAbbreviation("Staff")).toBe("Stf");
    expect(roleAbbreviation("Child")).toBe("Ch");
    expect(roleAbbreviation(null)).toBe("—");
  });
});

describe("club report builders", () => {
  const clubA = buildClubEventRecord(clubInput());
  const clubB = buildClubEventRecord(clubInput({
    organizationId: "org-2",
    organizationName: "Arrows",
    confirmationCode: "CAMP-002",
    registrationResponses: { ...clubInput().registrationResponses, baptism_names: "", bible_names: "" },
    attendees: [attendee({ id: "att-9", responses: { attendee_type: "Pathfinder", attendee_age: 11 } })],
  }));

  it("builds one camping row per club with headcounts matching the registrations", () => {
    const rows = buildCampingReport([clubA, clubB]);
    expect(rows).toHaveLength(2);
    const arrows = rows.find((r) => r.organizationId === "org-2")!;
    expect(arrows.headcounts).toEqual({ pathfinder: 1, tlt: 0, staff: 0, child: 0, total: 1 });
    // Alphabetical by club name.
    expect(rows.map((r) => r.organizationName)).toEqual(["Arrows", "Trailblazers"]);
  });

  it("attaches a club's staff assignment to its duties-and-activities row, or null when unassigned", () => {
    const assignments = new Map([["org-1", {
      campsiteLocation: "Field C", campsiteNotes: "", dutyLabel: "Flags", dutyDay: "Friday", dutyTime: "AM", activityLabel: "Skit", notes: "",
    }]]);
    const rows = buildDutiesActivitiesReport([clubA, clubB], assignments);
    const trailblazers = rows.find((r) => r.organizationId === "org-1")!;
    const arrows = rows.find((r) => r.organizationId === "org-2")!;
    expect(trailblazers.assignment?.campsiteLocation).toBe("Field C");
    expect(arrows.assignment).toBeNull();
  });

  it("only lists spiritual milestones for clubs that answered baptism or Bible read-through", () => {
    const rows = buildSpiritualMilestonesReport([clubA, clubB]);
    expect(rows).toHaveLength(1);
    expect(rows[0].organizationId).toBe("org-1");
  });

  it("lists every flagged medical-personnel and Master-Guide attendee across clubs", () => {
    const rows = buildSpecialRolesReport([clubA, clubB]);
    const roles = rows.map((r) => `${r.role}:${r.name}`);
    expect(roles).toContain("Medical personnel:Diaz, Robin");
    expect(roles).toContain("Master Guide investiture:Ortiz, Sam");
    expect(rows).toHaveLength(2);
  });
});

describe("club report CSVs", () => {
  it("escapes a formula-looking value and quotes fields containing commas", () => {
    const clubs = [buildClubEventRecord(clubInput({
      organizationName: "=cmd|'/c calc'!A1",
      registrationResponses: { ...clubInput().registrationResponses, camp_next_to: "Eagles, Falcons" },
    }))];
    const csv = campingReportCsv(buildCampingReport(clubs));
    expect(csv).toContain("\"'=cmd|'/c calc'!A1\"");
    expect(csv).toContain("\"Eagles, Falcons\"");
  });

  it("produces a CSV row for the duties/activities and milestones and special-roles reports", () => {
    const record = buildClubEventRecord(clubInput());
    expect(dutiesActivitiesReportCsv(buildDutiesActivitiesReport([record], new Map()))).toContain("Trailblazers");
    expect(spiritualMilestonesReportCsv(buildSpiritualMilestonesReport([record]))).toContain("Jamie Lee");
    expect(specialRolesReportCsv(buildSpecialRolesReport([record]))).toContain("Medical personnel");
  });
});
