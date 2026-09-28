import { isFieldVisible, type RegistrationFormDefinition } from "@/modules/forms/definition";

/**
 * Roster summary before review (#483): total attendees, counts by role, and
 * induction totals, so a director catches omissions and misclassification
 * before submitting. Pure so the component and its tests agree on the
 * numbers shown.
 */

// "Induction" is the issue's generic word for what club templates call an
// investiture (e.g. the seeded Camp Meeting template's
// "master_guide_investiture" checkbox): both read as the same kind of
// ceremony total a director wants to see summed before review.
const INDUCTION_PATTERN = /induct\w*|investiture/i;

function looksLikeInductionField(key: string, label: string) {
  return INDUCTION_PATTERN.test(`${key.replaceAll("_", " ")} ${label}`);
}

export type RosterRoleCount = { role: string; count: number };
export type RosterInductionCount = { fieldKey: string; label: string; count: number };
export type RosterSummary = {
  total: number;
  byRole: RosterRoleCount[];
  /** No missing role isn't counted here; every attendee is one of `byRole`
   * or unclassified. */
  unclassifiedCount: number;
  inductions: RosterInductionCount[];
  inductionTotal: number;
};

export function summarizeRosterAttendees(
  definition: RegistrationFormDefinition,
  registrationResponses: Record<string, unknown>,
  attendeeResponsesList: readonly Record<string, unknown>[],
): RosterSummary {
  const attendeeFields = definition.sections.flatMap((section) => section.fields).filter((field) => field.scope === "ATTENDEE");
  const roleField = attendeeFields.find((field) => (
    field.key === "attendee_type" && ["RADIO", "SELECT"].includes(field.type)
  ));
  const inductionFields = attendeeFields.filter((field) => (
    field.type === "CHECKBOX" && looksLikeInductionField(field.key, field.label)
  ));

  const roleCounts = new Map<string, number>();
  let unclassifiedCount = 0;
  const inductionCounts = new Map<string, number>(inductionFields.map((field) => [field.key, 0]));

  for (const attendeeResponses of attendeeResponsesList) {
    const merged = { ...registrationResponses, ...attendeeResponses };
    if (roleField) {
      const value = merged[roleField.key];
      const role = typeof value === "string" && value ? (roleField.optionLabels?.[value] ?? value) : null;
      if (role) roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
      else unclassifiedCount += 1;
    } else {
      unclassifiedCount += 1;
    }
    for (const field of inductionFields) {
      if (!isFieldVisible(field, merged)) continue;
      if (merged[field.key] === true) inductionCounts.set(field.key, (inductionCounts.get(field.key) ?? 0) + 1);
    }
  }

  const byRole = [...roleCounts.entries()].map(([role, count]) => ({ role, count }))
    .sort((a, b) => b.count - a.count || a.role.localeCompare(b.role));
  const inductions = inductionFields.map((field) => ({
    fieldKey: field.key,
    label: field.label,
    count: inductionCounts.get(field.key) ?? 0,
  }));

  return {
    total: attendeeResponsesList.length,
    byRole,
    unclassifiedCount,
    inductions,
    inductionTotal: inductions.reduce((sum, item) => sum + item.count, 0),
  };
}
