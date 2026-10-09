import { describe, expect, it } from "vitest";
import { clubFormTemplateSeeds } from "@/modules/club-forms/definitions";
import {
  allFields,
  definitionForLink,
  sanitizeClubFormAnswers,
  splitAnswers,
  templateSpecProblems,
  validateClubFormAnswers,
  withAutoDates,
} from "@/modules/club-forms/domain";
import { fieldDisplayLabel, fieldRuns, formTemplates, registrationFormDefinitionSchema, todayDateValue } from "@/modules/forms/definition";

/**
 * The four seeded templates (#610, field specs from #608): they validate on
 * the registration-form definition schema, mark the right fields sensitive,
 * and accept a complete synthetic answer set.
 */

function seed(key: string) {
  const found = clubFormTemplateSeeds.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`no seed ${key}`);
  return { ...found, definition: registrationFormDefinitionSchema.parse(found.definition) };
}

const membership = () => seed("pathfinder_membership_application");
const staff = () => seed("pathfinder_staff_service_information");
const slip = () => seed("off_premises_permission_slip");
const passengers = () => seed("transportation_passenger_list");

describe("seeded club form templates", () => {
  it("has exactly the four templates, each valid on the registration form schema", () => {
    expect(clubFormTemplateSeeds.map((template) => template.key)).toEqual([
      "pathfinder_membership_application",
      "pathfinder_staff_service_information",
      "off_premises_permission_slip",
      "transportation_passenger_list",
    ]);
    for (const template of clubFormTemplateSeeds) {
      expect(() => registrationFormDefinitionSchema.parse(template.definition), template.key).not.toThrow();
      expect(templateSpecProblems({ ...template, definition: registrationFormDefinitionSchema.parse(template.definition) }), template.key).toEqual([]);
    }
  });

  it("keeps club forms out of the event form builder's template list", () => {
    const builderKeys = new Set(formTemplates.map((template) => template.key));
    for (const template of clubFormTemplateSeeds) expect(builderKeys.has(template.key)).toBe(false);
  });

  it("marks the membership application's birth date sensitive and nothing else", () => {
    expect(membership().sensitiveFieldKeys).toEqual(["birth_date"]);
  });

  it("marks the staff form's health history, unlawful conduct and birth dates sensitive", () => {
    const keys = new Set(staff().sensitiveFieldKeys);
    for (const key of ["health_limitation", "health_limitation_how", "conduct_accused", "conduct_explanation", "conduct_verifier_phone", "birth_date", "child_3_birth_date"]) {
      expect(keys.has(key), key).toBe(true);
    }
    // Ordinary record fields stay readable.
    for (const key of ["full_name", "email", "phone_cell", "reference_1_name", "honor_1_name"]) expect(keys.has(key), key).toBe(false);
  });

  it("marks the permission slip's physician, clinic and emergency contact sensitive", () => {
    expect(new Set(slip().sensitiveFieldKeys)).toEqual(new Set(["physician_name", "physician_phone", "clinic_name", "clinic_phone", "emergency_contact_phone"]));
  });

  it("marks every passenger emergency contact sensitive and offers 20 passengers", () => {
    const keys = passengers().sensitiveFieldKeys;
    expect(keys).toHaveLength(20);
    expect(keys).toContain("passenger_20_emergency_contact");
    const fieldKeys = allFields(passengers().definition).map((field) => field.key);
    expect(fieldKeys).toContain("passenger_20_name");
    expect(fieldKeys).not.toContain("passenger_21_name");
    expect(passengers().printLayout).toBe("PASSENGER_LIST");
  });

  it("carries the staff form's sections, row counts and office-use fields", () => {
    const definition = staff().definition;
    expect(definition.description).toBe("This form is for club files only.");
    expect(definition.sections.map((section) => section.title)).toEqual([
      "Office use only",
      "I. Date of record",
      "Children",
      "II. Health history",
      "III. Educational record",
      "IV. Experience",
      "V. Award instruction ability",
      "VI. Unlawful conduct",
      "VII. References",
      "Signature",
    ]);
    const keys = allFields(definition).map((field) => field.key);
    expect(keys.filter((key) => /^child_\d_name$/.test(key))).toHaveLength(5);
    expect(keys.filter((key) => /^experience_\d_position$/.test(key))).toHaveLength(3);
    expect(keys.filter((key) => /^honor_\d_name$/.test(key))).toHaveLength(8);
    expect(keys.filter((key) => /^reference_\d_name$/.test(key))).toHaveLength(3);
    expect(staff().staffOnlyFieldKeys).toEqual(["office_date_received", "office_date_approved", "office_recommendation", "office_signature"]);
  });

  it("lays each staff reference out as its own group with plain labels, keys unchanged (#856)", () => {
    expect(staff().version).toBe(4);
    const section = staff().definition.sections.find((candidate) => candidate.id === "sec_references")!;
    expect(section.fields.map((field) => field.key)).toEqual([1, 2, 3].flatMap((n) => ["name", "address", "phone"].map((part) => `reference_${n}_${part}`)));
    const runs = fieldRuns(section.fields);
    expect(runs.map((run) => run.group)).toEqual(["1. Pastor", "2. Local reference", "3. Other reference"]);
    for (const run of runs) expect(run.fields.map((field) => field.label)).toEqual(["Name", "Address", "Phone"]);
    expect(fieldDisplayLabel(section.fields[0])).toBe("1. Pastor \u2014 Name");
    expect(fieldDisplayLabel({ label: "Plain" })).toBe("Plain");
    expect(section.fields.filter((field) => field.type === "PHONE")).toHaveLength(3);
    expect(registrationFormDefinitionSchema.parse(staff().definition).sections.find((candidate) => candidate.id === "sec_references")!.fields[0].group).toBe("1. Pastor");
  });

  it("keeps the club-entered fee fields off a private link but on the director's form (#719)", () => {
    const fees = ["registration_fee", "club_dues", "insurance_fee"];
    expect(membership().staffOnlyFieldKeys).toEqual(fees);
    expect(membership().version).toBe(3);
    const linkKeys = allFields(definitionForLink(membership())).map((field) => field.key);
    for (const key of fees) expect(linkKeys).not.toContain(key);
    expect(definitionForLink(membership()).sections.map((section) => section.title)).not.toContain("Fees");
    const directorKeys = allFields(membership().definition).map((field) => field.key);
    for (const key of fees) expect(directorKeys).toContain(key);
    // The change never loosens a sensitive or birth-date flag.
    expect(membership().sensitiveFieldKeys).toEqual(["birth_date"]);
    expect(membership().birthDateFieldKeys).toEqual(["birth_date"]);
    // No seeded field says the club enters it unless it is staff-only.
    for (const template of clubFormTemplateSeeds) {
      for (const field of allFields(registrationFormDefinitionSchema.parse(template.definition))) {
        if (/entered by the club/i.test(field.helpText ?? "")) expect(template.staffOnlyFieldKeys, `${template.key}.${field.key}`).toContain(field.key);
      }
    }
  });

  it("marks the signing and application dates to fill in automatically, and no other date (#719)", () => {
    const auto = Object.fromEntries(clubFormTemplateSeeds.map((template) => [template.key, allFields(registrationFormDefinitionSchema.parse(template.definition)).filter((field) => field.autoDate === "TODAY").map((field) => field.key)]));
    expect(auto).toEqual({
      pathfinder_membership_application: ["applicant_signature_date", "application_date"],
      pathfinder_staff_service_information: ["signature_date"],
      off_premises_permission_slip: ["parent_signature_date"],
      transportation_passenger_list: [],
    });
    // Office-use dates, birth dates and the activity date stay as they were.
    for (const key of ["office_date_received", "office_date_approved", "birth_date", "activity_date"]) {
      for (const template of clubFormTemplateSeeds) expect(auto[template.key]).not.toContain(key);
    }
  });

  it("sets auto-date fields to today in Chicago over whatever was sent, and leaves other answers alone (#719)", () => {
    const definition = slip().definition;
    const answers = { parent_signature_date: "2020-01-01", activity_date: "2026-11-07", child_name: "Riley Sample" };
    const set = withAutoDates(definition, answers, [], new Date("2026-10-06T01:30:00Z"));
    expect(set).toEqual({ parent_signature_date: "2026-10-05", activity_date: "2026-11-07", child_name: "Riley Sample" });
    expect(answers.parent_signature_date).toBe("2020-01-01");
    expect(withAutoDates(definition, {}, ["parent_signature_date"], new Date("2026-10-06T01:30:00Z"))).toEqual({});
  });

  it("rolls the Chicago day over at 05:00Z in daylight time and 06:00Z in standard time (#719)", () => {
    const day = (iso: string) => todayDateValue(new Date(iso));
    // CDT until Nov 1 2026 07:00Z (2:00 local); CST after. CDT again from Mar 14 2027 08:00Z.
    expect(day("2026-10-31T04:59:00Z")).toBe("2026-10-30");
    expect(day("2026-10-31T05:00:00Z")).toBe("2026-10-31");
    expect(day("2026-11-02T05:59:00Z")).toBe("2026-11-01");
    expect(day("2026-11-02T06:00:00Z")).toBe("2026-11-02");
    expect(day("2027-03-13T05:59:00Z")).toBe("2027-03-12");
    expect(day("2027-03-13T06:00:00Z")).toBe("2027-03-13");
    // Mar 14 2027 is the spring-forward day (08:00Z), so it still rolls at 06:00Z; Mar 15 rolls at 05:00Z.
    expect(day("2027-03-14T05:59:00Z")).toBe("2027-03-13");
    expect(day("2027-03-14T06:00:00Z")).toBe("2027-03-14");
    expect(day("2027-03-15T04:59:00Z")).toBe("2027-03-14");
    expect(day("2027-03-15T05:00:00Z")).toBe("2027-03-15");
  });

  it("only lets a date question carry the auto-date setting (#719)", () => {
    const base = { id: "f_x", key: "x_field", label: "Signed on", helpText: "", scope: "REGISTRATION", required: false, options: [] };
    const parse = (type: string) => registrationFormDefinitionSchema.safeParse({
      title: "Sample form", description: "", confirmationMessage: "Thanks",
      sections: [{ id: "sec_x", title: "Section", description: "", fields: [{ ...base, type, autoDate: "TODAY" }] }],
    });
    expect(parse("DATE").error?.issues).toBeUndefined();
    expect(parse("TEXT").success).toBe(false);
  });

  it("hides office-use fields from a private-link filler", () => {
    const visible = allFields(definitionForLink(staff())).map((field) => field.key);
    expect(visible).not.toContain("office_signature");
    expect(visible).not.toContain("office_recommendation");
    expect(visible).toContain("full_name");
    expect(definitionForLink(staff()).sections.map((section) => section.id)).not.toContain("sec_office");
  });

  it("rejects a spec that names a field that is not there or marks one both ways", () => {
    const base = permissionSlipSpec();
    expect(templateSpecProblems({ ...base, sensitiveFieldKeys: ["nope"] })).toHaveLength(1);
    expect(templateSpecProblems({ ...base, staffOnlyFieldKeys: ["physician_name"], sensitiveFieldKeys: ["physician_name"] })).toContain("Field physician_name cannot be both staff-only and sensitive.");
    expect(templateSpecProblems({ ...base, sectionNotes: { missing: ["x"] } })).toHaveLength(1);
    expect(templateSpecProblems({ ...base, birthDateFieldKeys: ["nope"], sensitiveFieldKeys: [...base.sensitiveFieldKeys, "nope"] })).toContain("Birth-date field nope is not in the form.");
    expect(templateSpecProblems({ ...base, birthDateFieldKeys: ["activity_date"] })).toContain("Birth-date field activity_date must also be a sensitive field.");
  });

  it("marks every birth-date field with the birth-date class, and only those", () => {
    expect(membership().birthDateFieldKeys).toEqual(["birth_date"]);
    expect(new Set(staff().birthDateFieldKeys)).toEqual(new Set(["birth_date", "child_1_birth_date", "child_2_birth_date", "child_3_birth_date", "child_4_birth_date", "child_5_birth_date"]));
    expect(slip().birthDateFieldKeys).toEqual([]);
    expect(passengers().birthDateFieldKeys).toEqual([]);
    for (const template of clubFormTemplateSeeds) {
      // Every birth-date class field is also sensitive (sealed), and every field that asks for a birth date is in the class.
      for (const key of template.birthDateFieldKeys) expect(template.sensitiveFieldKeys, `${template.key} ${key}`).toContain(key);
      const birthLabelled = allFields(registrationFormDefinitionSchema.parse(template.definition))
        .filter((field) => field.type === "DATE" && /birth|born/i.test(`${field.key} ${field.label}`))
        .map((field) => field.key);
      expect(new Set(birthLabelled), template.key).toEqual(new Set(template.birthDateFieldKeys));
    }
  });
});

