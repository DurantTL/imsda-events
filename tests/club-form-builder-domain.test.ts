import { describe, expect, it } from "vitest";
import {
  addField,
  addSection,
  moveField,
  moveItem,
  optionsFromText,
  removeField,
  removeSection,
  renameFieldKey,
  sectionNotesFromText,
  setFieldFlag,
  updateField,
} from "@/components/club-form-builder-state";
import {
  blankClubFormSpec,
  checkClubFormDraft,
  copySpec,
  newlySensitiveKeys,
  NO_PROTECTION_HISTORY,
  specFromRecord,
  templateKeyFromName,
  type ClubFormDraftSpec,
  type ClubFormProtectionHistory,
} from "@/modules/club-forms/builder-domain";
import { clubFormTemplateSeeds } from "@/modules/club-forms/definitions";
import { fillDefinition, definitionForLink, allFields, parseClubFormTemplate } from "@/modules/club-forms/domain";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";

function seedSpec(key: string): ClubFormDraftSpec {
  const seed = clubFormTemplateSeeds.find((candidate) => candidate.key === key)!;
  return specFromRecord({
    name: seed.name,
    description: seed.description,
    definition: registrationFormDefinitionSchema.parse(seed.definition),
    sectionNotes: seed.sectionNotes,
    sensitiveFieldKeys: seed.sensitiveFieldKeys,
    birthDateFieldKeys: seed.birthDateFieldKeys,
    staffOnlyFieldKeys: seed.staffOnlyFieldKeys,
    hiddenFieldKeys: [],
    printLayout: seed.printLayout,
    sortOrder: seed.sortOrder,
  });
}

const history = (spec: ClubFormDraftSpec, hasSubmissions = true): ClubFormProtectionHistory => ({
  everSensitiveKeys: spec.sensitiveFieldKeys,
  everBirthDateKeys: spec.birthDateFieldKeys,
  hasSubmissions,
  publishedFieldKeys: allFields(spec.definition).map((field) => field.key),
});

