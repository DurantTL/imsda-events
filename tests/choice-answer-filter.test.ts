import { describe, expect, it } from "vitest";
import { formTemplates } from "@/modules/forms/definition";
import type { RegistrationRecord } from "@/modules/registrations/repository";
import {
  choiceAnswerCounts,
  choiceExportRows,
  filterRegistrationsByChoice,
  listChoiceQuestions,
  matchesForChoice,
  resolveChoiceFilter,
} from "@/modules/registrations/choice-answer-filter";
import { toCsv } from "@/modules/reporting/csv";

/** Every production caller holds VIEW_SENSITIVE_DATA (the People page and the export require it). */
const staff = { canViewSensitive: true };

const definition = formTemplates.find((template) => template.key === "womens_retreat_export")!.definition as unknown as Record<string, unknown>;

function attendee(id: string, firstName: string, lastName: string, responses: Record<string, unknown>) {
  return { id, firstName, lastName, email: "", phone: "", attendeeType: "ATTENDEE", position: 0, source: "PUBLIC_REGISTRATION", responses, checkedIn: false, checkInId: null, checkedInAt: null };
}

function registration(id: string, status: string, attendees: ReturnType<typeof attendee>[], responses: Record<string, unknown> = {}) {
  return {
    id,
    confirmationCode: `WR26-${id}`,
    status,
    accountHolder: { id: `p-${id}`, firstName: "Holder", lastName: id, email: `${id}@example.test`, phone: "" },
    attendees,
    publicSubmission: { definition, responses, attendeeResponses: [] },
  } as unknown as RegistrationRecord;
}

const registrations = [
  registration("A1", "CONFIRMED", [
    attendee("a1", "Ada", "Synthetic", { meal_preference: "Vegetarian", dietary_needs: "synthetic note: no peanuts" }),
    attendee("a2", "Bea", "Synthetic", { meal_preference: "Standard" }),
  ], { church: "Test Church", payment_method: "Check" }),
  registration("B2", "SUBMITTED", [attendee("b1", "Cleo", "Synthetic", { meal_preference: "Vegetarian" })]),
  registration("C3", "CANCELLED", [attendee("c1", "Dee", "Synthetic", { meal_preference: "Vegetarian" })]),
  registration("D4", "CONFIRMED", [attendee("d1", "Eve", "Synthetic", {})]),
];

const meal = () => listChoiceQuestions(registrations, staff).find((question) => question.key === "meal_preference")!;

