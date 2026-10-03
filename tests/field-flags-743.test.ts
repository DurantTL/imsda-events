import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formTemplates, registrationFormDefinitionSchema, type RegistrationFormField } from "@/modules/forms/definition";
import { isHealthTypeField, resolveFieldFlags, withExplicitSensitiveFlags } from "@/modules/forms/field-flags";
import { choiceAnswerCounts, choiceExportRows, listChoiceQuestions, matchesForChoice, resolveChoiceFilter } from "@/modules/registrations/choice-answer-filter";
import { badgePositionOptions, buildBadgeCsvRows } from "@/modules/checkin/badge-csv";
import { isCheckInBookExtraField } from "@/modules/reporting/check-in-book";
import { buildOperationalReport, type OperationalReportRegistration } from "@/modules/reporting/operational-reports";
import type { RegistrationRecord } from "@/modules/registrations/repository";

type FieldInput = Record<string, unknown> & { key: string };

const plain = { canViewSensitive: false };
const staff = { canViewSensitive: true };

function field(input: FieldInput): RegistrationFormField {
  return { id: `field_${input.key}`, label: "Question", helpText: "", type: "SELECT", scope: "ATTENDEE", required: false, options: ["A", "B"], ...input } as unknown as RegistrationFormField;
}

function form(fields: FieldInput[], extra: Record<string, unknown> = {}, sectionTitle = "Choices") {
  return {
    title: "Synthetic form",
    description: "",
    confirmationMessage: "Thanks",
    sections: [{ id: "only_section", title: sectionTitle, description: "", fields: fields.map(field) }],
    ...extra,
  } as Record<string, unknown>;
}

function registrationFor(definition: Record<string, unknown>, id: string, attendeeResponses: Record<string, unknown>) {
  return {
    id,
    confirmationCode: `SYN-${id}`,
    status: "CONFIRMED",
    accountHolder: { id: `p-${id}`, firstName: "Holder", lastName: id, email: `${id}@example.test`, phone: "" },
    attendees: [{ id: `at-${id}`, firstName: "Guest", lastName: id, email: "", phone: "", attendeeType: "ADULT", position: 0, source: "PUBLIC_REGISTRATION", responses: attendeeResponses }],
    publicSubmission: { definition, responses: {}, attendeeResponses: [] },
  } as unknown as RegistrationRecord;
}

const offeredKeys = (definition: Record<string, unknown>, viewer = plain) =>
  listChoiceQuestions([registrationFor(definition, "K", {})], viewer).map((question) => question.key);

describe("field flags: stored in the definition JSON (#743)", () => {
  it("round-trips filterable and sensitive through the definition schema", () => {
    const parsed = registrationFormDefinitionSchema.parse(form([{ key: "meal", filterable: true, sensitive: false }, { key: "plain" }]));
    const [meal, other] = parsed.sections[0].fields;
    expect(meal.filterable).toBe(true);
    expect(meal.sensitive).toBe(false);
    // Absent stays absent: nothing is written for a form that never set the flags.
    expect("filterable" in other).toBe(false);
    expect("sensitive" in other).toBe(false);
    expect(JSON.parse(JSON.stringify(parsed)).sections[0].fields[0]).toMatchObject({ filterable: true, sensitive: false });
  });

  it("rejects a non-boolean flag", () => {
    expect(registrationFormDefinitionSchema.safeParse(form([{ key: "meal", filterable: "yes" }])).success).toBe(false);
  });
});