function permissionSlipSpec() {
  const template = slip();
  return { definition: template.definition, sectionNotes: template.sectionNotes, sensitiveFieldKeys: template.sensitiveFieldKeys, birthDateFieldKeys: template.birthDateFieldKeys, staffOnlyFieldKeys: template.staffOnlyFieldKeys };
}

const membershipAnswers = {
  club_name: "Example Pathfinders",
  applicant_signature: "Sam Sample",
  applicant_signature_date: "2026-10-01",
  full_name: "Sam Sample",
  phone: "515-555-0100",
  ay_class: "Friend",
  street: "1 Example Road",
  city: "Exampleville",
  state: "IA",
  zip: "50000",
  grade: "5th",
  church: "Not listed",
  church_other: "Example Church",
  been_pathfinder: "No",
  certified_name: "Sam Sample",
  birth_date: "2015-04-02",
  gender: "Female",
  mother_guardian_signature: "Pat Sample",
  approval_agreement: true,
  application_date: "2026-10-01",
};

/** The directory field's live choices, as `withLiveDirectory` provides them. */
function withDirectory(definition: ReturnType<typeof membership>["definition"]) {
  return {
    ...definition,
    sections: definition.sections.map((section) => ({
      ...section,
      fields: section.fields.map((field) => (field.optionSource ? { ...field, options: ["Example Church", "Not listed"] } : field)),
    })),
  };
}