describe("the draft check uses the shared form schema (#712)", () => {
  it("accepts every seeded club form unchanged", () => {
    for (const seed of clubFormTemplateSeeds) {
      const spec = seedSpec(seed.key);
      const check = checkClubFormDraft(spec, history(spec));
      expect(check.issues, seed.key).toEqual([]);
      expect(check.ok).toBe(true);
    }
  });

  it("accepts a blank form", () => {
    expect(checkClubFormDraft(blankClubFormSpec("Synthetic Skills Form"), NO_PROTECTION_HISTORY).ok).toBe(true);
  });

  it("reports duplicate field keys on the field", () => {
    const spec = addField(blankClubFormSpec("Synthetic Form"), "section_main");
    const second = spec.definition.sections[0].fields[1];
    const duplicate = updateField(spec, second.id, { key: "full_name" } as never);
    const check = checkClubFormDraft(duplicate, NO_PROTECTION_HISTORY);
    expect(check.ok).toBe(false);
    expect(check.issues).toEqual(expect.arrayContaining([{ key: `field:${second.id}`, message: expect.stringContaining("already in use") }]));
  });

  it("reports bad choices and ranked-choice limits on the field", () => {
    const base = blankClubFormSpec("Synthetic Form");
    const withRanked = addField(base, "section_main");
    const field = withRanked.definition.sections[0].fields[1];
    const ranked = updateField(withRanked, field.id, { type: "RANKED_CHOICE", options: ["One", "Two", "Three"], minSelections: 3, maxSelections: 2 });
    const check = checkClubFormDraft(ranked, NO_PROTECTION_HISTORY);
    expect(check.ok).toBe(false);
    expect(check.issues.some((issue) => issue.key === `field:${field.id}` && /Minimum selections/.test(issue.message))).toBe(true);

    const oneChoice = updateField(withRanked, field.id, { type: "SELECT", options: ["Only one"] });
    // The builder state keeps two default choices; a single choice must still be refused by the server.
    const single = { ...oneChoice, definition: { ...oneChoice.definition, sections: oneChoice.definition.sections.map((section) => ({ ...section, fields: section.fields.map((candidate) => (candidate.id === field.id ? { ...candidate, options: ["Only one"] } : candidate)) })) } };
    const singleCheck = checkClubFormDraft(single, NO_PROTECTION_HISTORY);
    expect(singleCheck.issues.some((issue) => issue.key === `field:${field.id}` && /at least two choices/.test(issue.message))).toBe(true);
  });

  it("accepts a ranked choice with its minimum and maximum", () => {
    const base = addField(blankClubFormSpec("Synthetic Form"), "section_main");
    const field = base.definition.sections[0].fields[1];
    const ranked = updateField(base, field.id, { type: "RANKED_CHOICE", options: ["One", "Two", "Three"], minSelections: 2, maxSelections: 3 });
    expect(checkClubFormDraft(ranked, NO_PROTECTION_HISTORY).ok).toBe(true);
  });

  it("refuses pricing, calculated fields, attendee scope and payment on a club form", () => {
    const spec = blankClubFormSpec("Synthetic Form");
    const field = spec.definition.sections[0].fields[0];
    const priced = updateField(spec, field.id, { priceCents: 500 });
    expect(checkClubFormDraft(priced, NO_PROTECTION_HISTORY).issues[0].message).toMatch(/pricing and capacity/);
    const calculated = updateField(spec, field.id, { type: "CALCULATED" });
    expect(checkClubFormDraft(calculated, NO_PROTECTION_HISTORY).issues[0].message).toMatch(/calculated/);
    const attendee = updateField(spec, field.id, { scope: "ATTENDEE" });
    expect(checkClubFormDraft(attendee, NO_PROTECTION_HISTORY).issues[0].message).toMatch(/once, not per attendee/);
    const payment = { ...spec, definition: { ...spec.definition, payment: { enabled: true, currency: "USD" as const, paymentMethodFieldKey: "full_name", cardOptionValue: "Card", percentageBasisPoints: 290, fixedFeeCents: 30, passFeeToRegistrant: true } } };
    expect(checkClubFormDraft(payment, NO_PROTECTION_HISTORY).ok).toBe(false);
  });

  it("refuses unknown properties and returns issues for a malformed draft", () => {
    expect(checkClubFormDraft({ ...blankClubFormSpec("Synthetic Form"), extra: true }, NO_PROTECTION_HISTORY).ok).toBe(false);
    expect(checkClubFormDraft(null, NO_PROTECTION_HISTORY).ok).toBe(false);
    expect(checkClubFormDraft({}, NO_PROTECTION_HISTORY).issues.length).toBeGreaterThan(0);
  });

  it("keeps staff-only and sensitive apart, and birth dates sensitive", () => {
    const spec = blankClubFormSpec("Synthetic Form");
    const field = spec.definition.sections[0].fields[0];
    const both = { ...spec, sensitiveFieldKeys: [field.key], staffOnlyFieldKeys: [field.key] };
    expect(checkClubFormDraft(both, NO_PROTECTION_HISTORY).issues[0]).toMatchObject({ key: `field:${field.id}`, message: expect.stringContaining("staff-only and sensitive") });
    const birthOnly = { ...spec, birthDateFieldKeys: [field.key] };
    expect(checkClubFormDraft(birthOnly, NO_PROTECTION_HISTORY).issues[0].message).toMatch(/must also be marked sensitive/);
  });

  it("will not let a visible field depend on a hidden one", () => {
    const base = addField(blankClubFormSpec("Synthetic Form"), "section_main");
    const [first, second] = base.definition.sections[0].fields;
    const dependent = updateField(base, second.id, { conditional: { fieldKey: first.key, operator: "NOT_EMPTY", value: "" } });
    const hidden = setFieldFlag(dependent, first.id, "hidden", true);
    expect(checkClubFormDraft(hidden, NO_PROTECTION_HISTORY).issues[0].message).toMatch(/depends on a hidden field/);
  });
});

