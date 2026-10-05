import {
  ATTENDEE_LISTING_BOM,
  DEFAULT_LISTING_STATUSES,
  NO_DIETARY_NEEDS,
  buildAttendeeListingRows,
  mealTotals,
} from "@/modules/registrations/attendee-listing";
import type { RegistrationRecord } from "@/modules/registrations/repository";
import { toCsv } from "@/modules/reporting/csv";

/**
 * The kitchen report (#787): meal-type counts and the dietary-needs answers
 * people typed, grouped and counted, with nothing that says who gave them.
 *
 * It is built from the attendee listing's rows (same field resolution by known
 * keys, same no-needs set, same once-per-registration rule for registration-wide
 * answers) and then keeps ONLY counts and answer text. No name, confirmation
 * code, contact detail, church or club is copied into the result, and an answer
 * carries no link back to a person. Confirmed registrations only.
 */

export const KITCHEN_REPORT_STATUSES = DEFAULT_LISTING_STATUSES;

export type KitchenReport = {
  meals: Array<{ value: string; label: string; count: number }>;
  needs: Array<{ answer: string; count: number }>;
  /** People with at least one dietary need. */
  peopleWithNeeds: number;
  /** People counted (confirmed attendees). */
  totalPeople: number;
};

/** Trim, lowercase and collapse whitespace: the key answers are grouped by. */
export function normalizeNeed(answer: string): string {
  return answer.replace(/\s+/g, " ").trim().toLowerCase();
}

export function buildKitchenReport(registrations: readonly RegistrationRecord[]): KitchenReport {
  const confirmed = registrations.filter((registration) => KITCHEN_REPORT_STATUSES.includes(registration.status as never));
  // Full answer text is needed to count it; it is reduced to anonymous counts below and never returned per row.
  const rows = buildAttendeeListingRows(confirmed, { showDietaryDetails: true });
  const groups = new Map<string, { count: number; wordings: Map<string, number> }>();
  let peopleWithNeeds = 0;
  for (const row of rows) {
    if (!row.hasDietaryNeeds) continue;
    peopleWithNeeds += 1;
    const seen = new Set<string>();
    for (const part of row.dietaryNeeds.split(";")) {
      const wording = part.replace(/\s+/g, " ").trim();
      if (!wording || NO_DIETARY_NEEDS.test(wording)) continue;
      const key = normalizeNeed(wording);
      if (seen.has(key)) continue;
      seen.add(key);
      const group = groups.get(key) ?? { count: 0, wordings: new Map() };
      group.count += 1;
      group.wordings.set(wording, (group.wordings.get(wording) ?? 0) + 1);
      groups.set(key, group);
    }
  }
  const needs = [...groups.values()].map((group) => {
    // Most common wording; ties go to the first in plain code order (capitalized wording first) so the page is stable.
    const [answer] = [...group.wordings.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0];
    return { answer, count: group.count };
  });
  needs.sort((a, b) => b.count - a.count || a.answer.localeCompare(b.answer, "en", { sensitivity: "base" }));
  return {
    meals: mealTotals(rows).map(({ value, label, count }) => ({ value, label, count })),
    needs,
    peopleWithNeeds,
    totalPeople: rows.length,
  };
}

/** The two tables (answer, count), UTF-8 with a BOM; cells are formula-escaped by `toCsv`. */
export function kitchenReportCsv(report: KitchenReport): string {
  const table: Array<Array<string | number>> = [
    ["Meal type", "Count"],
    ...report.meals.map((meal) => [meal.label, meal.count]),
    [],
    ["Dietary needs answer", "Count"],
    ...report.needs.map((need) => [need.answer, need.count]),
    ["People with any dietary need", report.peopleWithNeeds],
  ];
  return ATTENDEE_LISTING_BOM + toCsv(table);
}