describe("membership application answers", () => {
  it("accepts a complete synthetic application with one guardian signature", () => {
    const definition = withDirectory(membership().definition);
    const answers = sanitizeClubFormAnswers(definition, membershipAnswers);
    expect(validateClubFormAnswers(definition, answers)).toEqual([]);
  });

  it("needs a guardian signature from at least one parent", () => {
    const definition = withDirectory(membership().definition);
    const { mother_guardian_signature: _removed, ...without } = membershipAnswers;
    void _removed;
    const issues = validateClubFormAnswers(definition, sanitizeClubFormAnswers(definition, without));
    expect(issues.map((issue) => issue.key).sort()).toEqual(["father_guardian_signature", "mother_guardian_signature"]);
  });

  it("reports a missing agreement and a future birth date by label, never by value", () => {
    const definition = withDirectory(membership().definition);
    const answers = sanitizeClubFormAnswers(definition, { ...membershipAnswers, approval_agreement: false, birth_date: "2999-01-01" });
    const issues = validateClubFormAnswers(definition, answers);
    expect(issues.map((issue) => issue.key).sort()).toEqual(["approval_agreement", "birth_date"]);
    expect(JSON.stringify(issues)).not.toContain("2999");
  });

  it("splits the birth date out as the only sensitive answer", () => {
    const definition = withDirectory(membership().definition);
    const { plain, sensitive } = splitAnswers(membership(), sanitizeClubFormAnswers(definition, membershipAnswers));
    expect(Object.keys(sensitive)).toEqual(["birth_date"]);
    expect(plain).not.toHaveProperty("birth_date");
    expect(plain).toHaveProperty("full_name", "Sam Sample");
  });

  it("lets a draft skip required answers but still checks the ones given", () => {
    const definition = withDirectory(membership().definition);
    expect(validateClubFormAnswers(definition, sanitizeClubFormAnswers(definition, { full_name: "Sam Sample" }), { draft: true })).toEqual([]);
    const bad = sanitizeClubFormAnswers(definition, { ay_class: "Wizard" });
    expect(validateClubFormAnswers(definition, bad, { draft: true }).map((issue) => issue.key)).toEqual(["ay_class"]);
  });
});

