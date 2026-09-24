import type { ClubAssignmentFields } from "@/modules/club-registrations/assignments";
import { toCsv } from "@/modules/reporting/csv";

/**
 * Camporee reports (Q1, #411): camping coordinator summary, duties and
 * activities, spiritual milestones, and special roles, built from active
 * (submitted/confirmed) club registrations for a club event. Pure, so the
 * reports page, its CSV downloads, and the club packet all agree on the same
 * well-known Spring Camporee response keys (`modules/forms/definition.ts`,
 * `sc_*`). A field the form doesn't collect is simply blank here — this
 * module never invents data the registration never asked for.
 */

export type ClubRosterRole = "Pathfinder" | "TLT" | "Staff" | "Child";

export const CLUB_ROSTER_ROLES: readonly ClubRosterRole[] = ["Pathfinder", "TLT", "Staff", "Child"];

export function roleAbbreviation(role: string | null): string {
  switch (role) {
    case "Pathfinder": return "PF";
    case "TLT": return "TLT";
    case "Staff": return "Stf";
    case "Child": return "Ch";
    default: return "—";
  }
}

export type ClubRosterAttendee = {
  id: string;
  firstName: string;
  lastName: string;
  /** The form's "Roster role" answer (Pathfinder/TLT/Staff/Child), or null if unanswered. */
  role: ClubRosterRole | null;
  /** Age on the event date, from the roster's own age answer — never a birth date. */
  ageOnEventDate: number | null;
  gender: string | null;
  medicalPersonnel: boolean;
  masterGuideInvestiture: boolean;
  firstTimeCamper: boolean;
  /** True only when the club answered a non-blank dietary restriction — the text itself is never carried here. */
  hasDietaryNeed: boolean;
};

export type ClubEventRecord = {
  organizationId: string;
  organizationName: string;
  sponsoringChurch: string | null;
  registrationId: string;
  confirmationCode: string;
  status: string;
  directorName: string;
  email: string;
  phone: string;
  submittedAt: string | null;
  camping: {
    tents: string;
    trailers: string;
    kitchenCanopy: string;
    totalSqft: string;
    campNextTo: string;
  };
  dutyAreas: string[];
  flagSlots: string[];
  bathroomDays: string[];
  specialActivities: string[];
  partnerClub: string;
  eventRibbons: string;
  sabbathSkit: string;
  sponsoringMeals: boolean;
  mealSponsorshipCount: string;
  mealTimes: string[];
  baptismNames: string;
  bibleNames: string;
  attendees: ClubRosterAttendee[];
  amountOwedCents: number;
  /** Whether any attendee's registration fee line item used the form's late-pricing label. */
  lateRateApplied: boolean;
};

export type ClubHeadcounts = {
  pathfinder: number;
  tlt: number;
  staff: number;
  child: number;
  total: number;
};

export function clubHeadcounts(attendees: ClubRosterAttendee[]): ClubHeadcounts {
  const counts = { pathfinder: 0, tlt: 0, staff: 0, child: 0 };
  for (const attendee of attendees) {
    if (attendee.role === "Pathfinder") counts.pathfinder += 1;
    else if (attendee.role === "TLT") counts.tlt += 1;
    else if (attendee.role === "Staff") counts.staff += 1;
    else if (attendee.role === "Child") counts.child += 1;
  }
  return { ...counts, total: attendees.length };
}

/** A text answer, or a NUMBER field's value written out (e.g. square footage). */
function textOrNumber(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return textValue(value);
}

// Answers that mean "no dietary need", so they don't earn a ⚠.
const NO_DIETARY_NEED = /^(none|no|n\/?a|nil|nothing|-+)\.?$/i;

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function boolValue(value: unknown): boolean {
  return value === true || value === "true" || value === "Yes";
}

function roleFromResponse(value: unknown): ClubRosterRole | null {
  const text = textValue(value);
  return (CLUB_ROSTER_ROLES as readonly string[]).includes(text) ? (text as ClubRosterRole) : null;
}

