import { describe, expect, it } from "vitest";
import { rosterFieldBundleModule } from "@/modules/forms/builder-modules";
import { RADIO_CARD_MAX_OPTIONS, suggestedSingleChoiceType } from "@/modules/forms/choice-defaults";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";

function formWithBundle() {
  return registrationFormDefinitionSchema.parse({
    title: "Roster bundle fixture",
    description: "",
    confirmationMessage: "Saved.",
    attendeeRoster: { enabled: true, minAttendees: 1, maxAttendees: 20, attendeeLabel: "Attendee", addButtonLabel: "Add another attendee" },
    sections: [{
      id: "roster_section",
      title: "Roster",
      description: "",
      fields: rosterFieldBundleModule.fields.map((field, index) => ({ ...field, id: `bundle_field_${index}` })),
    }],
  });
}

describe("roster field bundle module (#484)", () => {
  it("inserts name, age, gender, role, class, and skills/induction as one bundle", () => {
    expect(rosterFieldBundleModule.key).toBe("roster_bundle");
    expect(rosterFieldBundleModule.category).toBe("People");
    const keys = rosterFieldBundleModule.fields.map((field) => field.key);
    expect(keys).toEqual([
      "attendee_name",
      "attendee_age",
      "attendee_gender",
      "attendee_type",
      "attendee_class",
      "skills_in_progress",
      "induction_ready",
    ]);
    // Every field is a plain, independently editable field: no field type or
    // property is unique to the bundle, only the pre-filled values are.
    for (const field of rosterFieldBundleModule.fields) {
      expect(field.scope).toBe("ATTENDEE");
    }
  });

  it("validates as a complete, well-formed attendee roster once inserted", () => {
    const result = registrationFormDefinitionSchema.safeParse({
      title: "Roster bundle fixture",
      description: "",
      confirmationMessage: "Saved.",
      attendeeRoster: { enabled: true, minAttendees: 1, maxAttendees: 20, attendeeLabel: "Attendee", addButtonLabel: "Add another attendee" },
      sections: [{
        id: "roster_section",
        title: "Roster",
        description: "",
        fields: rosterFieldBundleModule.fields.map((field, index) => ({ ...field, id: `bundle_field_${index}` })),
      }],
    });
    expect(result.success).toBe(true);
  });

  it("uses the same attendee_type role key the roster summary and attendee cards already look for (#483)", () => {
    const roleField = rosterFieldBundleModule.fields.find((field) => field.key === "attendee_type")!;
    expect(roleField.type).toBe("RADIO");
    expect(roleField.required).toBe(true);
  });

  it("shows skills and induction only conditional on the role field", () => {
    const skills = rosterFieldBundleModule.fields.find((field) => field.key === "skills_in_progress")!;
    const induction = rosterFieldBundleModule.fields.find((field) => field.key === "induction_ready")!;
    expect(skills.conditional).toEqual({ fieldKey: "attendee_type", operator: "EQUALS", value: "Pathfinder" });
    expect(induction.conditional).toEqual({ fieldKey: "attendee_type", operator: "EQUALS", value: "Pathfinder" });
  });

  it("names the induction field so the existing roster summary counts it automatically", () => {
    const induction = rosterFieldBundleModule.fields.find((field) => field.key === "induction_ready")!;
    expect(induction.type).toBe("CHECKBOX");
    expect(`${induction.key} ${induction.label}`).toMatch(/induct/i);
  });

  it("gives the class field exactly the radio-card threshold's worth of options, matching the size default", () => {
    const classField = rosterFieldBundleModule.fields.find((field) => field.key === "attendee_class")!;
    expect(classField.options).toHaveLength(RADIO_CARD_MAX_OPTIONS);
    expect(suggestedSingleChoiceType(classField.options.length)).toBe("RADIO");
    expect(classField.type).toBe("RADIO");
  });

  it("every field key is unique within the bundle", () => {
    const keys = rosterFieldBundleModule.fields.map((field) => field.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("satisfies the repeatable-roster name requirement on its own", () => {
    const definition = formWithBundle();
    expect(definition.attendeeRoster?.enabled).toBe(true);
  });
});