describe("staff form answers", () => {
  const base = {
    full_name: "Alex Volunteer",
    birth_date: "1985-06-15",
    gender: "Male",
    street: "2 Example Road",
    city: "Exampleville",
    state: "MO",
    zip: "64000",
    email: "alex@example.test",
    church: "Example Church",
    club: "Example Club",
    health_limitation: "No",
    conduct_accused: "No",
    reference_1_name: "Pastor Example",
    reference_1_address: "3 Example Road",
    reference_1_phone: "515-555-0101",
    reference_2_name: "Local Example",
    reference_2_address: "4 Example Road",
    reference_2_phone: "515-555-0102",
    reference_3_name: "Other Example",
    reference_3_address: "5 Example Road",
    reference_3_phone: "515-555-0103",
    signature: "Alex Volunteer",
    signature_date: "2026-10-02",
    signature_acknowledgment: true,
  };
  const definition = () => {
    const directory = staff().definition;
    return {
      ...directory,
      sections: directory.sections.map((section) => ({
        ...section,
        fields: section.fields.map((field) => (field.optionSource ? { ...field, options: ["Example Church", "Example Club", "Not listed"] } : field)),
      })),
    };
  };

  it("accepts a complete answer set", () => {
    const answers = sanitizeClubFormAnswers(definition(), base, staff().staffOnlyFieldKeys);
    expect(validateClubFormAnswers(definition(), answers, { excludeKeys: staff().staffOnlyFieldKeys })).toEqual([]);
  });

  it("requires the explanation and verifier only when a health limit or conduct answer is Yes", () => {
    const answers = sanitizeClubFormAnswers(definition(), { ...base, health_limitation: "Yes", conduct_accused: "Yes" }, staff().staffOnlyFieldKeys);
    const keys = validateClubFormAnswers(definition(), answers, { excludeKeys: staff().staffOnlyFieldKeys }).map((issue) => issue.key);
    expect(keys).toContain("health_limitation_how");
    expect(keys).toContain("conduct_explanation");
    expect(keys).toContain("conduct_verifier_phone");
  });

  it("drops hidden follow-ups and office-use answers a hand-made request sends", () => {
    const answers = sanitizeClubFormAnswers(
      definition(),
      { ...base, health_limitation_how: "should be dropped", office_signature: "Not yours to write" },
      staff().staffOnlyFieldKeys,
    );
    expect(answers).not.toHaveProperty("health_limitation_how");
    expect(answers).not.toHaveProperty("office_signature");
  });

  it("splits health and conduct answers into the sensitive half", () => {
    const answers = sanitizeClubFormAnswers(definition(), { ...base, health_limitation: "Yes", health_limitation_how: "Sample limitation text" }, staff().staffOnlyFieldKeys);
    const { plain, sensitive } = splitAnswers(staff(), answers);
    expect(sensitive).toMatchObject({ health_limitation: "Yes", health_limitation_how: "Sample limitation text", conduct_accused: "No", birth_date: "1985-06-15" });
    expect(JSON.stringify(plain)).not.toContain("Sample limitation text");
  });
});