function numberFromResponse(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/** Whether any attendee fee line item in the pricing snapshot used the given late-pricing label. */
function lateRateFromPricingSnapshot(pricingSnapshot: Record<string, unknown>, lateLabel: string | null): boolean {
  if (!lateLabel) return false;
  const lineItems = pricingSnapshot.lineItems;
  if (!Array.isArray(lineItems)) return false;
  return lineItems.some((item) => (
    item && typeof item === "object" && (item as { pricingLabel?: unknown }).pricingLabel === lateLabel
  ));
}

export type BuildClubEventRecordInput = {
  organizationId: string;
  organizationName: string;
  sponsoringChurch: string | null;
  registrationId: string;
  confirmationCode: string;
  status: string;
  submittedAt: string | null;
  registrationResponses: Record<string, unknown>;
  attendees: Array<{ id: string; firstName: string; lastName: string; responses: Record<string, unknown> }>;
  amountOwedCents: number;
  pricingSnapshot: Record<string, unknown>;
  lateRateLabel: string | null;
};

export function buildClubEventRecord(input: BuildClubEventRecordInput): ClubEventRecord {
  const responses = input.registrationResponses;
  return {
    organizationId: input.organizationId,
    organizationName: input.organizationName,
    sponsoringChurch: input.sponsoringChurch,
    registrationId: input.registrationId,
    confirmationCode: input.confirmationCode,
    status: input.status,
    directorName: textValue(responses.director_name),
    email: textValue(responses.email),
    phone: textValue(responses.phone),
    submittedAt: input.submittedAt,
    camping: {
      tents: textOrNumber(responses.tents),
      trailers: textOrNumber(responses.trailers),
      kitchenCanopy: textOrNumber(responses.kitchen_canopy),
      totalSqft: textOrNumber(responses.total_sqft),
      campNextTo: textValue(responses.camp_next_to),
    },
    dutyAreas: stringList(responses.duty_areas),
    flagSlots: stringList(responses.flag_slots),
    bathroomDays: stringList(responses.bathroom_days),
    specialActivities: stringList(responses.special_activities),
    partnerClub: textValue(responses.partner_club),
    eventRibbons: textValue(responses.event_ribbons),
    sabbathSkit: textValue(responses.sabbath_skit),
    sponsoringMeals: boolValue(responses.sponsoring_meals) || textValue(responses.sponsoring_meals) === "Yes",
    mealSponsorshipCount: textOrNumber(responses.meal_sponsorship_count),
    mealTimes: stringList(responses.meal_times),
    baptismNames: textValue(responses.baptism_names),
    bibleNames: textValue(responses.bible_names),
    attendees: input.attendees.map((attendee) => ({
      id: attendee.id,
      firstName: attendee.firstName,
      lastName: attendee.lastName,
      role: roleFromResponse(attendee.responses.attendee_type),
      ageOnEventDate: numberFromResponse(attendee.responses.attendee_age),
      gender: textValue(attendee.responses.gender) || null,
      medicalPersonnel: boolValue(attendee.responses.medical_personnel),
      masterGuideInvestiture: boolValue(attendee.responses.master_guide_investiture),
      firstTimeCamper: boolValue(attendee.responses.first_time_camper),
      hasDietaryNeed: (() => {
        const answer = textValue(attendee.responses.dietary_needs);
        return answer.length > 0 && !NO_DIETARY_NEED.test(answer);
      })(),
    })),
    amountOwedCents: input.amountOwedCents,
    lateRateApplied: lateRateFromPricingSnapshot(input.pricingSnapshot, input.lateRateLabel),
  };
}

/* ---------------------------------------------------------------------- */
/* Camping coordinator summary                                            */
/* ---------------------------------------------------------------------- */

export type CampingReportRow = {
  organizationId: string;
  organizationName: string;
  sponsoringChurch: string | null;
  confirmationCode: string;
  camping: ClubEventRecord["camping"];
  headcounts: ClubHeadcounts;
};

export function buildCampingReport(clubs: ClubEventRecord[]): CampingReportRow[] {
  return clubs
    .map((club) => ({
      organizationId: club.organizationId,
      organizationName: club.organizationName,
      sponsoringChurch: club.sponsoringChurch,
      confirmationCode: club.confirmationCode,
      camping: club.camping,
      headcounts: clubHeadcounts(club.attendees),
    }))
    .sort((left, right) => left.organizationName.localeCompare(right.organizationName));
}

export function campingReportCsv(rows: CampingReportRow[]) {
  const table: Array<Array<string | number>> = [[
    "Club", "Sponsoring church", "Confirmation", "Tents", "Trailers", "Kitchen canopy",
    "Total sq ft", "Camp next to", "Pathfinders", "TLTs", "Staff", "Children", "Total",
  ]];
  for (const row of rows) {
    table.push([
      row.organizationName,
      row.sponsoringChurch ?? "",
      row.confirmationCode,
      row.camping.tents,
      row.camping.trailers,
      row.camping.kitchenCanopy,
      row.camping.totalSqft,
      row.camping.campNextTo,
      row.headcounts.pathfinder,
      row.headcounts.tlt,
      row.headcounts.staff,
      row.headcounts.child,
      row.headcounts.total,
    ]);
  }
  return toCsv(table);
}

/* ---------------------------------------------------------------------- */
/* Duties and activities                                                  */
/* ---------------------------------------------------------------------- */

export type ClubAssignmentSummary = ClubAssignmentFields | null;

export type DutiesActivitiesReportRow = {
  organizationId: string;
  organizationName: string;
  sponsoringChurch: string | null;
  confirmationCode: string;
  dutyAreas: string[];
  flagSlots: string[];
  bathroomDays: string[];
  specialActivities: string[];
  partnerClub: string;
  eventRibbons: string;
  sabbathSkit: string;
  assignment: ClubAssignmentSummary;
};

export function buildDutiesActivitiesReport(
  clubs: ClubEventRecord[],
  assignments: Map<string, ClubAssignmentSummary>,
): DutiesActivitiesReportRow[] {
  return clubs
    .map((club) => ({
      organizationId: club.organizationId,
      organizationName: club.organizationName,
      sponsoringChurch: club.sponsoringChurch,
      confirmationCode: club.confirmationCode,
      dutyAreas: club.dutyAreas,
      flagSlots: club.flagSlots,
      bathroomDays: club.bathroomDays,
      specialActivities: club.specialActivities,
      partnerClub: club.partnerClub,
      eventRibbons: club.eventRibbons,
      sabbathSkit: club.sabbathSkit,
      assignment: assignments.get(club.organizationId) ?? null,
    }))
    .sort((left, right) => left.organizationName.localeCompare(right.organizationName));
}

export function dutiesActivitiesReportCsv(rows: DutiesActivitiesReportRow[]) {
  const table: Array<Array<string | number>> = [[
    "Club", "Sponsoring church", "Confirmation", "Duty areas", "Flag slots", "Bathroom days",
    "Activities", "Partner club", "Ribbons", "Sabbath skit",
    "Assigned campsite", "Assigned duty", "Duty day", "Duty time", "Assigned activity", "Assignment notes",
  ]];
  for (const row of rows) {
    table.push([
      row.organizationName,
      row.sponsoringChurch ?? "",
      row.confirmationCode,
      row.dutyAreas.join("; "),
      row.flagSlots.join("; "),
      row.bathroomDays.join("; "),
      row.specialActivities.join("; "),
      row.partnerClub,
      row.eventRibbons,
      row.sabbathSkit,
      row.assignment?.campsiteLocation ?? "",
      row.assignment?.dutyLabel ?? "",
      row.assignment?.dutyDay ?? "",
      row.assignment?.dutyTime ?? "",
      row.assignment?.activityLabel ?? "",
      row.assignment?.notes ?? "",
    ]);
  }
  return toCsv(table);
}

/* ---------------------------------------------------------------------- */
/* Spiritual milestones                                                   */
/* ---------------------------------------------------------------------- */

export type MilestonesReportRow = {
  organizationId: string;
  organizationName: string;
  sponsoringChurch: string | null;
  confirmationCode: string;
  baptismNames: string;
  bibleNames: string;
};

export function buildSpiritualMilestonesReport(clubs: ClubEventRecord[]): MilestonesReportRow[] {
  return clubs
    .filter((club) => club.baptismNames || club.bibleNames)
    .map((club) => ({
      organizationId: club.organizationId,
      organizationName: club.organizationName,
      sponsoringChurch: club.sponsoringChurch,
      confirmationCode: club.confirmationCode,
      baptismNames: club.baptismNames,
      bibleNames: club.bibleNames,
    }))
    .sort((left, right) => left.organizationName.localeCompare(right.organizationName));
}

export function spiritualMilestonesReportCsv(rows: MilestonesReportRow[]) {
  const table: Array<Array<string | number>> = [[
    "Club", "Sponsoring church", "Confirmation", "Baptism interest", "Bible read-through",
  ]];
  for (const row of rows) {
    table.push([row.organizationName, row.sponsoringChurch ?? "", row.confirmationCode, row.baptismNames, row.bibleNames]);
  }
  return toCsv(table);
}

/* ---------------------------------------------------------------------- */
/* Special roles: medical personnel and Master Guide investiture          */
/* ---------------------------------------------------------------------- */

export type SpecialRoleReportRow = {
  role: "Medical personnel" | "Master Guide investiture";
  attendeeId: string;
  name: string;
  organizationName: string;
  sponsoringChurch: string | null;
  confirmationCode: string;
};

export function buildSpecialRolesReport(clubs: ClubEventRecord[]): SpecialRoleReportRow[] {
  const rows: SpecialRoleReportRow[] = [];
  for (const club of clubs) {
    for (const attendee of club.attendees) {
      const name = `${attendee.lastName}, ${attendee.firstName}`;
      if (attendee.medicalPersonnel) {
        rows.push({
          role: "Medical personnel",
          attendeeId: attendee.id,
          name,
          organizationName: club.organizationName,
          sponsoringChurch: club.sponsoringChurch,
          confirmationCode: club.confirmationCode,
        });
      }
      if (attendee.masterGuideInvestiture) {
        rows.push({
          role: "Master Guide investiture",
          attendeeId: attendee.id,
          name,
          organizationName: club.organizationName,
          sponsoringChurch: club.sponsoringChurch,
          confirmationCode: club.confirmationCode,
        });
      }
    }
  }
  return rows.sort((left, right) => (
    left.role.localeCompare(right.role)
    || left.organizationName.localeCompare(right.organizationName)
    || left.name.localeCompare(right.name)
  ));
}

export function specialRolesReportCsv(rows: SpecialRoleReportRow[]) {
  const table: Array<Array<string | number>> = [["Role", "Name", "Club", "Sponsoring church", "Confirmation"]];
  for (const row of rows) {
    table.push([row.role, row.name, row.organizationName, row.sponsoringChurch ?? "", row.confirmationCode]);
  }
  return toCsv(table);
}

export const clubReportKinds = ["camping", "duties-activities", "milestones", "special-roles"] as const;
export type ClubReportKind = typeof clubReportKinds[number];