describe("field flags: read-time defaults for legacy definitions", () => {
  const womensRetreat = formTemplates.find((template) => template.key === "womens_retreat_export")!.definition as unknown as Record<string, unknown>;
  const parsed = registrationFormDefinitionSchema.parse(womensRetreat);
  const all = parsed.sections.flatMap((section) => section.fields.map((candidate) => ({ candidate, sectionTitle: section.title })));
  const flagsOf = (key: string) => {
    const found = all.find((entry) => entry.candidate.key === key)!;
    return resolveFieldFlags(found.candidate, { sectionTitle: found.sectionTitle, paymentMethodFieldKey: parsed.payment?.paymentMethodFieldKey });
  };

  it("keeps the Women's Retreat meal choice filterable and not sensitive", () => {
    expect(flagsOf("meal_preference")).toEqual({ filterable: true, sensitive: false });
    expect(offeredKeys(womensRetreat)).toContain("meal_preference");
  });

  it("makes health-type fields sensitive and not filterable by default", () => {
    expect(flagsOf("dietary_needs").sensitive).toBe(true);
    expect(flagsOf("dietary_needs").filterable).toBe(false);
    expect(isHealthTypeField(field({ key: "x", label: "Insurance company" }))).toBe(true);
    expect(isHealthTypeField(field({ key: "x", label: "Any allergies?" }))).toBe(true);
    expect(isHealthTypeField(field({ key: "x", label: "Medical conditions" }))).toBe(true);
    expect(isHealthTypeField(field({ key: "x", label: "Session", options: ["Nut free", "Standard"] }))).toBe(true);
    expect(isHealthTypeField(field({ key: "x", label: "Menu", options: ["Vegan", "Standard"] }))).toBe(false);
  });

  it("never defaults the payment-method field or a directory list to filterable", () => {
    const definition = form([
      { key: "pay_by", scope: "REGISTRATION", options: ["Card", "Check"] },
      { key: "church", scope: "REGISTRATION", options: [], optionSource: "CHURCHES_DIRECTORY" },
    ], { payment: { enabled: true, currency: "USD", paymentMethodFieldKey: "pay_by", cardOptionValue: "Card" } });
    expect(offeredKeys(definition, staff)).toEqual([]);
    // Even when staff flag it, the payment-method answer is never offered.
    const flagged = form([{ key: "pay_by", scope: "REGISTRATION", options: ["Card", "Check"], filterable: true }], { payment: { enabled: true, currency: "USD", paymentMethodFieldKey: "pay_by", cardOptionValue: "Card" } });
    expect(offeredKeys(flagged, staff)).toEqual([]);
  });

  it("lets an explicit flag win over the default", () => {
    expect(resolveFieldFlags(field({ key: "x", label: "Allergies", sensitive: false, filterable: true }))).toEqual({ filterable: true, sensitive: false });
    expect(resolveFieldFlags(field({ key: "x", label: "Menu", sensitive: true, filterable: false }))).toEqual({ filterable: false, sensitive: true });
  });
});

describe("field flags: what the answer filter offers", () => {
  it("does not offer a field that is not flagged", () => {
    // Health-wording defaults to not filterable; an explicit false hides an ordinary field too.
    expect(offeredKeys(form([{ key: "seating", filterable: false }, { key: "needs", label: "Allergies" }]), staff)).toEqual([]);
  });

  it("offers a flagged choice field to anyone", () => {
    expect(offeredKeys(form([{ key: "seating", filterable: true }]), plain)).toEqual(["seating"]);
  });

  it("offers only choice fields with options, even when flagged", () => {
    const definition = form([
      { key: "notes", type: "LONG_TEXT", options: [], filterable: true },
      { key: "ranked", type: "RANKED_CHOICE", filterable: true },
      { key: "seating", filterable: true },
    ]);
    expect(offeredKeys(definition, staff)).toEqual(["seating"]);
  });

  it("offers a flagged and sensitive field only with VIEW_SENSITIVE_DATA", () => {
    const definition = form([{ key: "needs", label: "Allergies", filterable: true, sensitive: true }]);
    expect(offeredKeys(definition, plain)).toEqual([]);
    expect(offeredKeys(definition, staff)).toEqual(["needs"]);
    const registrations = [registrationFor(definition, "S1", { needs: "A" })];
    expect(resolveChoiceFilter(registrations, { question: "ATTENDEE:needs", value: "A" }, plain)).toBeNull();
    const resolved = resolveChoiceFilter(registrations, { question: "ATTENDEE:needs", value: "A" }, staff)!;
    expect(resolved.question.sensitive).toBe(true);
    expect(matchesForChoice(registrations, resolved.question, "A")).toHaveLength(1);
    expect(choiceAnswerCounts(registrations, resolved.question).choices.find((choice) => choice.value === "A")!.count).toBe(1);
    expect(choiceExportRows(registrations, { ...resolved, value: "A" })).toHaveLength(2);
  });

  it("treats a field wired to a sensitive field as sensitive, in both directions", () => {
    const down = form([
      { key: "special", label: "Special request", filterable: true },
      { key: "detail", label: "Detail", type: "LONG_TEXT", options: [], sensitive: true, conditional: { fieldKey: "special", operator: "EQUALS", value: "A" } },
    ]);
    expect(offeredKeys(down, plain)).toEqual([]);
    expect(offeredKeys(down, staff)).toEqual(["special"]);
    const up = form([
      { key: "gate", label: "Gate", sensitive: true },
      { key: "seating", label: "Seating", filterable: true, conditional: { fieldKey: "gate", operator: "EQUALS", value: "A" } },
    ]);
    expect(offeredKeys(up, plain)).toEqual([]);
    expect(offeredKeys(up, staff)).toEqual(["gate", "seating"]);
  });

  it("is sensitive when any form version marks it sensitive", () => {
    const open = form([{ key: "seating", filterable: true }]);
    const closed = form([{ key: "seating", filterable: true, sensitive: true }]);
    const mixed = [registrationFor(open, "V1", {}), registrationFor(closed, "V2", {})];
    expect(listChoiceQuestions(mixed, plain)).toEqual([]);
    expect(listChoiceQuestions(mixed, staff).map((question) => question.key)).toEqual(["seating"]);
  });

  it("reads each registration from its own form version, as before", () => {
    const flagged = form([{ key: "seating", filterable: true }]);
    const unflagged = form([{ key: "seating", filterable: false }]);
    const mixed = [registrationFor(flagged, "F1", { seating: "A" }), registrationFor(unflagged, "F2", { seating: "A" })];
    const question = listChoiceQuestions(mixed, plain)[0];
    expect(matchesForChoice(mixed, question, "A").map((match) => match.registrationId)).toEqual(["F1"]);
  });
});

