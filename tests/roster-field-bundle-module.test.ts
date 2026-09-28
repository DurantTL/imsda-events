import { describe, expect, it } from "vitest";
import {
  instantiateModuleFields,
  moduleKeyCollisions,
  promoCodeBuilderModule,
  resolveModuleFieldKeyMap,
  rosterFieldBundleModule,
} from "@/modules/forms/builder-modules";
import { RADIO_CARD_MAX_OPTIONS, suggestedSingleChoiceType } from "@/modules/forms/choice-defaults";
import { registrationFormDefinitionSchema, type RegistrationFormDefinition } from "@/modules/forms/definition";
import { birthDateFields, rosterGenderPrefill, rosterRolePrefill } from "@/modules/club-registrations/domain";

function idFactory(prefix = "field") {
  let counter = 0;
  return () => { counter += 1; return `${prefix}_${counter}`; };
}

function formWithFields(fields: Array<{ id: string } & Record<string, unknown>>): RegistrationFormDefinition {
  return registrationFormDefinitionSchema.parse({
    title: "Roster bundle fixture",
    description: "",
    confirmationMessage: "Saved.",
    attendeeRoster: { enabled: true, minAttendees: 1, maxAttendees: 20, attendeeLabel: "Attendee", addButtonLabel: "Add another attendee" },
    sections: [{ id: "roster_section", title: "Roster", description: "", fields }],
  });
}

function insertedBundleFields() {
  return instantiateModuleFields(rosterFieldBundleModule, new Set(), idFactory());
}

