import { describe, expect, it } from "vitest";
import { formTemplates } from "@/modules/forms/definition";
import type { RegistrationRecord } from "@/modules/registrations/repository";
import {
  choiceAnswerCounts,
  choiceExportRows,
  filterRegistrationsByChoice,
  isFilterableChoiceField,
  listChoiceQuestions,
  matchesForChoice,
  resolveChoiceFilter,
} from "@/modules/registrations/choice-answer-filter";
import { toCsv } from "@/modules/reporting/csv";

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

const meal = () => listChoiceQuestions(registrations).find((question) => question.key === "meal_preference")!;

describe("choice answer filter", () => {
  it("offers the meal drop-down generically, with its choices", () => {
    expect(meal().id).toBe("ATTENDEE:meal_preference");
    expect(meal().choices.map((choice) => choice.value)).toEqual(["Standard", "Vegetarian", "Vegan", "Gluten-free", "Other"]);
  });

  it("filters registrations and lists the matching people with their choice", () => {
    const filter = resolveChoiceFilter(registrations, { question: "ATTENDEE:meal_preference", value: "Vegetarian" })!;
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
    const filter = resolveChoiceFilter(registrations, { question: "ATTENDEE:meal_preference", value: "Vegetarian" })!;
    const rows = choiceExportRows(registrations, { ...filter, value: "Vegetarian" });
    expect(rows).toHaveLength(1 + matchesForChoice(registrations, filter.question, "Vegetarian").length);
    expect(rows.slice(1).map((row) => row[1])).toEqual(["Ada Synthetic", "Cleo Synthetic"]);
    expect(toCsv(rows)).toContain('"WR26-A1","Ada Synthetic","Holder A1","A1@example.test","CONFIRMED","Meal preference","Vegetarian"');
  });

  it("refuses free-text, sensitive, payment, directory and unknown questions", () => {
    const keys = listChoiceQuestions(registrations).map((question) => question.key);
    expect(keys).not.toContain("dietary_needs");
    expect(keys).not.toContain("special_needs");
    expect(keys).not.toContain("payment_method");
    expect(keys).not.toContain("church");
    expect(keys).not.toContain("session_1_preferences");
    for (const question of ["ATTENDEE:dietary_needs", "REGISTRATION:special_needs", "REGISTRATION:payment_method", "REGISTRATION:church", "ATTENDEE:nope"]) {
      expect(resolveChoiceFilter(registrations, { question, value: "Vegetarian" })).toBeNull();
    }
  });

  it("ignores a value that is not one of the question's choices", () => {
    const filter = resolveChoiceFilter(registrations, { question: "ATTENDEE:meal_preference", value: "Pizza" })!;
    expect(filter.value).toBeNull();
    expect(filterRegistrationsByChoice(registrations, filter)).toHaveLength(registrations.length);
  });

  it("classifies fields: allergy or medical wording blocks a choice question, a plain meal menu does not", () => {
    const base = { helpText: "", optionLabels: undefined, optionSource: undefined };
    expect(isFilterableChoiceField({ ...base, type: "SELECT", key: "meal_preference", label: "Meal preference", options: ["Standard", "Vegetarian", "Vegan"] })).toBe(true);
    expect(isFilterableChoiceField({ ...base, type: "SELECT", key: "food_needs", label: "Food allergies", options: ["None", "Nuts"] })).toBe(false);
    expect(isFilterableChoiceField({ ...base, type: "RADIO", key: "plan", label: "Plan", options: ["None", "Medical assistance"] })).toBe(false);
    expect(isFilterableChoiceField({ ...base, type: "LONG_TEXT", key: "meal_notes", label: "Meal notes", options: [] })).toBe(false);
    expect(isFilterableChoiceField({ ...base, type: "SELECT", key: "meal_preference", label: "Meal preference", options: ["A", "B"] }, "meal_preference")).toBe(false);
  });

  it("handles a registration-wide multi-select by value", () => {
    const multiDefinition = { ...definition, sections: [{ id: "workshops_section", title: "Workshops", fields: [
      { id: "field_workshops", key: "workshops", label: "Workshops", helpText: "", type: "MULTISELECT", scope: "REGISTRATION", required: false, options: ["Art", "Music"] },
    ] }], payment: undefined, attendeeRoster: undefined } as Record<string, unknown>;
    const one = { ...registration("M1", "CONFIRMED", [], { workshops: ["Art", "Music"] }), publicSubmission: { definition: multiDefinition, responses: { workshops: ["Art", "Music"] }, attendeeResponses: [] } } as unknown as RegistrationRecord;
    const question = listChoiceQuestions([one])[0];
    expect(question.multi).toBe(true);
    expect(matchesForChoice([one], question, "Music")).toHaveLength(1);
    expect(choiceAnswerCounts([one], question).choices.map((choice) => choice.count)).toEqual([1, 1]);
  });
});
