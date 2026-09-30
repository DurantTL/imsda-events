import { describe, expect, it } from "vitest";
import { directorContactPrefill, fillBlankAnswers } from "@/modules/club-registrations/contact-prefill";
import { rosterOwnedResponses } from "@/modules/club-registrations/domain";
import type { RegistrationFormDefinition, RegistrationFormField } from "@/modules/forms/definition";

const director = { firstName: "Avery", lastName: "Director", email: "director@example.test", mobile: "555-0100" };

function field(key: string, label: string, type: RegistrationFormField["type"], extra: Partial<RegistrationFormField> = {}): RegistrationFormField {
  return { id: key, key, label, type, required: false, scope: "REGISTRATION", options: [], ...extra } as RegistrationFormField;
}

function form(...fields: RegistrationFormField[]): RegistrationFormDefinition {
  return {
    title: "Synthetic club event", description: "", confirmationMessage: "",
    attendeeRoster: { enabled: true, minAttendees: 1, maxAttendees: 50, attendeeLabel: "Member", addButtonLabel: "Add" },
    sections: [{ id: "s1", title: "Club", description: "", fields }],
  } as unknown as RegistrationFormDefinition;
}

describe("director contact auto-fill (#618)", () => {
  it("fills the director's name, email and mobile phone from their profile", () => {
    const definition = form(
      field("director_name", "Club director", "TEXT"),
      field("email", "Email", "EMAIL"),
      field("phone", "Mobile phone", "PHONE"),
    );
    expect(directorContactPrefill(definition, director)).toEqual({
      director_name: "Avery Director", email: "director@example.test", phone: "555-0100",
    });
  });

  it("maps by field type when a form names its fields differently", () => {
    const definition = form(field("reach_us", "Best email to reach you", "EMAIL"), field("cell", "Cell", "PHONE"));
    expect(directorContactPrefill(definition, director)).toEqual({ reach_us: "director@example.test", cell: "555-0100" });
  });

  it("leaves other people's contact fields, and empty profile values, alone", () => {
    const definition = form(
      field("treasurer_email", "Treasurer email", "EMAIL"),
      field("emergency_phone", "Emergency contact phone", "PHONE"),
      field("phone", "Mobile phone", "PHONE"),
    );
    expect(directorContactPrefill(definition, director)).toEqual({ phone: "555-0100" });
    expect(directorContactPrefill(definition, { ...director, mobile: "" })).toEqual({});
  });

  it("with several fields of one type and no key match, fills only the first", () => {
    const definition = form(field("first_email", "Contact email", "EMAIL"), field("other_email", "Another email", "EMAIL"));
    expect(directorContactPrefill(definition, director)).toEqual({ first_email: "director@example.test" });
  });

  it("never fills the club directory fields, an attendee field, or a date", () => {
    const definition = form(
      field("club_name", "Club", "SELECT", { optionSource: "CLUBS_DIRECTORY" }),
      field("email", "Attendee email", "EMAIL", { scope: "ATTENDEE" }),
      field("dob", "Birth date", "DATE"),
    );
    expect(directorContactPrefill(definition, director)).toEqual({});
  });

  it("does not put a birth date into a roster person's answers (ADR 0005 Addendum A)", () => {
    const definition = form(field("first_name", "First name", "TEXT", { scope: "ATTENDEE" }), field("last_name", "Last name", "TEXT", { scope: "ATTENDEE" }));
    const answers = rosterOwnedResponses(definition, { firstName: "Alex", lastName: "Youth", ageOnEventDate: 12, gender: null });
    expect(answers).toEqual({ first_name: "Alex", last_name: "Youth" });
    expect(JSON.stringify(answers)).not.toMatch(/birth|dob|\d{4}-\d{2}-\d{2}/i);
  });
});

describe("pre-filled values never overwrite what was typed (#618)", () => {
  it("keeps typed and saved answers and fills only blanks", () => {
    const prefill = { director_name: "Avery Director", email: "director@example.test", phone: "555-0100" };
    expect(fillBlankAnswers({ director_name: "Typed Name", email: "  ", phone: undefined }, prefill)).toEqual({
      director_name: "Typed Name", email: "director@example.test", phone: "555-0100",
    });
    expect(fillBlankAnswers(undefined, prefill)).toEqual(prefill);
    expect(fillBlankAnswers({ other: "kept" }, prefill)).toMatchObject({ other: "kept", email: "director@example.test" });
  });
});