describe("field flags: sensitive answers in other staff views", () => {
  it("keeps a sensitive-flagged field out of the check-in book extra column and badge Position", () => {
    const all = registrationFormDefinitionSchema.parse(form([
      { key: "seating", label: "Seating" },
      { key: "table_pick", label: "Table", sensitive: true },
    ])).sections[0].fields;
    expect(isCheckInBookExtraField(all[0], all)).toBe(true);
    expect(isCheckInBookExtraField(all[1], all)).toBe(false);
    const definition = form([{ key: "seating", label: "Seating" }, { key: "table_pick", label: "Table", sensitive: true }]);
    expect(badgePositionOptions([registrationFor(definition, "B1", {})]).map((option) => option.key)).toEqual(["seating"]);
  });

  it("keeps a field controlled by a sensitive-flagged field out of the extra column", () => {
    const all = registrationFormDefinitionSchema.parse(form([
      { key: "gate", label: "Gate", sensitive: true },
      { key: "seating", label: "Seating", conditional: { fieldKey: "gate", operator: "EQUALS", value: "A" } },
    ])).sections[0].fields;
    expect(isCheckInBookExtraField(all[1], all)).toBe(false);
  });

  it("keeps a sensitive-flagged field out of the operational reports", () => {
    const build = (sensitive: boolean) => {
      const definition = form([{ key: "food_selection", label: "Friday supper preference", options: ["Standard", "Vegan"], ...(sensitive ? { sensitive: true } : {}) }], {}, "Food service");
      const registration: OperationalReportRegistration = {
        id: "r1",
        confirmationCode: "SYN-R1",
        status: "SUBMITTED",
        accountHolder: { firstName: "Ana", lastName: "Synthetic" },
        attendees: [{ id: "a1", firstName: "Ana", lastName: "Synthetic", attendeeType: "Adult", position: 0, responses: {} }],
        publicSubmission: { definition, responses: {}, attendeeResponses: [{ food_selection: "Vegan" }] },
      };
      return JSON.stringify(buildOperationalReport([registration]));
    };
    expect(build(false)).toContain("Friday supper preference");
    expect(build(true)).not.toContain("Friday supper preference");
    expect(build(true)).not.toContain("Vegan");
  });

  it("leaves the People page and registration API alone: they already require VIEW_SENSITIVE_DATA", () => {
    const people = readFileSync(path.join(process.cwd(), "app/(workspace)/people/page.tsx"), "utf8");
    expect(people).toContain('if (!permissions.includes("VIEW_SENSITIVE_DATA"))');
    const detail = readFileSync(path.join(process.cwd(), "app/api/events/[eventId]/registrations/[registrationId]/route.ts"), "utf8");
    expect(detail).toContain('"VIEW_SENSITIVE_DATA"');
  });
});