describe("permission slip and passenger list answers", () => {
  it("accepts a complete permission slip and seals the medical block", () => {
    const template = slip();
    const answers = sanitizeClubFormAnswers(template.definition, {
      child_name: "Riley Sample",
      street: "6 Example Road",
      city: "Exampleville",
      state: "IA",
      zip: "50001",
      phone: "515-555-0110",
      activity: "Canoe trip",
      activity_date: "2026-11-07",
      ride_with: "Pat Sample",
      parent_signature: "Pat Sample",
      parent_signature_date: "2026-10-30",
      relationship: "Parent",
      physician_name: "Dr. Example",
      emergency_contact_phone: "515-555-0111",
    });
    expect(validateClubFormAnswers(template.definition, answers)).toEqual([]);
    const { plain, sensitive } = splitAnswers(template, answers);
    expect(Object.keys(sensitive).sort()).toEqual(["emergency_contact_phone", "physician_name"]);
    expect(plain).toHaveProperty("activity", "Canoe trip");
  });

  it("requires the emergency contact phone on the slip", () => {
    const keys = validateClubFormAnswers(slip().definition, {}).map((issue) => issue.key);
    expect(keys).toContain("emergency_contact_phone");
  });

  it("needs one passenger and the four contacts, and seals emergency contacts", () => {
    const template = passengers();
    expect(validateClubFormAnswers(template.definition, {}).map((issue) => issue.key).sort()).toEqual([
      "contact_cell", "contact_name", "driver_cell", "driver_name", "passenger_1_name",
    ]);
    const answers = sanitizeClubFormAnswers(template.definition, {
      contact_name: "Dana Director",
      contact_cell: "515-555-0120",
      driver_name: "Drew Driver",
      driver_cell: "515-555-0121",
      passenger_1_name: "Riley Sample",
      passenger_1_phone: "515-555-0122",
      passenger_1_emergency_contact: "Pat Sample 515-555-0123",
      passenger_20_name: "Last Passenger",
    });
    expect(validateClubFormAnswers(template.definition, answers)).toEqual([]);
    const { plain, sensitive } = splitAnswers(template, answers);
    expect(sensitive).toEqual({ passenger_1_emergency_contact: "Pat Sample 515-555-0123" });
    expect(plain).toHaveProperty("passenger_20_name", "Last Passenger");
  });
});