describe("the sensitive-flag protection rules (#712)", () => {
  const slip = () => seedSpec("off_premises_permission_slip");
  const sensitiveKey = () => slip().sensitiveFieldKeys[0];
  const fieldIdFor = (spec: ClubFormDraftSpec, key: string) => allFields(spec.definition).find((field) => field.key === key)!.id;

  it("refuses to clear a sensitive flag that a published version set", () => {
    const published = slip();
    const key = sensitiveKey();
    const loosened = setFieldFlag(published, fieldIdFor(published, key), "sensitive", false);
    const check = checkClubFormDraft(loosened, history(published));
    expect(check.ok).toBe(false);
    expect(check.issues[0]).toMatchObject({ key: `field:${fieldIdFor(published, key)}`, message: expect.stringContaining("keeps that setting") });
  });

  it("refuses to clear a birth-date flag that a published version set", () => {
    const published = seedSpec("pathfinder_staff_service_information");
    const key = published.birthDateFieldKeys[0];
    const loosened = setFieldFlag(published, fieldIdFor(published, key), "birthDate", false);
    const check = checkClubFormDraft(loosened, history(published));
    expect(check.ok).toBe(false);
    expect(check.issues[0].message).toMatch(/birth-date field in a published version/);
  });

  it("refuses to delete a protected field while submissions exist, and says to hide it", () => {
    const published = slip();
    const key = sensitiveKey();
    const removed = removeField(published, fieldIdFor(published, key));
    const check = checkClubFormDraft(removed, history(published, true));
    expect(check.ok).toBe(false);
    expect(check.issues).toEqual(expect.arrayContaining([{ key: `removed:${key}`, message: expect.stringContaining("hide it") }]));
  });

  it("allows deleting a protected field when no submission exists", () => {
    const published = slip();
    const key = sensitiveKey();
    const removed = removeField(published, fieldIdFor(published, key));
    expect(checkClubFormDraft(removed, history(published, false)).ok).toBe(true);
  });

  it("allows hiding a protected field instead, keeping its flag", () => {
    const published = slip();
    const key = sensitiveKey();
    const hidden = setFieldFlag(published, fieldIdFor(published, key), "hidden", true);
    const check = checkClubFormDraft(hidden, history(published, true));
    expect(check.issues).toEqual([]);
    expect(check.ok && check.spec.sensitiveFieldKeys).toContain(key);
  });

  it("allows marking a plain field sensitive or a birth date at any time, and reports it as newly sensitive", () => {
    const published = slip();
    const plain = allFields(published.definition).find((field) => !published.sensitiveFieldKeys.includes(field.key) && !published.staffOnlyFieldKeys.includes(field.key))!;
    const marked = setFieldFlag(published, plain.id, "birthDate", true);
    const check = checkClubFormDraft(marked, history(published));
    expect(check.ok).toBe(true);
    expect(newlySensitiveKeys(marked, published.sensitiveFieldKeys)).toEqual([plain.key]);
  });

  it("does not block a key that was deleted before any submission and is no longer in the form", () => {
    const published = slip();
    const key = sensitiveKey();
    const gone = removeField(published, fieldIdFor(published, key));
    // History still remembers the key, but the published version no longer holds the field.
    const later: ClubFormProtectionHistory = { ...history(published, true), publishedFieldKeys: allFields(gone.definition).map((field) => field.key) };
    expect(checkClubFormDraft(gone, later).ok).toBe(true);
  });
});

describe("copying and creating (#712)", () => {
  it("copies a published version, dropping hidden fields and their flags", () => {
    const published = seedSpec("off_premises_permission_slip");
    const key = published.sensitiveFieldKeys[0];
    const field = allFields(published.definition).find((candidate) => candidate.key === key)!;
    const hidden = setFieldFlag(published, field.id, "hidden", true);
    const copy = copySpec(hidden, "Synthetic Copy");
    expect(copy.name).toBe("Synthetic Copy");
    expect(allFields(copy.definition).map((candidate) => candidate.key)).not.toContain(key);
    expect(copy.sensitiveFieldKeys).not.toContain(key);
    expect(copy.hiddenFieldKeys).toEqual([]);
    expect(checkClubFormDraft(copy, NO_PROTECTION_HISTORY).issues).toEqual([]);
    expect(allFields(copy.definition).length).toBe(allFields(published.definition).length - 1);
  });

  it("keeps the copied sensitive flags", () => {
    const copy = copySpec(seedSpec("off_premises_permission_slip"), "Synthetic Copy");
    expect(copy.sensitiveFieldKeys.length).toBeGreaterThan(0);
  });

  it("makes URL-safe template keys", () => {
    expect(templateKeyFromName("Summer Camp: Medical & Waiver!")).toBe("summer_camp_medical_waiver");
    expect(templateKeyFromName("!!")).toBe("club_form");
  });
});

