import { describe, expect, it } from "vitest";
import {
  buildOperationalReport,
  operationalReportCsv,
  type OperationalReportRegistration,
} from "@/modules/reporting/operational-reports";

const definition = {
  title: "Flexible event registration",
  description: "A form whose field keys are intentionally event-specific.",
  confirmationMessage: "Registration received.",
  sections: [
    {
      id: "section_organization",
      title: "Organization",
      description: "",
      fields: [{
        id: "field_community_affiliation",
        key: "community_affiliation_2027",
        label: "Home congregation",
        helpText: "",
        type: "TEXT",
        scope: "REGISTRATION",
        required: false,
        options: [],
      }],
    },
    {
      id: "section_food_service",
      title: "Food service",
      description: "",
      fields: [
        {
          id: "field_supper_preference",
          key: "food_selection_987",
          label: "Friday supper preference",
          helpText: "",
          type: "SELECT",
          scope: "ATTENDEE",
          required: false,
          options: ["Standard", "Vegan"],
        },
        {
          id: "field_breakfast_tickets",
          key: "ticket_counter_321",
          label: "Breakfast tickets",
          helpText: "",
          type: "NUMBER",
          scope: "REGISTRATION",
          required: false,
          options: [],
        },
        {
          id: "field_party_adults",
          key: "party_adults_222",
          label: "Number of adults",
          helpText: "",
          type: "NUMBER",
          scope: "REGISTRATION",
          required: false,
          options: [],
        },
        {
          id: "field_food_allergies",
          key: "private_food_note",
          label: "Food allergies and dietary notes",
          helpText: "",
          type: "LONG_TEXT",
          scope: "ATTENDEE",
          required: false,
          options: [],
        },
      ],
    },
    {
      id: "section_overnight",
      title: "Overnight stay",
      description: "",
      fields: [{
        id: "field_accommodation",
        key: "sleeping_plan_456",
        label: "Overnight accommodation",
        helpText: "",
        type: "RADIO",
        scope: "REGISTRATION",
        required: false,
        options: ["Cabin", "Tent", "No lodging"],
      }, {
        id: "field_rv_length",
        key: "vehicle_length_555",
        label: "RV length in feet",
        helpText: "",
        type: "NUMBER",
        scope: "REGISTRATION",
        required: false,
        options: [],
      }],
    },
    {
      id: "section_program",
      title: "Program",
      description: "",
      fields: [
        {
          id: "field_workshop_ranking",
          key: "rank_the_sessions_654",
          label: "Breakout workshop ranking",
          helpText: "",
          type: "RANKED_CHOICE",
          scope: "ATTENDEE",
          required: false,
          options: ["Prayer", "Service"],
          minSelections: 1,
          maxSelections: 2,
        },
        {
          id: "field_medical_notes",
          key: "private_medical_note",
          label: "Medical and special needs notes",
          helpText: "",
          type: "LONG_TEXT",
          scope: "ATTENDEE",
          required: false,
          options: [],
        },
      ],
    },
  ],
} as const;

function registration(
  overrides: Partial<OperationalReportRegistration> = {},
): OperationalReportRegistration {
  return {
    id: "reg_active",
    confirmationCode: "REG-ACTIVE",
    status: "SUBMITTED",
    accountHolder: { firstName: "Ana", lastName: "Rivera" },
    attendees: [
      {
        id: "attendee_one",
        firstName: "Ana",
        lastName: "Rivera",
        attendeeType: "Adult",
        position: 0,
        responses: {},
      },
      {
        id: "attendee_two",
        firstName: "Luis",
        lastName: "Rivera",
        attendeeType: "Youth",
        position: 1,
        responses: {},
      },
    ],
    publicSubmission: {
      definition,
      responses: {
        community_affiliation_2027: "Central Congregation",
        ticket_counter_321: 3,
        party_adults_222: 2,
        sleeping_plan_456: "Cabin",
        vehicle_length_555: 35,
      },
      attendeeResponses: [
        {
          food_selection_987: "Vegan",
          rank_the_sessions_654: ["Prayer", "Service"],
          private_food_note: "PRIVATE-ALLERGY-DETAIL",
          private_medical_note: "PRIVATE-MEDICAL-DETAIL",
        },
        {
          food_selection_987: "Standard",
          rank_the_sessions_654: ["Service", "Prayer"],
        },
      ],
    },
    ...overrides,
  };
}

