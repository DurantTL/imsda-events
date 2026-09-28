import { describe, expect, it } from "vitest";
import {
  builderFieldModules,
  instantiateModuleFields,
  moduleInsertNotice,
  moduleKeyCollisions,
  planModuleInsert,
  promoCodeBuilderModule,
  resolveModuleFieldKeyMap,
  rosterFieldBundleModule,
} from "@/modules/forms/builder-modules";
import { RADIO_CARD_MAX_OPTIONS, suggestedSingleChoiceType } from "@/modules/forms/choice-defaults";
import { getFormTemplate, registrationFormDefinitionSchema, type RegistrationFormDefinition } from "@/modules/forms/definition";
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

  it("gives the class field exactly the radio-card threshold's worth of options, declared as radio cards in the data", () => {
    const classField = rosterFieldBundleModule.fields.find((field) => field.key === "attendee_class")!;
    expect(classField.options).toHaveLength(RADIO_CARD_MAX_OPTIONS);
    expect(classField.type).toBe(suggestedSingleChoiceType(classField.options.length));
    expect(classField.type).toBe("RADIO");
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

  it("treats the bundle as already present only when its own distinctive keys exist (N1)", () => {
    expect(moduleKeyCollisions(rosterFieldBundleModule, new Set())).toEqual([]);
    expect(moduleKeyCollisions(rosterFieldBundleModule, new Set(["attendee_type", "gender", "attendee_age", "attendee_name"]))).toEqual([]);
    expect(moduleKeyCollisions(rosterFieldBundleModule, new Set(["attendee_class"]))).toEqual(["attendee_class"]);
    expect(moduleKeyCollisions(rosterFieldBundleModule, new Set(["skills_in_progress"]))).toEqual(["skills_in_progress"]);
  });

  it("a singleton without presenceKeys (promo code) is present whenever any of its keys is", () => {
    expect(moduleKeyCollisions(promoCodeBuilderModule, new Set(["promo_code"]))).toEqual(["promo_code"]);
    expect(moduleKeyCollisions(promoCodeBuilderModule, new Set(["other"]))).toEqual([]);
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

  it("keeps the type a module declares at insertion, even when it doesn't match the size suggestion (N2)", () => {
    const longModule = {
      key: "long_list_fixture",
      category: "Common" as const,
      name: "Long list fixture",
      description: "",
      fields: [{
        key: "long_choice",
        label: "Long choice",
        helpText: "",
        type: "RADIO" as const, // deliberately mismatched with the size suggestion
        scope: "REGISTRATION" as const,
        required: true,
        options: Array.from({ length: 12 }, (_, index) => `Option ${index + 1}`),
      }, {
        key: "short_choice",
        label: "Short choice",
        helpText: "",
        type: "SELECT" as const,
        scope: "REGISTRATION" as const,
        required: true,
        options: ["One", "Two"],
      }],
    };
    const fields = instantiateModuleFields(longModule, new Set(), idFactory());
    expect(fields.map((field) => field.type)).toEqual(["RADIO", "SELECT"]);
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

describe("builder module data follows the choice size rule (#484)", () => {
  it("declares every builder-configured single-choice field with the suggested control", () => {
    const mismatched = builderFieldModules.flatMap((module) => module.fields
      .filter((field) => (field.type === "RADIO" || field.type === "SELECT") && !field.optionSource)
      .filter((field) => field.type !== suggestedSingleChoiceType(field.options.length))
      .map((field) => `${module.key}.${field.key} (${field.type}, ${field.options.length} options)`));
    expect(mismatched).toEqual([]);
  });

  it("declares the Attendee preferences module's 4-option meal preference as radio cards", () => {
    const attendee = builderFieldModules.find((module) => module.key === "attendee")!;
    const meal = attendee.fields.find((field) => field.key === "meal_preference")!;
    expect(meal.options).toHaveLength(4);
    expect(meal.type).toBe("RADIO");
  });

  it("keeps long directories (home church, shirt size) as searchable dropdowns", () => {
    const church = builderFieldModules.find((module) => module.key === "church_club")!.fields.find((field) => field.key === "church_name")!;
    expect(church.type).toBe("SELECT");
    expect(church.options.length).toBeGreaterThan(RADIO_CARD_MAX_OPTIONS);
  });

  it("includes the roster bundle and promo code modules, each once, with unique module keys", () => {
    const keys = builderFieldModules.map((module) => module.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(builderFieldModules).toContain(rosterFieldBundleModule);
    expect(builderFieldModules).toContain(promoCodeBuilderModule);
  });
});

describe("inserting the roster bundle into a form that already has some of its fields (N1)", () => {
  function allFields(definition: RegistrationFormDefinition) {
    return definition.sections.flatMap((section) => section.fields);
  }

  function insertInto(definition: RegistrationFormDefinition) {
    return planModuleInsert(rosterFieldBundleModule, allFields(definition), idFactory("new"));
  }

  it("adds only the missing fields to the Spring Camporee starter template and reuses its role field", () => {
    const template = getFormTemplate("spring_camporee_export")!;
    expect(template).toBeDefined();
    const existingKeys = new Set(allFields(template.definition).map((field) => field.key));
    // Guard the fixture: this template carries some, not all, of the bundle's keys.
    expect(["attendee_age", "gender", "attendee_type"].every((key) => existingKeys.has(key))).toBe(true);
    expect(existingKeys.has("attendee_class")).toBe(false);

    const plan = insertInto(template.definition);
    if (plan.kind !== "insert") throw new Error("expected an insert");
    expect(plan.fields.map((field) => field.key)).toEqual(["attendee_name", "attendee_class", "skills_in_progress", "induction_ready"]);
    expect(plan.reusedLabels).toEqual(["Age", "Gender", "Roster role"]);
    const skills = plan.fields.find((field) => field.key === "skills_in_progress")!;
    const induction = plan.fields.find((field) => field.key === "induction_ready")!;
    expect(skills.conditional?.fieldKey).toBe("attendee_type");
    expect(induction.conditional?.fieldKey).toBe("attendee_type");
    expect(moduleInsertNotice(plan)).toBe(
      "Added Name, Current class, Skills / honors in progress and Ready for induction / investiture; this form already had Age, Gender and Roster role.",
    );

    // The result is still a valid definition, with no suffixed duplicate keys.
    const [first, ...rest] = template.definition.sections;
    const roster = rest.find((section) => section.id === "sc_roster")!;
    const next = {
      ...template.definition,
      sections: [first, ...rest.map((section) => section === roster ? { ...section, fields: [...section.fields, ...plan.fields] } : section)],
    };
    const parsed = registrationFormDefinitionSchema.safeParse(next);
    expect(parsed.success).toBe(true);
    const keys = allFields(next).map((field) => field.key);
    expect(keys.some((key) => /_\d+$/.test(key) && key.startsWith("attendee_"))).toBe(false);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("adds only the missing fields after the Attendee preferences module", () => {
    const attendeeModule = builderFieldModules.find((module) => module.key === "attendee")!;
    const existing = instantiateModuleFields(attendeeModule, new Set(), idFactory("att"));
    const plan = planModuleInsert(rosterFieldBundleModule, existing, idFactory("new"));
    if (plan.kind !== "insert") throw new Error("expected an insert");
    expect(plan.fields.map((field) => field.key)).toEqual(["attendee_age", "gender", "attendee_class", "skills_in_progress", "induction_ready"]);
    expect(plan.reusedLabels).toEqual(["Attendee name", "Attendee type"]);
  });

  it("inserts the whole bundle, with no notice, on a form that has none of its keys", () => {
    const plan = planModuleInsert(rosterFieldBundleModule, [], idFactory());
    if (plan.kind !== "insert") throw new Error("expected an insert");
    expect(plan.fields).toHaveLength(rosterFieldBundleModule.fields.length);
    expect(plan.reusedLabels).toEqual([]);
    expect(moduleInsertNotice(plan)).toBeNull();
  });

  it("refuses a second insert once the bundle's own fields are on the form", () => {
    const first = planModuleInsert(rosterFieldBundleModule, [], idFactory("f1"));
    if (first.kind !== "insert") throw new Error("expected an insert");
    const second = planModuleInsert(rosterFieldBundleModule, first.fields, idFactory("f2"));
    expect(second).toEqual({ kind: "already-present", existingKeys: ["attendee_class", "skills_in_progress"] });
  });

  it("still key-suffixes an ordinary (non-singleton) module on a repeat insert", () => {
    const guest = builderFieldModules.find((module) => module.key === "guest_roster")!;
    const first = planModuleInsert(guest, [], idFactory("g1"));
    if (first.kind !== "insert") throw new Error("expected an insert");
    const second = planModuleInsert(guest, first.fields, idFactory("g2"));
    if (second.kind !== "insert") throw new Error("expected an insert");
    expect(second.fields.map((field) => field.key)).toEqual(["guest_name_2", "guest_age_2", "guest_type_2"]);
    expect(moduleInsertNotice(second)).toBeNull();
  });

  it("refuses the promo code module when the form already has it", () => {
    const plan = planModuleInsert(promoCodeBuilderModule, [{ key: "promo_code", label: "Promo code" }], idFactory());
    expect(plan.kind).toBe("already-present");
  });
});