describe("fill-in definitions leave out hidden fields (#712)", () => {
  it("removes hidden fields and any section they empty from new fills and links", () => {
    const base = addSection(blankClubFormSpec("Synthetic Form"));
    const second = base.definition.sections[1].fields[0];
    const hidden = setFieldFlag(base, second.id, "hidden", true);
    const record = { definition: hidden.definition, hiddenFieldKeys: hidden.hiddenFieldKeys, staffOnlyFieldKeys: [] };
    expect(fillDefinition(record).sections).toHaveLength(1);
    expect(definitionForLink(record).sections).toHaveLength(1);
    expect(hidden.definition.sections).toHaveLength(2);
  });

  it("reads a stored row without the new columns as not customized and nothing hidden", () => {
    const seed = clubFormTemplateSeeds[0];
    const record = parseClubFormTemplate({
      id: "t", key: "custom_form_key", name: seed.name, description: "", version: 1, definition: seed.definition, sectionNotes: {},
      sensitiveFieldKeys: [], birthDateFieldKeys: [], staffOnlyFieldKeys: [], printLayout: "STANDARD", enabled: false,
    });
    expect(record.hiddenFieldKeys).toEqual([]);
    expect(record.customized).toBe(false);
  });
});

describe("builder state edits (#712)", () => {
  it("renames a key everywhere it is named", () => {
    let spec = addField(blankClubFormSpec("Synthetic Form"), "section_main");
    const [first, second] = spec.definition.sections[0].fields;
    spec = updateField(spec, second.id, { conditional: { fieldKey: first.key, operator: "NOT_EMPTY", value: "" } });
    spec = setFieldFlag(spec, first.id, "sensitive", true);
    const renamed = renameFieldKey(spec, first.id, "given_name");
    expect(renamed.sensitiveFieldKeys).toEqual(["given_name"]);
    expect(renamed.definition.sections[0].fields[1].conditional?.fieldKey).toBe("given_name");
  });

  it("removes a field's flags and dependent rules, and an emptied section", () => {
    let spec = addField(blankClubFormSpec("Synthetic Form"), "section_main");
    const [first, second] = spec.definition.sections[0].fields;
    spec = updateField(spec, second.id, { conditional: { fieldKey: first.key, operator: "NOT_EMPTY", value: "" } });
    const removed = removeField(spec, first.id);
    expect(removed.definition.sections[0].fields[0].conditional).toBeUndefined();
    const sectioned = addSection(spec);
    expect(removeSection(sectioned, sectioned.definition.sections[1].id).definition.sections).toHaveLength(1);
  });

  it("keeps flag combinations consistent", () => {
    const spec = blankClubFormSpec("Synthetic Form");
    const field = spec.definition.sections[0].fields[0];
    const birth = setFieldFlag(spec, field.id, "birthDate", true);
    expect(birth.sensitiveFieldKeys).toEqual([field.key]);
    const staff = setFieldFlag(birth, field.id, "staffOnly", true);
    expect(staff.sensitiveFieldKeys).toEqual([]);
    expect(staff.birthDateFieldKeys).toEqual([]);
  });

  it("moves items and parses notes and choices", () => {
    expect(moveItem([1, 2, 3], 0, 1)).toEqual([2, 1, 3]);
    expect(moveItem([1, 2, 3], 0, -1)).toEqual([1, 2, 3]);
    const spec = addField(blankClubFormSpec("Synthetic Form"), "section_main");
    const [first, second] = spec.definition.sections[0].fields;
    expect(moveField(spec, "section_main", second.id, -1).definition.sections[0].fields[0].id).toBe(second.id);
    expect(first.id).not.toBe(second.id);
    expect(sectionNotesFromText("One paragraph.\n\n\nSecond paragraph.\n")).toEqual(["One paragraph.", "Second paragraph."]);
    expect(optionsFromText("A\n\n B \nA")).toEqual(["A", "B"]);
  });
});
