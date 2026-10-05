import { describe, expect, it } from "vitest";
import { formTemplates } from "@/modules/forms/definition";
import type { RegistrationRecord } from "@/modules/registrations/repository";
import { buildKitchenReport, kitchenReportCsv, normalizeNeed } from "@/modules/registrations/kitchen-report";

const definition = formTemplates.find((template) => template.key === "womens_retreat_export")!.definition as unknown as Record<string, unknown>;

function registration(id: string, status: string, people: Array<Record<string, unknown>>): RegistrationRecord {
  return {
    id,
    confirmationCode: `SYNTH-${id}`,
    status,
    isGroup: false,
    accountHolder: { id: `p-${id}`, firstName: "Holder", lastName: `Surname${id}`, email: `holder-${id}@example.test`, phone: "" },
    attendees: people.map((responses, index) => ({
      id: `at-${id}-${index}`, firstName: "Guest", lastName: `Family${id}`, email: "", phone: "5550100", attendeeType: "Adult",
      position: index, source: "PUBLIC_REGISTRATION", responses, checkedIn: false, checkInId: null, checkedInAt: null,
    })),
    publicSubmission: { definition, responses: {}, attendeeResponses: [] },
  } as unknown as RegistrationRecord;
}

const sample = [
  registration("A", "CONFIRMED", [
    { meal_preference: "Vegan", dietary_needs: "Peanut allergy" },
    { meal_preference: "Standard", dietary_needs: "  peanut   ALLERGY " },
  ]),
  registration("B", "CONFIRMED", [
    { meal_preference: "Gluten Free", dietary_needs: "Peanut allergy; Dairy free" },
    { meal_preference: "Vegetarian", dietary_needs: "None" },
    { meal_preference: "Standard", dietary_needs: "N/A" },
    { meal_preference: "", dietary_needs: "" },
  ]),
  registration("C", "CANCELLED", [{ meal_preference: "Vegan", dietary_needs: "Shellfish" }]),
  registration("D", "SUBMITTED", [{ meal_preference: "Vegan", dietary_needs: "Kiwi" }]),
];

describe("kitchen report (#787)", () => {
  const report = buildKitchenReport(sample);

  it("counts meal types for confirmed registrations only", () => {
    const counts = Object.fromEntries(report.meals.map((meal) => [meal.value, meal.count]));
    expect(counts).toEqual({ regular: 2, vegetarian: 1, vegan: 1, gluten_free: 1, other: 0, none: 1 });
    expect(report.totalPeople).toBe(6);
  });

  it("groups answers ignoring case and spacing, most common first, showing the most common wording", () => {
    expect(report.needs).toEqual([
      { answer: "Peanut allergy", count: 3 },
      { answer: "Dairy free", count: 1 },
    ]);
  });

  it("totals people with any need and leaves out no-needs answers", () => {
    expect(report.peopleWithNeeds).toBe(3);
    expect(report.needs.map((need) => need.answer.toLowerCase())).not.toContain("none");
    expect(report.needs.map((need) => need.answer.toLowerCase())).not.toContain("n/a");
  });

  it("excludes cancelled and submitted registrations", () => {
    expect(JSON.stringify(report)).not.toMatch(/Shellfish|Kiwi/);
  });

  it("breaks wording ties by code order and normalizes whitespace and case", () => {
    const tied = buildKitchenReport([registration("T", "CONFIRMED", [{ dietary_needs: "no Dairy" }, { dietary_needs: "No dairy" }])]);
    expect(tied.needs).toEqual([{ answer: "No dairy", count: 2 }]);
    expect(normalizeNeed("  A   B ")).toBe("a b");
  });

  it("carries no personal fields in the page data or the CSV", () => {
    const csv = kitchenReportCsv(report);
    for (const text of [JSON.stringify(report), csv]) {
      expect(text).not.toMatch(/SYNTH-|Surname|Family|holder-|example\.test|5550100|Holder|Guest|at-/);
    }
    expect(Object.keys(report).sort()).toEqual(["meals", "needs", "peopleWithNeeds", "totalPeople"]);
    for (const need of report.needs) expect(Object.keys(need).sort()).toEqual(["answer", "count"]);
  });

  it("writes a BOM-prefixed CSV with formula escaping", () => {
    const csv = kitchenReportCsv(buildKitchenReport([registration("F", "CONFIRMED", [{ dietary_needs: "=SUM(A1)" }])]));
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('"Dietary needs answer","Count"');
    expect(csv).toContain(`"'=SUM(A1)","1"`);
    expect(csv).toContain('"People with any dietary need","1"');
  });
});
