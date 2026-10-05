import { describe, expect, it } from "vitest";
import { blankRosterMapping, removeField, renameFieldKey, setRosterMapping } from "@/components/club-form-builder-state";
import { checkClubFormDraft, NO_PROTECTION_HISTORY, specFromRecord } from "@/modules/club-forms/builder-domain";
import { clubFormTemplateSeeds } from "@/modules/club-forms/definitions";
import { allFields, parseClubFormTemplate, templateSpecProblems } from "@/modules/club-forms/domain";
import {
  looksLikeHealthField,
  parseRosterMapping,
  rosterMappingCandidates,
  rosterMappingProblems,
  rosterPrefillFromAnswers,
  splitFullName,
  usableRosterMapping,
  type RosterMapping,
} from "@/modules/club-forms/roster-mapping";

/** Synthetic data only: every name, date and address here is made up. */

const membership = clubFormTemplateSeeds.find((seed) => seed.key === "pathfinder_membership_application")!;
const staffForm = clubFormTemplateSeeds.find((seed) => seed.key === "pathfinder_staff_service_information")!;

const specOf = (seed: (typeof clubFormTemplateSeeds)[number]) => ({
  definition: seed.definition,
  sensitiveFieldKeys: seed.sensitiveFieldKeys,
  birthDateFieldKeys: seed.birthDateFieldKeys,
  hiddenFieldKeys: [] as string[],
});

const on = (mapping: RosterMapping): RosterMapping => ({ ...mapping, enabled: true });

describe("the seeded mappings (#721)", () => {
  it("ship pre-filled for the Membership Application and the Staff/Volunteer form, and off", () => {
    expect(membership.rosterMapping).toMatchObject({ enabled: false, rosterType: "YOUTH" });
    expect(staffForm.rosterMapping).toMatchObject({ enabled: false, rosterType: "STAFF" });
    const others = clubFormTemplateSeeds.filter((seed) => seed !== membership && seed !== staffForm);
    expect(others.every((seed) => seed.rosterMapping === undefined)).toBe(true);
  });

  it.each([membership, staffForm])("pass every check, on or off, for $key", (seed) => {
    const mapping = seed.rosterMapping!;
    expect(rosterMappingProblems(mapping, specOf(seed))).toEqual([]);
    expect(rosterMappingProblems(on(mapping), specOf(seed))).toEqual([]);
    expect(templateSpecProblems({ ...seed, rosterMapping: mapping })).toEqual([]);
  });

  it("map the birth date only from a field the template marks as a birth date, and never a health field", () => {
    for (const seed of [membership, staffForm]) {
      const mapping = seed.rosterMapping!;
      expect(seed.birthDateFieldKeys).toContain(mapping.fields.birthDate);
      const mapped = [...Object.values(mapping.fields), ...mapping.guardians.flatMap((guardian) => Object.values(guardian))];
      const byKey = new Map(allFields(seed.definition).map((field) => [field.key, field]));
      for (const key of mapped) {
        const field = byKey.get(key);
        // relationshipLabel is a fixed text, not a key.
        if (!field) continue;
        expect(looksLikeHealthField(field)).toBe(false);
        if (key !== mapping.fields.birthDate) expect(seed.sensitiveFieldKeys).not.toContain(key);
      }
    }
  });

  it("are the mapping a seeded template reads until it has its own stored one", () => {
    const row = {
      id: "t1", key: membership.key, name: membership.name, description: "", version: membership.version, definition: membership.definition,
      sectionNotes: membership.sectionNotes, sensitiveFieldKeys: membership.sensitiveFieldKeys, birthDateFieldKeys: membership.birthDateFieldKeys,
      staffOnlyFieldKeys: membership.staffOnlyFieldKeys, printLayout: "STANDARD", enabled: true,
    };
    const record = parseClubFormTemplate(row);
    expect(record.rosterMapping).toEqual(membership.rosterMapping);
    // Off, so it offers nothing until an administrator turns it on.
    expect(usableRosterMapping(record.rosterMapping, record)).toBeNull();
    const stored = parseClubFormTemplate({ ...row, rosterMapping: on(membership.rosterMapping!) });
    expect(usableRosterMapping(stored.rosterMapping, stored)).not.toBeNull();
    // A damaged stored value only turns the feature off (falls back to the seed's, which is off).
    expect(usableRosterMapping(parseClubFormTemplate({ ...row, rosterMapping: { enabled: "yes" } }).rosterMapping, record)).toBeNull();
    // A form that is not a seed and has no mapping has none.
    expect(parseClubFormTemplate({ ...row, key: "custom_form" }).rosterMapping).toBeNull();
  });
});