describe("field flags: the form builder", () => {
  const builder = readFileSync(path.join(process.cwd(), "components/registration-builder-workspace.tsx"), "utf8");

  it("has two labelled checkboxes with help text, started from the resolved defaults", () => {
    expect(builder).toContain("Show as a filter</label>");
    expect(builder).toContain("Sensitive</label>");
    expect(builder).toContain("resolveFieldFlags(field, { sectionTitle: section.title");
    expect(builder).toContain("checked={flags.filterable}");
    expect(builder).toContain("checked={flags.sensitive || linkedToSensitive}");
    expect(builder).toContain("updateField(sectionIndex, fieldIndex, { filterable: event.target.checked })");
    expect(builder).toContain("updateField(sectionIndex, fieldIndex, { sensitive: event.target.checked })");
    expect(builder).toContain("only staff with sensitive-data access can filter on it");
  });
});

function template(key: string) {
  return formTemplates.find((candidate) => candidate.key === key)!.definition as unknown as Record<string, unknown>;
}

describe("field flags: #739 parity for published forms with no flags", () => {
  it("offers the live Women's Retreat meal field to a staff viewer, and no health, payment or directory field", () => {
    const keys = offeredKeys(template("womens_retreat_export"), staff);
    expect(keys).toContain("meal_preference");
    expect(keys).not.toContain("dietary_needs");
    expect(keys).not.toContain("payment_method");
    expect(keys).not.toContain("church");
  });

  it("does not offer Man Camp is_minor, Camp Meeting housing_selection or their linked fields by default", () => {
    expect(offeredKeys(template("man_camp_export"), staff)).not.toContain("is_minor");
    const campMeeting = offeredKeys(template("camp_meeting_export"), staff);
    expect(campMeeting).not.toContain("housing_selection");
    expect(campMeeting).not.toContain("first_floor_needed");
  });

  it("an explicit tick offers a field the default would not", () => {
    const definition = template("man_camp_export");
    const ticked = {
      ...definition,
      sections: (definition.sections as Array<{ fields: Array<Record<string, unknown>> }>).map((section) => ({
        ...section,
        fields: section.fields.map((candidate) => candidate.key === "is_minor" ? { ...candidate, filterable: true } : candidate),
      })),
    };
    expect(offeredKeys(ticked, staff)).toContain("is_minor");
  });

  it("does not offer a field linked, in either direction, to a sensitive field by default, even for staff", () => {
    const down = form([
      { key: "special", label: "Special request" },
      { key: "detail", label: "Describe allergies", type: "LONG_TEXT", options: [], conditional: { fieldKey: "special", operator: "EQUALS", value: "A" } },
    ]);
    expect(offeredKeys(down, staff)).toEqual([]);
    const up = form([
      { key: "needs_care", label: "Medical support needed?" },
      { key: "table_choice", label: "Table choice", conditional: { fieldKey: "needs_care", operator: "EQUALS", value: "A" } },
    ]);
    expect(offeredKeys(up, staff)).toEqual([]);
  });

  it("does not offer a field linked to the payment-method field by default", () => {
    const payment = { payment: { enabled: true, currency: "USD", paymentMethodFieldKey: "pay_by", cardOptionValue: "Card" } };
    const down = form([
      { key: "pay_by", scope: "REGISTRATION", options: ["Card", "Check"] },
      { key: "check_note", label: "Check number", scope: "REGISTRATION", conditional: { fieldKey: "pay_by", operator: "EQUALS", value: "Check" } },
    ], payment);
    expect(offeredKeys(down, staff)).toEqual([]);
    const ticked = form([
      { key: "pay_by", scope: "REGISTRATION", options: ["Card", "Check"] },
      { key: "check_note", label: "Check number", scope: "REGISTRATION", filterable: true, conditional: { fieldKey: "pay_by", operator: "EQUALS", value: "Check" } },
    ], payment);
    expect(offeredKeys(ticked, staff)).toEqual(["check_note"]);
  });

  it("resolves the live meal question and refuses a health question for the staff viewer", () => {
    const registrations = [registrationFor(template("womens_retreat_export"), "W1", { meal_preference: "Vegan" })];
    expect(resolveChoiceFilter(registrations, { question: "ATTENDEE:meal_preference", value: "Vegan" }, staff)?.value).toBe("Vegan");
    expect(resolveChoiceFilter(registrations, { question: "ATTENDEE:dietary_needs", value: "x" }, staff)).toBeNull();
  });
});

