import { describe, expect, it } from "vitest";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";
import {
  AttendeeRosterCsvError,
  createAttendeeRosterCsvTemplate,
  parseAttendeeRosterCsv,
} from "@/modules/forms/attendee-roster-csv";

const definition = registrationFormDefinitionSchema.parse({
  title: "Women’s Retreat registration",
  description: "",
  confirmationMessage: "Registration received.",
  attendeeRoster: {
    enabled: true,
    minAttendees: 1,
    maxAttendees: 2,
    attendeeLabel: "Attendee",
    addButtonLabel: "Add another attendee",
  },
  sections: [{
    id: "attendee_details",
    title: "Attendee details",
    description: "",
    fields: [
      {
        id: "attendee_first_name",
        key: "first_name",
        label: "First name",
        helpText: "",
        type: "TEXT",
        scope: "ATTENDEE",
        required: true,
        options: [],
      },
      {
        id: "attendee_last_name",
        key: "last_name",
        label: "Last name",
        helpText: "",
        type: "TEXT",
        scope: "ATTENDEE",
        required: true,
        options: [],
      },
      {
        id: "attendee_type",
        key: "attendee_type",
        label: "Attendee type",
        helpText: "",
        type: "SELECT",
        scope: "ATTENDEE",
        required: true,
        options: ["Adult", "Teen", "Child"],
      },
      {
        id: "attendee_shirt_size",
        key: "shirt_size",
        label: "Shirt size",
        helpText: "",
        type: "SELECT",
        scope: "ATTENDEE",
        required: false,
        options: ["Small", "Medium", "Large"],
      },
      {
        id: "attendee_volunteer",
        key: "volunteer",
        label: "Volunteer",
        helpText: "",
        type: "CHECKBOX",
        scope: "ATTENDEE",
        required: false,
        options: [],
      },
      {
        id: "attendee_sessions",
        key: "session_choices",
        label: "Session choices",
        helpText: "",
        type: "RANKED_CHOICE",
        scope: "ATTENDEE",
        required: false,
        options: ["Prayer", "Wellness", "Bible study"],
        maxSelections: 2,
      },
      {
        id: "attendee_fee",
        key: "registration_fee",
        label: "Registration fee",
        helpText: "",
        type: "CALCULATED",
        scope: "ATTENDEE",
        required: false,
        options: [],
        priceCents: 12_500,
      },
    ],
  }],
});

describe("attendee roster CSV", () => {
  it("creates a template from editable attendee fields only", () => {
    expect(createAttendeeRosterCsvTemplate(definition)).toBe(
      "first_name,last_name,attendee_type,shirt_size,volunteer,session_choices\n",
    );
  });

  it("loads quoted names, canonical choices, checkboxes, and ranked choices", () => {
    const attendees = parseAttendeeRosterCsv(
      [
        "First name,last_name,attendee_type,shirt_size,volunteer,session_choices",
        'Ana,"Durant, Jr.",adult,medium,yes,Wellness|Prayer',
        "Bea,Smith,Teen,,no,",
      ].join("\n"),
      definition,
    );

    expect(attendees).toEqual([
      {
        first_name: "Ana",
        last_name: "Durant, Jr.",
        attendee_type: "Adult",
        shirt_size: "Medium",
        volunteer: true,
        session_choices: ["Wellness", "Prayer"],
      },
      {
        first_name: "Bea",
        last_name: "Smith",
        attendee_type: "Teen",
        volunteer: false,
      },
    ]);
  });

  it("rejects missing required columns and invalid choices with row context", () => {
    expect(() => parseAttendeeRosterCsv(
      "first_name,attendee_type\nAna,Adult",
      definition,
    )).toThrowError(expect.objectContaining({
      name: "AttendeeRosterCsvError",
      message: expect.stringContaining("last_name"),
    }));
    expect(() => parseAttendeeRosterCsv(
      "first_name,last_name,attendee_type\nAna,Durant,Worker",
      definition,
    )).toThrowError(expect.objectContaining({
      name: "AttendeeRosterCsvError",
      message: expect.stringContaining("Row 2"),
    }));
  });

  it("does not allow a CSV to exceed the published roster limit", () => {
    expect(() => parseAttendeeRosterCsv(
      [
        "first_name,last_name,attendee_type",
        "Ana,Durant,Adult",
        "Bea,Smith,Teen",
        "Cam,Jones,Child",
      ].join("\n"),
      definition,
    )).toThrowError(AttendeeRosterCsvError);
  });
});