describe("mapping validation: protected fields only, no health (#721)", () => {
  const base: RosterMapping = { enabled: true, rosterType: "STAFF", fields: { fullName: "full_name", birthDate: "birth_date" }, guardians: [] };
  const problems = (mapping: RosterMapping) => rosterMappingProblems(mapping, specOf(staffForm));

  it("accepts the staff form's name and birth date", () => {
    expect(problems(base)).toEqual([]);
  });

  it("refuses a birth-date field for any roster field but the birth date", () => {
    const result = problems({ ...base, fields: { ...base.fields, role: "birth_date" } });
    expect(result.join(" ")).toMatch(/birth-date field and can only fill the roster's birth date/);
  });

  it("refuses a birth date that does not come from a birth-date field", () => {
    const result = problems({ ...base, fields: { fullName: "full_name", birthDate: "signature_date" } });
    expect(result.join(" ")).toMatch(/must come from a field marked as a birth date/);
  });

  it("refuses a sensitive field for a plain roster field", () => {
    const result = problems({ ...base, fields: { ...base.fields, role: "conduct_type" } });
    expect(result.join(" ")).toMatch(/sensitive/);
  });

  it.each(["health_limitation", "health_limitation_how"])("refuses the health field %s", (key) => {
    expect(problems({ ...base, fields: { ...base.fields, role: key } }).join(" ")).toMatch(/Health information never goes onto the roster/);
  });

  it("refuses a health-looking field nobody flagged as sensitive", () => {
    const definition = {
      ...membership.definition,
      sections: [{ id: "s", title: "Applicant", description: "", fields: [
        { id: "f1", key: "full_name", label: "Name", helpText: "", type: "TEXT" as const, scope: "REGISTRATION" as const, required: true, options: [] },
        { id: "f2", key: "birth_date", label: "Born", helpText: "", type: "DATE" as const, scope: "REGISTRATION" as const, required: true, options: [] },
        { id: "f3", key: "notes", label: "Allergies and medications", helpText: "", type: "TEXT" as const, scope: "REGISTRATION" as const, required: false, options: [] },
      ] }],
    };
    const spec = { definition, sensitiveFieldKeys: ["birth_date"], birthDateFieldKeys: ["birth_date"], hiddenFieldKeys: [] };
    const result = rosterMappingProblems({ ...base, fields: { ...base.fields, role: "notes" } }, spec);
    expect(result.join(" ")).toMatch(/Health information never goes onto the roster/);
    expect(rosterMappingCandidates("role", spec).map((field) => field.key)).toEqual(["full_name"]);
  });

  it("refuses a field that is not in the form, or is hidden, or is the wrong kind of question", () => {
    expect(problems({ ...base, fields: { ...base.fields, role: "no_such_field" } }).join(" ")).toMatch(/not in the form/);
    expect(rosterMappingProblems({ ...base, fields: { ...base.fields, role: "church_other" } }, { ...specOf(staffForm), hiddenFieldKeys: ["church_other"] }).join(" ")).toMatch(/hidden/);
    expect(problems({ ...base, fields: { ...base.fields, role: "signature_date" } }).join(" ")).toMatch(/wrong kind of question/);
  });

  it("refuses one question for two roster fields, and both a full name and first/last", () => {
    expect(problems({ ...base, fields: { ...base.fields, firstName: "full_name", lastName: "city" } }).join(" ")).toMatch(/not both|two roster fields/);
    expect(problems({ ...base, fields: { fullName: "full_name", role: "full_name", birthDate: "birth_date" } }).join(" ")).toMatch(/two roster fields/);
  });

  it("needs a name and a birth date only when it is on", () => {
    const empty: RosterMapping = { enabled: false, rosterType: "YOUTH", fields: {}, guardians: [] };
    expect(problems(empty)).toEqual([]);
    expect(problems(on(empty)).join(" ")).toMatch(/name/);
    expect(problems(on(empty)).join(" ")).toMatch(/birth-date question/);
  });

  it("gives a staff member no class and no guardian contacts", () => {
    expect(problems({ ...base, fields: { ...base.fields, classLevel: "marital_status" } }).join(" ")).toMatch(/no class or guardian/);
    expect(problems({ ...base, guardians: [{ name: "spouse_name" }] }).join(" ")).toMatch(/no class or guardian/);
  });

  it("offers the builder only the questions the rules allow", () => {
    const spec = specOf(staffForm);
    const keys = (target: Parameters<typeof rosterMappingCandidates>[0]) => rosterMappingCandidates(target, spec).map((field) => field.key);
    // The birth date offers birth-date questions only (the staff form has six: the person's and five children's).
    expect(keys("birthDate")).toEqual(staffForm.birthDateFieldKeys);
    expect(keys("fullName")).toContain("full_name");
    for (const target of ["fullName", "role", "gender"] as const) {
      for (const key of keys(target)) {
        expect(staffForm.sensitiveFieldKeys).not.toContain(key);
        expect(key).not.toMatch(/health|conduct/);
      }
    }
  });
});

describe("the builder keeps a mapping consistent and checks it (#721)", () => {
  const record = () => parseClubFormTemplate({
    id: "t1", key: membership.key, name: membership.name, description: "", version: membership.version, definition: membership.definition,
    sectionNotes: membership.sectionNotes, sensitiveFieldKeys: membership.sensitiveFieldKeys, birthDateFieldKeys: membership.birthDateFieldKeys,
    staffOnlyFieldKeys: membership.staffOnlyFieldKeys, printLayout: "STANDARD", enabled: true,
  });
  const spec = () => specFromRecord({ ...record(), sortOrder: 10 });

  it("starts a draft from the seed's mapping, and the draft passes the publish check", () => {
    expect(spec().rosterMapping).toEqual(membership.rosterMapping);
    expect(checkClubFormDraft(spec(), NO_PROTECTION_HISTORY).ok).toBe(true);
    expect(checkClubFormDraft(setRosterMapping(spec(), on(membership.rosterMapping!)), NO_PROTECTION_HISTORY).ok).toBe(true);
  });

  it("reports a bad mapping against the roster setting, not the form as a whole", () => {
    const bad = setRosterMapping(spec(), { ...on(membership.rosterMapping!), fields: { ...membership.rosterMapping!.fields, role: "birth_date" } });
    const check = checkClubFormDraft(bad, NO_PROTECTION_HISTORY);
    expect(check.ok).toBe(false);
    expect(check.issues.every((issue) => issue.key === "rosterMapping")).toBe(true);
    expect(check.issues[0].message).toMatch(/birth-date field/);
    // A structurally invalid mapping is keyed the same way.
    const shape = checkClubFormDraft({ ...spec(), rosterMapping: { enabled: true, rosterType: "ADMIN", fields: {}, guardians: [] } }, NO_PROTECTION_HISTORY);
    expect(shape.ok).toBe(false);
    expect(shape.issues[0].key).toBe("rosterMapping");
  });

  it("follows a renamed question and drops a removed one", () => {
    const start = setRosterMapping(spec(), on(membership.rosterMapping!));
    const nameId = allFields(start.definition).find((field) => field.key === "full_name")!.id;
    // Renaming keeps the mapping pointing at the same question.
    const renamed = renameFieldKey(start, nameId, "applicant_full_name");
    expect(renamed.rosterMapping?.fields.fullName).toBe("applicant_full_name");
    expect(checkClubFormDraft(renamed, NO_PROTECTION_HISTORY).ok).toBe(true);
    // Removing it leaves the mapping without it (so enabling then needs a name again).
    const removed = removeField(start, nameId);
    expect(removed.rosterMapping?.fields.fullName).toBeUndefined();
    expect(checkClubFormDraft(removed, NO_PROTECTION_HISTORY).issues.map((issue) => issue.message).join(" ")).toMatch(/name/);
    expect(blankRosterMapping().enabled).toBe(false);
  });

  it("an old draft with no mapping still reads (it has none)", () => {
    const { rosterMapping, ...legacy } = spec();
    void rosterMapping;
    const check = checkClubFormDraft(legacy, NO_PROTECTION_HISTORY);
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.spec.rosterMapping).toBeNull();
    expect(parseRosterMapping(undefined)).toBeNull();
  });
});