describe("choice answer filter", () => {
  it("offers the meal drop-down generically, with its choices", () => {
    expect(meal().id).toBe("ATTENDEE:meal_preference");
    expect(meal().choices.map((choice) => choice.value)).toEqual(["Standard", "Vegetarian", "Vegan", "Gluten-free", "Other"]);
  });

  it("filters registrations and lists the matching people with their choice", () => {
    const filter = resolveChoiceFilter(registrations, { question: "ATTENDEE:meal_preference", value: "Vegetarian" }, staff)!;
    expect(filterRegistrationsByChoice(registrations, filter).map((entry) => entry.id)).toEqual(["A1", "B2"]);
    expect(matchesForChoice(registrations, filter.question, "Vegetarian")).toEqual([
      expect.objectContaining({ personName: "Ada Synthetic", confirmationCode: "WR26-A1", value: "Vegetarian" }),
      expect.objectContaining({ personName: "Cleo Synthetic", confirmationCode: "WR26-B2", value: "Vegetarian" }),
    ]);
  });

  it("counts match the list for every choice and skip cancelled registrations", () => {
    const { choices, unanswered } = choiceAnswerCounts(registrations, meal());
    for (const choice of choices) {
      expect(choice.count).toBe(matchesForChoice(registrations, meal(), choice.value).length);
    }
    expect(choices.find((choice) => choice.value === "Vegetarian")!.count).toBe(2);
    expect(choices.find((choice) => choice.value === "Standard")!.count).toBe(1);
    expect(unanswered).toBe(1);
  });

  it("exports exactly the filtered list, through toCsv", () => {
    const filter = resolveChoiceFilter(registrations, { question: "ATTENDEE:meal_preference", value: "Vegetarian" }, staff)!;
    const rows = choiceExportRows(registrations, { ...filter, value: "Vegetarian" });
    expect(rows).toHaveLength(1 + matchesForChoice(registrations, filter.question, "Vegetarian").length);
    expect(rows.slice(1).map((row) => row[1])).toEqual(["Ada Synthetic", "Cleo Synthetic"]);
    expect(toCsv(rows)).toContain('"WR26-A1","Ada Synthetic","Holder A1","A1@example.test","CONFIRMED","Meal preference","Vegetarian"');
  });

  it("refuses free-text, sensitive, payment, directory and unknown questions", () => {
    const keys = listChoiceQuestions(registrations, staff).map((question) => question.key);
    expect(keys).not.toContain("dietary_needs");
    expect(keys).not.toContain("special_needs");
    expect(keys).not.toContain("payment_method");
    expect(keys).not.toContain("church");
    expect(keys).not.toContain("session_1_preferences");
    for (const question of ["ATTENDEE:dietary_needs", "REGISTRATION:special_needs", "REGISTRATION:payment_method", "REGISTRATION:church", "ATTENDEE:nope"]) {
      expect(resolveChoiceFilter(registrations, { question, value: "Vegetarian" }, staff)).toBeNull();
    }
  });

  it("ignores a value that is not one of the question's choices", () => {
    const filter = resolveChoiceFilter(registrations, { question: "ATTENDEE:meal_preference", value: "Pizza" }, staff)!;
    expect(filter.value).toBeNull();
    expect(filterRegistrationsByChoice(registrations, filter)).toHaveLength(registrations.length);
  });

  it("classifies fields: allergy or medical wording blocks a choice question, a staff meal menu does not", () => {
    const keys = keysOffered([
      { key: "meal_preference", label: "Meal preference", type: "SELECT", options: ["Standard", "Vegetarian", "Vegan"] },
      { key: "food_needs", label: "Food allergies", type: "SELECT", options: ["None", "Nuts"] },
      { key: "plan", label: "Plan", type: "RADIO", options: ["None", "Medical assistance"] },
      { key: "meal_notes", label: "Meal notes", type: "LONG_TEXT", options: [] },
      { key: "pay_by", label: "Pay by", type: "SELECT", options: ["Card", "Check"] },
    ], "pay_by");
    expect(keys).toEqual(["meal_preference"]);
  });

  it("handles a registration-wide multi-select by value", () => {
    const multiDefinition = { ...definition, sections: [{ id: "workshops_section", title: "Workshops", fields: [
      { id: "field_workshops", key: "workshops", label: "Workshops", helpText: "", type: "MULTISELECT", scope: "REGISTRATION", required: false, options: ["Art", "Music"] },
    ] }], payment: undefined, attendeeRoster: undefined } as Record<string, unknown>;
    const one = { ...registration("M1", "CONFIRMED", [], { workshops: ["Art", "Music"] }), publicSubmission: { definition: multiDefinition, responses: { workshops: ["Art", "Music"] }, attendeeResponses: [] } } as unknown as RegistrationRecord;
    const question = listChoiceQuestions([one], staff)[0];
    expect(question.multi).toBe(true);
    expect(matchesForChoice([one], question, "Music")).toHaveLength(1);
    expect(choiceAnswerCounts([one], question).choices.map((choice) => choice.count)).toEqual([1, 1]);
  });

  it("never shows free text as a count: stored values outside the options fall into a nameless bucket", () => {
    const odd = [
      registration("O1", "CONFIRMED", [attendee("o1", "Fay", "Synthetic", { meal_preference: "synthetic secret text" })]),
      registration("O2", "CONFIRMED", [attendee("o2", "Gil", "Synthetic", { meal_preference: "Vegan" })]),
    ];
    const question = listChoiceQuestions(odd, staff).find((candidate) => candidate.key === "meal_preference")!;
    const counts = choiceAnswerCounts(odd, question);
    expect(JSON.stringify(counts)).not.toContain("synthetic secret text");
    expect(counts.other).toBe(1);
    expect(counts.unanswered).toBe(0);
    expect(counts.choices.find((choice) => choice.value === "Vegan")!.count).toBe(1);
    expect(matchesForChoice(odd, question, "synthetic secret text")).toEqual([]);
  });

  it("decides each registration from its own form version", () => {
    const v2 = withFields(definition, (fields) => fields.map((field) => (field as { key: string }).key === "meal_preference"
      ? { ...field, type: "LONG_TEXT", options: [] }
      : field));
    const older = registration("V1", "CONFIRMED", [attendee("v1", "Hal", "Synthetic", { meal_preference: "Vegan" })]);
    const newer = { ...registration("V2", "CONFIRMED", [attendee("v2", "Ida", "Synthetic", { meal_preference: "free text about a person" })]), publicSubmission: { definition: v2, responses: {}, attendeeResponses: [] } } as unknown as RegistrationRecord;
    const mixed = [older, newer];
    const question = listChoiceQuestions(mixed, staff).find((candidate) => candidate.key === "meal_preference")!;
    const counts = choiceAnswerCounts(mixed, question);
    expect(JSON.stringify(counts)).not.toContain("free text");
    expect(counts.other).toBe(0);
    // The v2 registration has no such choice question, so it is not a "no answer" either.
    expect(counts.unanswered).toBe(0);
    expect(matchesForChoice(mixed, question, "Vegan").map((match) => match.personName)).toEqual(["Hal Synthetic"]);
    expect(filterRegistrationsByChoice(mixed, { question, value: "Vegan" }).map((entry) => entry.id)).toEqual(["V1"]);
  });

  it("rules out a question whose controller chain touches a sensitive question, in both directions", () => {
    const down = withFields(definition, (fields) => [
      ...fields,
      { id: "f_special", key: "special_meal", label: "Need a special meal?", helpText: "", type: "RADIO", scope: "ATTENDEE", required: false, options: ["No", "Yes"] },
      { id: "f_describe", key: "meal_details", label: "Describe allergies", helpText: "", type: "LONG_TEXT", scope: "ATTENDEE", required: false, options: [], conditional: { fieldKey: "special_meal", operator: "EQUALS", value: "Yes" } },
    ]);
    const downKeys = listChoiceQuestions([{ ...registration("L1", "CONFIRMED", []), publicSubmission: { definition: down, responses: {}, attendeeResponses: [] } } as unknown as RegistrationRecord], staff).map((question) => question.key);
    expect(downKeys).not.toContain("special_meal");
    expect(downKeys).toContain("meal_preference");

    const up = withFields(definition, (fields) => [
      ...fields,
      { id: "f_medical", key: "needs_care", label: "Medical support needed?", helpText: "", type: "RADIO", scope: "ATTENDEE", required: false, options: ["No", "Yes"] },
      { id: "f_table", key: "table_choice", label: "Table choice", helpText: "", type: "SELECT", scope: "ATTENDEE", required: false, options: ["Front", "Back"], conditional: { fieldKey: "needs_care", operator: "EQUALS", value: "Yes" } },
    ]);
    const upKeys = listChoiceQuestions([{ ...registration("L2", "CONFIRMED", []), publicSubmission: { definition: up, responses: {}, attendeeResponses: [] } } as unknown as RegistrationRecord], staff).map((question) => question.key);
    expect(upKeys).not.toContain("table_choice");
    expect(upKeys).not.toContain("needs_care");
  });

  it("rules out every question in a section whose title reads as sensitive", () => {
    const titled = {
      ...definition,
      sections: (definition.sections as Array<Record<string, unknown>>).map((section) => section.id === "wr_attendee" ? { ...section, title: "Health and dietary" } : section),
    };
    const only = { ...registration("S1", "CONFIRMED", []), publicSubmission: { definition: titled, responses: {}, attendeeResponses: [] } } as unknown as RegistrationRecord;
    expect(listChoiceQuestions([only], staff).map((question) => question.key)).not.toContain("meal_preference");
  });

  it("keeps nut-free and lactose options out; vegetarian, vegan and gluten stay in", () => {
    const keys = keysOffered([
      { key: "menu_a", label: "Menu", type: "SELECT", options: ["Standard", "Gluten-free"] },
      { key: "menu_b", label: "Menu", type: "SELECT", options: ["Standard", "Nut free"] },
      { key: "menu_c", label: "Menu", type: "SELECT", options: ["Standard", "Lactose intolerant"] },
    ]);
    expect(keys).toEqual(["menu_a"]);
  });

  it("neutralises spreadsheet formulas in a chosen value and a name through toCsv", () => {
    const evil = withFields(definition, (fields) => fields.map((field) => (field as { key: string }).key === "meal_preference"
      ? { ...field, options: ["=HYPERLINK(\"http://example.test\")", "Standard"] }
      : field));
    const one = { ...registration("E1", "CONFIRMED", [attendee("e1", "@Mal", "+Synthetic", { meal_preference: "=HYPERLINK(\"http://example.test\")" })]), publicSubmission: { definition: evil, responses: {}, attendeeResponses: [] } } as unknown as RegistrationRecord;
    const question = listChoiceQuestions([one], staff).find((candidate) => candidate.key === "meal_preference")!;
    const csv = toCsv(choiceExportRows([one], { question, value: "=HYPERLINK(\"http://example.test\")" }));
    expect(csv).toContain("\"'@Mal +Synthetic\"");
    expect(csv).toContain("\"'=HYPERLINK(");
    expect(csv).not.toMatch(/,"=HYPERLINK/);
  });
});

function withFields(source: Record<string, unknown>, change: (fields: Array<Record<string, unknown>>) => Array<Record<string, unknown>>) {
  return {
    ...source,
    sections: (source.sections as Array<{ id: string; fields: Array<Record<string, unknown>> }>).map((section) => (
      section.id === "wr_attendee" ? { ...section, fields: change(section.fields) } : section
    )),
  } as Record<string, unknown>;
}

/** Question keys offered for a form holding only these fields (the one public way in). */
function keysOffered(fields: Array<{ key: string; label: string; type: string; options: string[] }>, paymentKey?: string) {
  const form = {
    title: "Synthetic form",
    description: "",
    confirmationMessage: "Thanks",
    sections: [{ id: "only_section", title: "Choices", description: "", fields: fields.map((field, index) => ({
      id: `field_${index}`, helpText: "", scope: field.key === paymentKey ? "REGISTRATION" : "ATTENDEE", required: false, ...field,
    })) }],
    ...(paymentKey ? { payment: { enabled: true, currency: "USD", paymentMethodFieldKey: paymentKey, cardOptionValue: "Card" } } : {}),
  } as Record<string, unknown>;
  const holder = { ...registration("K1", "CONFIRMED", []), publicSubmission: { definition: form, responses: {}, attendeeResponses: [] } } as unknown as RegistrationRecord;
  return listChoiceQuestions([holder], staff).map((question) => question.key);
}