describe("roster field bundle module (#484)", () => {
  it("inserts name, age, gender, role, class, and skills/induction as one bundle", () => {
    expect(rosterFieldBundleModule.key).toBe("roster_bundle");
    expect(rosterFieldBundleModule.category).toBe("People");
    const keys = rosterFieldBundleModule.fields.map((field) => field.key);
    expect(keys).toEqual([
      "attendee_name",
      "attendee_age",
      "gender",
      "attendee_type",
      "attendee_class",
      "skills_in_progress",
      "induction_ready",
    ]);
    for (const field of rosterFieldBundleModule.fields) {
      expect(field.scope).toBe("ATTENDEE");
    }
  });

  it("offers age only — never a hint toward collecting a birth date (#484 B2)", () => {
    const age = rosterFieldBundleModule.fields.find((field) => field.key === "attendee_age")!;
    expect(age.type).toBe("NUMBER");
    expect(age.label.toLowerCase()).not.toContain("birth");
    expect(age.helpText.toLowerCase()).not.toContain("birth");
    expect(age.helpText.toLowerCase()).not.toContain("date");
  });

  it("never produces a field club registration would refuse as a birth date (ADR 0005 Addendum A)", () => {
    const definition = formWithFields(insertedBundleFields());
    expect(birthDateFields(definition)).toEqual([]);
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

  it("uses the same attendee_type role key roster-cards.ts/roster-summary.ts already look for (#483)", () => {
    const roleField = rosterFieldBundleModule.fields.find((field) => field.key === "attendee_type")!;
    expect(roleField.type).toBe("RADIO");
    expect(roleField.required).toBe(true);
  });

  it("uses the same role options as the Spring Camporee / Honors Weekend \"Roster role\" templates", () => {
    const roleField = rosterFieldBundleModule.fields.find((field) => field.key === "attendee_type")!;
    expect(roleField.options).toEqual(["Pathfinder", "TLT", "Staff", "Child"]);
  });

  it("uses the plain gender key so the #483 roster gender prefill and mismatch prompt work (N1)", () => {
    const genderField = rosterFieldBundleModule.fields.find((field) => field.key === "gender")!;
    expect(genderField.type).toBe("RADIO");
    expect(genderField.options).toEqual(["Female", "Male"]);
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
  });

  it("is a singleton, like the promo-code module, so a second insert doesn't lose the #483 hooks to key-suffixing", () => {
    expect(rosterFieldBundleModule.singleton).toBe(true);
    expect(promoCodeBuilderModule.singleton).toBe(true);
  });

  it("turns on the repeatable attendee roster like guest_roster already does", () => {
    expect(rosterFieldBundleModule.enablesAttendeeRoster).toBe(true);
    expect(rosterFieldBundleModule.attendeeRosterDefaults?.attendeeLabel).toBe("Attendee");
  });

  it("every field key is unique within the bundle", () => {
    const keys = rosterFieldBundleModule.fields.map((field) => field.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("prefills gender from a roster person once inserted", () => {
    const definition = formWithFields(insertedBundleFields());
    expect(rosterGenderPrefill(definition, { firstName: "A", lastName: "B", ageOnEventDate: 12, gender: "FEMALE" })).toEqual({ gender: "Female" });
    expect(rosterGenderPrefill(definition, { firstName: "A", lastName: "B", ageOnEventDate: 12, gender: "MALE" })).toEqual({ gender: "Male" });
  });

  it("prefills role from a roster person's role once inserted", () => {
    const definition = formWithFields(insertedBundleFields());
    expect(rosterRolePrefill(definition, { firstName: "A", lastName: "B", ageOnEventDate: 12, gender: null, role: "Pathfinder" })).toEqual({ attendee_type: "Pathfinder" });
    expect(rosterRolePrefill(definition, { firstName: "A", lastName: "B", ageOnEventDate: 30, gender: null, attendeeType: "STAFF" })).toEqual({ attendee_type: "Staff" });
  });
});

describe("module insertion and collision remapping (#484 B1)", () => {
  it("resolves each module field to its own key when nothing collides", () => {
    const keys = resolveModuleFieldKeyMap(rosterFieldBundleModule, new Set());
    expect(keys.get("attendee_type")).toBe("attendee_type");
    expect(keys.get("gender")).toBe("gender");
  });

  it("suffixes a colliding key and keeps it stable across the whole map", () => {
    const keys = resolveModuleFieldKeyMap(rosterFieldBundleModule, new Set(["attendee_type"]));
    expect(keys.get("attendee_type")).toBe("attendee_type_2");
  });

  it("reports collisions against the module's own field keys", () => {
    expect(moduleKeyCollisions(rosterFieldBundleModule, new Set())).toEqual([]);
    expect(moduleKeyCollisions(rosterFieldBundleModule, new Set(["attendee_type", "gender"]))).toEqual(["gender", "attendee_type"]);
  });

  it("remaps an internal conditional reference (skills/induction -> role) to the role field's suffixed key", () => {
    const fields = instantiateModuleFields(rosterFieldBundleModule, new Set(["attendee_type"]), idFactory());
    const role = fields.find((field) => field.label === "Roster role")!;
    const skills = fields.find((field) => field.key === "skills_in_progress")!;
    const induction = fields.find((field) => field.key === "induction_ready")!;
    expect(role.key).toBe("attendee_type_2");
    expect(skills.conditional).toEqual({ fieldKey: "attendee_type_2", operator: "EQUALS", value: "Pathfinder" });
    expect(induction.conditional).toEqual({ fieldKey: "attendee_type_2", operator: "EQUALS", value: "Pathfinder" });
  });

  it("inserting a module twice remaps both the field keys and every conditional they carry", () => {
    const first = instantiateModuleFields(rosterFieldBundleModule, new Set(), idFactory("f1"));
    const usedAfterFirst = new Set(first.map((field) => field.key));
    const second = instantiateModuleFields(rosterFieldBundleModule, usedAfterFirst, idFactory("f2"));

    expect(first.map((field) => field.key)).toEqual([
      "attendee_name", "attendee_age", "gender", "attendee_type", "attendee_class", "skills_in_progress", "induction_ready",
    ]);
    expect(second.map((field) => field.key)).toEqual([
      "attendee_name_2", "attendee_age_2", "gender_2", "attendee_type_2", "attendee_class_2", "skills_in_progress_2", "induction_ready_2",
    ]);
    const secondSkills = second.find((field) => field.key === "skills_in_progress_2")!;
    expect(secondSkills.conditional).toEqual({ fieldKey: "attendee_type_2", operator: "EQUALS", value: "Pathfinder" });
    // Every id from every insert is unique too.
    expect(new Set([...first, ...second].map((field) => field.id)).size).toBe(first.length + second.length);
  });

  it("applies the size default to a module's own RADIO/SELECT fields at insertion, overriding whatever the module data declares", () => {
    const longModule = {
      key: "long_list_fixture",
      category: "Common" as const,
      name: "Long list fixture",
      description: "",
      fields: [{
        key: "long_choice",
        label: "Long choice",
        helpText: "",
        type: "RADIO" as const, // deliberately mismatched: 12 options should get SELECT
        scope: "REGISTRATION" as const,
        required: true,
        options: Array.from({ length: 12 }, (_, index) => `Option ${index + 1}`),
      }],
    };
    const [field] = instantiateModuleFields(longModule, new Set(), idFactory());
    expect(field.type).toBe("SELECT");
  });

  it("leaves an attendee-types-sourced field's type alone (its options aren't builder-configured)", () => {
    const sourcedModule = {
      key: "sourced_fixture",
      category: "Common" as const,
      name: "Sourced fixture",
      description: "",
      fields: [{
        key: "sourced_choice",
        label: "Sourced choice",
        helpText: "",
        type: "RADIO" as const,
        scope: "ATTENDEE" as const,
        required: true,
        options: Array.from({ length: 12 }, (_, index) => `Option ${index + 1}`),
        optionSource: "ATTENDEE_TYPES" as const,
      }],
    };
    const [field] = instantiateModuleFields(sourcedModule, new Set(), idFactory());
    expect(field.type).toBe("RADIO");
  });
});