describe("field flags: section titles and other form versions", () => {
  it("badge Position and the builder agree: a field in a health-titled section is not offered", () => {
    const definition = form([{ key: "seating", label: "Seating" }], {}, "Health and dietary");
    expect(badgePositionOptions([registrationFor(definition, "T1", {})])).toEqual([]);
    const plainSection = form([{ key: "seating", label: "Seating" }], {}, "Choices");
    expect(badgePositionOptions([registrationFor(plainSection, "T2", {})]).map((option) => option.key)).toEqual(["seating"]);
  });

  it("the badge CSV bans a key that is ineligible in ANY form version", () => {
    const open = form([{ key: "seating", label: "Seating" }]);
    const closed = form([{ key: "seating", label: "Seating", sensitive: true }]);
    const mixed = [registrationFor(open, "O1", { seating: "AAA" }), registrationFor(closed, "O2", { seating: "BBB" })];
    expect(badgePositionOptions(mixed)).toEqual([]);
    const rows = buildBadgeCsvRows(mixed, "seating");
    expect(rows.slice(1).every((row) => row[2] === "")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("AAA");
  });

  it("operational reports exclude a key flagged Sensitive in any form version for every registration", () => {
    const open = form([{ key: "food_selection", label: "Friday supper preference", options: ["Standard", "Vegan"] }], {}, "Food service");
    const closed = form([{ key: "food_selection", label: "Friday supper preference", options: ["Standard", "Vegan"], sensitive: true }], {}, "Food service");
    const report = (definition: Record<string, unknown>, id: string): OperationalReportRegistration => ({
      id,
      confirmationCode: `SYN-${id}`,
      status: "SUBMITTED",
      accountHolder: { firstName: "Ana", lastName: "Synthetic" },
      attendees: [{ id: `a-${id}`, firstName: "Ana", lastName: "Synthetic", attendeeType: "Adult", position: 0, responses: {} }],
      publicSubmission: { definition, responses: {}, attendeeResponses: [{ food_selection: "Vegan" }] },
    });
    expect(JSON.stringify(buildOperationalReport([report(open, "r1")]))).toContain("Friday supper preference");
    expect(JSON.stringify(buildOperationalReport([report(open, "r1"), report(closed, "r2")]))).not.toContain("Friday supper preference");
  });

  it("operational reports keep Leadership Weekend meals by default and drop it when flagged Sensitive", () => {
    const definition = template("leadership_weekend");
    const run = (change: Record<string, unknown>) => {
      const edited = {
        ...definition,
        sections: (definition.sections as Array<{ fields: Array<Record<string, unknown>> }>).map((section) => ({
          ...section,
          fields: section.fields.map((candidate) => candidate.key === "meals" ? { ...candidate, ...change } : candidate),
        })),
      };
      return JSON.stringify(buildOperationalReport([{
        id: "lw",
        confirmationCode: "SYN-LW",
        status: "SUBMITTED",
        accountHolder: { firstName: "Ana", lastName: "Synthetic" },
        attendees: [{ id: "a", firstName: "Ana", lastName: "Synthetic", attendeeType: "Adult", position: 0, responses: {} }],
        publicSubmission: { definition: edited, responses: {}, attendeeResponses: [{ meals: ["Friday Supper"] }] },
      }]));
    };
    expect(run({})).toContain("Friday Supper");
    expect(run({ sensitive: true })).not.toContain("Friday Supper");
  });
});

describe("field flags: the builder writes explicit defaults", () => {
  it("writes sensitive: true on a health-type field with no flag, and leaves flagged fields alone", () => {
    const parsed = registrationFormDefinitionSchema.parse(form([
      { key: "needs", label: "Allergies" },
      { key: "seating", label: "Seating" },
      { key: "kept", label: "Medical", sensitive: false },
    ]));
    const saved = withExplicitSensitiveFlags(parsed);
    const [needs, seating, kept] = saved.sections[0].fields;
    expect(needs.sensitive).toBe(true);
    expect("sensitive" in seating).toBe(false);
    expect(kept.sensitive).toBe(false);
  });

  it("hides Show as a filter for the payment-method field and explains linked sensitive fields", () => {
    const builder = readFileSync(path.join(process.cwd(), "components/registration-builder-workspace.tsx"), "utf8");
    expect(builder).toContain("field.key !== paymentKey");
    expect(builder).toContain("Treated as sensitive because it is shown by, or controls, a sensitive question.");
    expect(builder).toContain("withExplicitSensitiveFlags(definition)");
  });
});