describe("operational reports", () => {
  it("uses immutable metadata to group and count active registrations", () => {
    const report = buildOperationalReport([
      registration(),
      registration({
        id: "reg_manual",
        confirmationCode: "REG-MANUAL",
        status: "CONFIRMED",
        accountHolder: { firstName: "Morgan", lastName: "Lee" },
        attendees: [{
          id: "attendee_manual",
          firstName: "Morgan",
          lastName: "Lee",
          attendeeType: "Volunteer",
          position: 0,
          responses: {},
        }],
        publicSubmission: null,
      }),
      registration({
        id: "reg_cancelled",
        confirmationCode: "REG-CANCELLED",
        status: "CANCELLED",
        publicSubmission: {
          definition,
          responses: {
            community_affiliation_2027: "Cancelled Group",
            ticket_counter_321: 99,
            sleeping_plan_456: "Tent",
          },
          attendeeResponses: [{
            food_selection_987: "Vegan",
            rank_the_sessions_654: ["Prayer"],
          }],
        },
      }),
      registration({ id: "reg_waitlist", status: "WAITLISTED" }),
      registration({ id: "reg_draft", status: "DRAFT" }),
    ]);

    expect(report.summary).toEqual({
      activeRegistrations: 2,
      attendees: 3,
      rosterGroups: 1,
      mealSelections: 5,
      housingSelections: 1,
      seminarInterests: 4,
    });
    expect(report.rosterGroups.map((group) => group.label)).toEqual([
      "Central Congregation",
      "Individual / ungrouped registrations",
    ]);
    expect(report.meals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: "Breakfast tickets",
        total: 3,
        counts: [{ label: "Total requested", count: 3 }],
      }),
      expect.objectContaining({
        label: "Friday supper preference",
        total: 2,
        counts: [
          { label: "Standard", count: 1 },
          { label: "Vegan", count: 1 },
        ],
      }),
    ]));
    expect(report.meals.map((field) => field.label)).not.toContain("Number of adults");
    expect(report.housing[0]).toMatchObject({
      label: "Overnight accommodation",
      total: 1,
    });
    expect(report.housing.map((field) => field.label)).not.toContain("RV length in feet");
    expect(report.seminars[0].choices).toEqual([
      { label: "Prayer", firstChoice: 1, secondChoice: 1, totalInterest: 2 },
      { label: "Service", firstChoice: 1, secondChoice: 1, totalInterest: 2 },
    ]);
    expect(JSON.stringify(report)).not.toContain("Cancelled Group");
  });

  it("never carries sensitive free-text notes into any aggregate export", () => {
    const report = buildOperationalReport([registration()]);
    const serialized = [
      JSON.stringify(report),
      operationalReportCsv(report, "roster"),
      operationalReportCsv(report, "meals"),
      operationalReportCsv(report, "housing"),
      operationalReportCsv(report, "seminars"),
    ].join("\n");

    expect(serialized).not.toContain("PRIVATE-ALLERGY-DETAIL");
    expect(serialized).not.toContain("PRIVATE-MEDICAL-DETAIL");
    expect(report.meals.map((field) => field.label)).not.toContain(
      "Food allergies and dietary notes",
    );
  });

  it("uses formula-safe CSV cells for group answers and names", () => {
    const report = buildOperationalReport([
      registration({
        accountHolder: { firstName: "=SUM(1,1)", lastName: "Example" },
        publicSubmission: {
          definition,
          responses: {
            community_affiliation_2027: "=HYPERLINK(\"https://bad.example\")",
          },
          attendeeResponses: [],
        },
      }),
    ]);

    const csv = operationalReportCsv(report, "roster");
    expect(csv).toContain("\"'=HYPERLINK(\"\"https://bad.example\"\")\"");
    expect(csv).toContain("\"'=SUM(1,1) Example\"");
  });
});