describe("pre-filling a roster member from the answers (#721)", () => {
  const answers = {
    full_name: "Jordan Q. Sample",
    birth_date: "2013-04-09",
    ay_class: "Explorer",
    phone: "(555) 010-0100",
    father_guardian_signature: "Pat Sample",
    mother_guardian_signature: "Alex Sample",
    street: "1 Example Lane",
  };
  const mapping = membership.rosterMapping!;

  it("fills the name, sealed birth date, class, type and guardians", () => {
    const prefill = rosterPrefillFromAnswers(mapping, answers, specOf(membership));
    expect(prefill).toMatchObject({
      firstName: "Jordan Q.",
      lastName: "Sample",
      birthDate: "2013-04-09",
      attendeeType: "YOUTH",
      classLevel: "EXPLORER",
      gender: null,
      role: "",
    });
    expect(prefill.guardians).toEqual([
      { name: "Pat Sample", relationship: "Father or guardian", email: "", phone: "(555) 010-0100" },
      { name: "Alex Sample", relationship: "Mother or guardian", email: "", phone: "" },
    ]);
  });

  it("leaves a guardian slot blank when only the fixed relationship would be filled", () => {
    const prefill = rosterPrefillFromAnswers(mapping, { ...answers, mother_guardian_signature: "", phone: "" }, specOf(membership));
    expect(prefill.guardians[1]).toEqual({ name: "", relationship: "", email: "", phone: "" });
  });

  it("reads a staff applicant as staff with no class or guardians", () => {
    const prefill = rosterPrefillFromAnswers(staffForm.rosterMapping!, {
      full_name: "Sample, Riley", birth_date: "1988-01-02", health_limitation: "Yes", health_limitation_how: "Synthetic health detail", conduct_type: "Synthetic conduct",
    }, specOf(staffForm));
    expect(prefill).toMatchObject({ firstName: "Riley", lastName: "Sample", birthDate: "1988-01-02", attendeeType: "STAFF", classLevel: null });
    expect(prefill.guardians.every((guardian) => !guardian.name && !guardian.phone)).toBe(true);
    // Nothing from a health or conduct answer is anywhere in what the roster is offered.
    expect(JSON.stringify(prefill)).not.toMatch(/Synthetic health detail|Synthetic conduct/);
  });

  it("never reads a sensitive or health answer for a plain field, even from a stale mapping", () => {
    const stale: RosterMapping = { enabled: true, rosterType: "STAFF", fields: { fullName: "full_name", birthDate: "birth_date", role: "health_limitation_how", gender: "conduct_type" }, guardians: [] };
    const prefill = rosterPrefillFromAnswers(stale, { full_name: "Riley Sample", birth_date: "1988-01-02", health_limitation_how: "Synthetic health detail", conduct_type: "Male" }, specOf(staffForm));
    expect(prefill.role).toBe("");
    expect(prefill.gender).toBeNull();
    // And the birth date is read only from a birth-date field.
    const wrongBirth: RosterMapping = { ...stale, fields: { fullName: "full_name", birthDate: "signature_date" } };
    expect(rosterPrefillFromAnswers(wrongBirth, { full_name: "Riley Sample", signature_date: "2026-10-01" }, specOf(staffForm)).birthDate).toBe("");
  });

  it("reads US-style dates and splits names the way a director would expect", () => {
    expect(rosterPrefillFromAnswers(mapping, { ...answers, birth_date: "4/9/2013" }, specOf(membership)).birthDate).toBe("2013-04-09");
    expect(rosterPrefillFromAnswers(mapping, { ...answers, birth_date: "not a date" }, specOf(membership)).birthDate).toBe("");
    expect(splitFullName("  Jordan   Sample ")).toEqual({ firstName: "Jordan", lastName: "Sample" });
    expect(splitFullName("Sample, Jordan Q.")).toEqual({ firstName: "Jordan Q.", lastName: "Sample" });
    expect(splitFullName("Jordan")).toEqual({ firstName: "Jordan", lastName: "" });
    expect(splitFullName("")).toEqual({ firstName: "", lastName: "" });
  });

  it("parses a stored mapping strictly", () => {
    expect(parseRosterMapping({ enabled: true, rosterType: "YOUTH", fields: { fullName: "a", extra: "b" }, guardians: [] })).toBeNull();
    expect(parseRosterMapping({ enabled: true, rosterType: "YOUTH", fields: {}, guardians: [{}, {}, {}] })).toBeNull();
    expect(parseRosterMapping({ enabled: true, rosterType: "STAFF", fields: { fullName: "a" } })).toMatchObject({ guardians: [] });
  });
});
