/**
 * Club event assignments (#410): campsite, duty, and activity, kept as one
 * record per `ClubEventRegistration`, separate from the club's own submitted
 * preferences so the two never overwrite each other.
 *
 * Pure domain functions only — no Prisma here — so status and "changed since
 * sent" derivation is exercised directly in tests and reused by the staff
 * screen, the director view, the assignment email, and the club packet
 * (#411) print helper without drifting between callers.
 */

export type ClubAssignmentStatus = "UNASSIGNED" | "PARTIAL" | "SET";

export type ClubAssignmentFields = {
  campsiteLocation: string;
  campsiteNotes: string;
  dutyLabel: string;
  dutyDay: string;
  dutyTime: string;
  activityLabel: string;
  notes: string;
};

export const emptyClubAssignmentFields: ClubAssignmentFields = {
  campsiteLocation: "",
  campsiteNotes: "",
  dutyLabel: "",
  dutyDay: "",
  dutyTime: "",
  activityLabel: "",
  notes: "",
};

function has(value: string) {
  return value.trim().length > 0;
}

/**
 * unassigned: none of campsite/duty/activity set.
 * partial: one or two of the three set.
 * set: all three set. Free-text notes never count toward status — they are
 * not one of the three things a club needs to know it has.
 */
export function clubAssignmentStatus(fields: ClubAssignmentFields): ClubAssignmentStatus {
  const filled = [
    has(fields.campsiteLocation),
    has(fields.dutyLabel),
    has(fields.activityLabel),
  ].filter(Boolean).length;
  if (filled === 0) return "UNASSIGNED";
  if (filled === 3) return "SET";
  return "PARTIAL";
}

export const clubAssignmentStatusLabels: Readonly<Record<ClubAssignmentStatus, string>> = {
  UNASSIGNED: "Unassigned",
  PARTIAL: "Partial",
  SET: "Set",
};

/**
 * True once an assignment has ever been emailed and has since changed. A
 * fresh assignment that was never emailed is not "changed since sent" — there
 * is no prior send for it to have drifted from.
 */
export function clubAssignmentChangedSinceSent(record: {
  version: number;
  lastEmailedVersion: number | null;
}): boolean {
  return record.lastEmailedVersion !== null && record.version > record.lastEmailedVersion;
}

export function clubAssignmentEverSent(record: { lastEmailSentAt: string | null }): boolean {
  return record.lastEmailSentAt !== null;
}

/**
 * The Spring Camporee template's `sc_` club-preference fields (registration
 * scope), read by their form `key` — never their field `id` — from stored
 * responses. Read-only: this never writes back to the registration. Shows
 * only what exists; a missing or blank answer is left out rather than shown
 * as a placeholder, so staff never mistake "not answered" for "answered
 * nothing".
 */
export type ClubAssignmentPreferences = {
  dutyAreas: string[];
  flagSlots: string[];
  bathroomDays: string[];
  specialActivities: string[];
  campNextTo: string | null;
  tents: string | null;
  trailers: string | null;
  kitchenCanopy: string | null;
  totalSquareFeet: string | null;
};

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function singleString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function readClubAssignmentPreferences(
  responses: Record<string, unknown> | null | undefined,
): ClubAssignmentPreferences {
  const r = responses ?? {};
  return {
    dutyAreas: stringList(r.duty_areas),
    flagSlots: stringList(r.flag_slots),
    bathroomDays: stringList(r.bathroom_days),
    specialActivities: stringList(r.special_activities),
    campNextTo: singleString(r.camp_next_to),
    tents: singleString(r.tents),
    trailers: singleString(r.trailers),
    kitchenCanopy: singleString(r.kitchen_canopy),
    totalSquareFeet: singleString(r.total_sqft),
  };
}

/** Whether preferences carry anything worth a staff screen showing. */
export function hasAnyClubAssignmentPreferences(preferences: ClubAssignmentPreferences): boolean {
  return preferences.dutyAreas.length > 0
    || preferences.flagSlots.length > 0
    || preferences.bathroomDays.length > 0
    || preferences.specialActivities.length > 0
    || preferences.campNextTo !== null
    || preferences.tents !== null
    || preferences.trailers !== null
    || preferences.kitchenCanopy !== null
    || preferences.totalSquareFeet !== null;
}

/**
 * The assignment email / club packet (#411) block: a short Markdown section
 * naming only what staff actually set. No medical, no birth dates — this
 * reads only the three assignment fields and free-text notes, nothing from
 * the roster.
 */
export function clubAssignmentEmailBlock(fields: ClubAssignmentFields): string {
  const lines: string[] = [];
  if (has(fields.campsiteLocation)) {
    lines.push(`- **Campsite:** ${fields.campsiteLocation.trim()}${has(fields.campsiteNotes) ? ` — ${fields.campsiteNotes.trim()}` : ""}`);
  }
  if (has(fields.dutyLabel)) {
    const when = [fields.dutyDay.trim(), fields.dutyTime.trim()].filter(Boolean).join(" ");
    lines.push(`- **Duty:** ${fields.dutyLabel.trim()}${when ? ` — ${when}` : ""}`);
  }
  if (has(fields.activityLabel)) {
    lines.push(`- **Activity:** ${fields.activityLabel.trim()}`);
  }
  if (has(fields.notes)) {
    lines.push(`- **Notes:** ${fields.notes.trim()}`);
  }
  return lines.join("\n");
}
