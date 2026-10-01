import { z } from "zod";
import { clubYearFor, parseCalendarDate } from "@/modules/club-rosters/domain";
import { calendarDateInEventTimeZone } from "@/modules/events/lifecycle";

/**
 * Pure rules for the Pathfinder Health Record (#611): the field list, input
 * validation, the club-year status, and who may do what. No database, no
 * secrets and no I/O, so it can be tested without either.
 */

/** Stored on every record so a later change to the wording is visible. */
export const HEALTH_CONSENT_VERSION = "draft-2026-10-synthetic";

/**
 * PLACEHOLDER WORDING. The three consent statements must be the verbatim text
 * of the 2026 Pathfinder Health Record before this is switched on. They are
 * kept here, in one place, so that swap is a one-file change. See ADR 0005
 * Addendum B (open question) and the pull request notes.
 */
export const HEALTH_CONSENT_TEXT = {
  emergencyTreatment: "[Placeholder: emergency treatment authorization, verbatim text to be supplied.]",
  activities: "[Placeholder: attendance, health-history accuracy and activity permission statement, verbatim text to be supplied.]",
  photocopy: "[Placeholder: permission for photocopying, verbatim text to be supplied.]",
} as const;

export const HEALTH_RECORD_LINK_DEFAULT_DAYS = 14;
export const HEALTH_RECORD_LINK_MAX_DAYS = 30;

export const MAX_EMERGENCY_CONTACTS = 6;

/** Every field a record can hold, each sealed on its own. */
export const HEALTH_FIELD_KEYS = [
  "addressLine1",
  "addressLine2",
  "city",
  "state",
  "zip",
  "phone",
  "email",
  "lastTetanusBooster",
  "hasAllergies",
  "allergyDetails",
  "medications",
  "medicalRestrictions",
  "hasInsurance",
  "insuranceCompany",
  "insuranceGroupNumber",
  "insurancePolicyNumber",
  "insurancePhone",
  "guardianFirstName",
  "guardianLastName",
  "guardianAddress",
  "guardianPhone",
  "guardianEmail",
  "emergencyContacts",
  "consent",
  "signature",
] as const;

export type HealthFieldKey = (typeof HEALTH_FIELD_KEYS)[number];

export function isHealthFieldKey(value: string): value is HealthFieldKey {
  return (HEALTH_FIELD_KEYS as readonly string[]).includes(value);
}

/** Free text and short values: trimmed, control characters removed. */
function text(max: number) {
  return z
    .string()
    .transform((value) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim())
    .pipe(z.string().max(max, `Keep this to ${max} characters or fewer.`));
}

const optionalText = (max: number) => text(max).optional().default("");
const yesNo = z.enum(["YES", "NO"]);

const emergencyContactSchema = z.object({
  firstName: text(80).pipe(z.string().min(1, "Enter each contact's first name.")),
  lastName: text(80).pipe(z.string().min(1, "Enter each contact's last name.")),
  phone: text(40).pipe(z.string().min(1, "Enter each contact's phone number.")),
  relationship: text(80).pipe(z.string().min(1, "Enter each contact's relationship to the minor.")),
});

export type EmergencyContact = z.infer<typeof emergencyContactSchema>;

const isoDate = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value === "" || parseCalendarDate(value) !== null, "Enter the date as year-month-day.");

/** What a director or parent submits. Unknown keys are dropped, never stored. */
export const healthRecordInputSchema = z
  .object({
    addressLine1: optionalText(120),
    addressLine2: optionalText(120),
    city: optionalText(80),
    state: optionalText(40),
    zip: optionalText(20),
    phone: optionalText(40),
    email: optionalText(160),
    lastTetanusBooster: isoDate.optional().default(""),
    hasAllergies: yesNo,
    allergyDetails: optionalText(2000),
    medications: optionalText(2000),
    medicalRestrictions: optionalText(2000),
    hasInsurance: yesNo,
    insuranceCompany: optionalText(160),
    insuranceGroupNumber: optionalText(80),
    insurancePolicyNumber: optionalText(80),
    insurancePhone: optionalText(40),
    guardianFirstName: text(80).pipe(z.string().min(1, "Enter the guardian's first name.")),
    guardianLastName: text(80).pipe(z.string().min(1, "Enter the guardian's last name.")),
    guardianAddress: optionalText(300),
    guardianPhone: text(40).pipe(z.string().min(1, "Enter the guardian's phone number.")),
    guardianEmail: optionalText(160),
    emergencyContacts: z
      .array(emergencyContactSchema)
      .min(1, "Add at least one emergency contact.")
      .max(MAX_EMERGENCY_CONTACTS, `Add at most ${MAX_EMERGENCY_CONTACTS} contacts.`),
    consentEmergencyTreatment: z.literal(true, { error: "The emergency treatment authorization must be agreed to." }),
    consentActivities: z.literal(true, { error: "The attendance and activity permission statement must be agreed to." }),
    consentPhotocopy: z.literal(true, { error: "The permission for photocopying must be agreed to." }),
    signature: text(160).pipe(z.string().min(1, "Type the guardian's name as the signature.")),
  })
  .superRefine((value, context) => {
    if (value.hasAllergies === "YES" && value.allergyDetails === "") {
      context.addIssue({ code: "custom", path: ["allergyDetails"], message: "Describe the allergies, reactions, severity and normal remedy." });
    }
    if (value.hasInsurance === "YES" && value.insuranceCompany === "") {
      context.addIssue({ code: "custom", path: ["insuranceCompany"], message: "Enter the insurance company." });
    }
  });

export type HealthRecordInput = z.infer<typeof healthRecordInputSchema>;

/**
 * The record as stored: one value per field key. `consent` and `signature`
 * are structured values; everything else is a string or the contacts list.
 */
export type HealthFieldValues = Partial<Record<HealthFieldKey, unknown>>;

/** Splits a validated submission into the per-field values that are sealed one by one. */
export function fieldValuesFromInput(input: HealthRecordInput, now: Date): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  const plainKeys: Array<keyof HealthRecordInput & HealthFieldKey> = [
    "addressLine1", "addressLine2", "city", "state", "zip", "phone", "email", "lastTetanusBooster",
    "hasAllergies", "allergyDetails", "medications", "medicalRestrictions", "hasInsurance",
    "insuranceCompany", "insuranceGroupNumber", "insurancePolicyNumber", "insurancePhone",
    "guardianFirstName", "guardianLastName", "guardianAddress", "guardianPhone", "guardianEmail",
  ];
  for (const key of plainKeys) {
    const value = input[key];
    // An empty value is "not provided": it is not stored at all.
    if (typeof value === "string" && value !== "") values[key] = value;
  }
  values.emergencyContacts = input.emergencyContacts;
  values.consent = {
    version: HEALTH_CONSENT_VERSION,
    emergencyTreatment: true,
    activities: true,
    photocopy: true,
    agreedOn: now.toISOString().slice(0, 10),
  };
  values.signature = { typedName: input.signature, signedOn: now.toISOString().slice(0, 10) };
  return values;
}

/** The plain "has a health note" flag: true when anything clinical was entered. No text. */
export function hasHealthNoteFor(values: Record<string, unknown>) {
  return values.hasAllergies === "YES"
    || typeof values.medications === "string"
    || typeof values.medicalRestrictions === "string";
}

export type HealthRecordStatus = "NONE" | "CURRENT" | "NEEDS_UPDATE";

/**
 * "Needs update" until the record has been saved or confirmed in the current
 * club year (the club year rolls over on the roster's own date).
 */
export function healthRecordStatus(
  record: { confirmedClubYear: string | null } | null,
  now: Date,
): HealthRecordStatus {
  if (!record) return "NONE";
  return record.confirmedClubYear === clubYearFor(now) ? "CURRENT" : "NEEDS_UPDATE";
}

export function clampHealthLinkDays(days: number | undefined) {
  if (!Number.isFinite(days) || days === undefined) return HEALTH_RECORD_LINK_DEFAULT_DAYS;
  return Math.min(HEALTH_RECORD_LINK_MAX_DAYS, Math.max(1, Math.trunc(days)));
}

// ---------------------------------------------------------------------------
// Who may do what.

/**
 * - CLUB_LEADER: the club's director or deputy, signed in with their own
 *   attendee account past the roster's second step. Reads and edits their own
 *   club only, all year.
 * - AREA_COORDINATOR (director's decision, 2026-10-01): an Area Coordinator
 *   with a verified second sign-in step. View only, and only for a member
 *   registered for an event, inside that event's window.
 * - HEALTH_ROLE: staff holding VIEW_HEALTH_INFORMATION on an event membership
 *   (the same permission the coordinator health view uses, #658). View only,
 *   and only for a member registered for one of those events, inside its window.
 * - SYSTEM_ADMIN: view only, any member, all year.
 *
 * There is deliberately no registrar, reporter, or event-staff viewer: none of
 * them can be constructed, whatever other permissions they hold (Event Admins
 * and VIEW_SENSITIVE_DATA holders included).
 */
export type HealthViewer =
  | { kind: "CLUB_LEADER"; organizationId: string; accountId: string }
  | { kind: "AREA_COORDINATOR"; accountId: string }
  | { kind: "HEALTH_ROLE"; userId: string; eventIds: readonly string[] }
  /** `actAsId` is set when the administrator is acting as a club director (#442), so the audit shows it. */
  | { kind: "SYSTEM_ADMIN"; userId: string; actAsId?: string };

export type HealthAction = "VIEW" | "EDIT" | "SEND_LINK";

export function viewerCan(viewer: HealthViewer, organizationId: string, action: HealthAction) {
  // Everyone but the club's own leaders only looks.
  if (viewer.kind !== "CLUB_LEADER") return action === "VIEW";
  return viewer.organizationId === organizationId;
}

/** Coordinators and the health role see a member only through an event they can access. */
export function viewerNeedsEvent(viewer: HealthViewer) {
  return viewer.kind === "AREA_COORDINATOR" || viewer.kind === "HEALTH_ROLE";
}

export function viewerCanSeeEvent(viewer: HealthViewer, eventId: string) {
  return viewer.kind !== "HEALTH_ROLE" || viewer.eventIds.includes(eventId);
}

/** Audit attribution: who, never what they saw. */
export function healthAuditActor(viewer: HealthViewer): {
  actorUserId?: string;
  metadata: { viewerKind: HealthViewer["kind"]; actorAttendeeAccountId?: string; actAsId?: string };
} {
  switch (viewer.kind) {
    case "SYSTEM_ADMIN":
      return { actorUserId: viewer.userId, metadata: { viewerKind: viewer.kind, ...(viewer.actAsId ? { actAsId: viewer.actAsId } : {}) } };
    case "HEALTH_ROLE":
      return { actorUserId: viewer.userId, metadata: { viewerKind: viewer.kind } };
    case "AREA_COORDINATOR":
    case "CLUB_LEADER":
      return { metadata: { viewerKind: viewer.kind, actorAttendeeAccountId: viewer.accountId } };
  }
}

export function viewerActorId(viewer: HealthViewer) {
  return viewer.kind === "SYSTEM_ADMIN" || viewer.kind === "HEALTH_ROLE" ? viewer.userId : viewer.accountId;
}

// ---------------------------------------------------------------------------
// The event window.

/**
 * How long after an event ends its attendees' records stay open to an Area
 * Coordinator or the health role. This is the coordinator health view's rule
 * (#658, `HEALTH_WINDOW_DAYS`): open from registration until 30 days after the
 * event's last day, inclusive, in the event's time zone. It is restated here as
 * one named constant until #658 merges and the two can share a definition.
 */
export const HEALTH_WINDOW_DAYS = 30;

function addCalendarDays(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** The last calendar day (event time zone, inclusive) an event's attendee records may be opened. */
export function healthWindowEndsOn(event: { timezone: string; endsAt: Date }) {
  return addCalendarDays(calendarDateInEventTimeZone(event.endsAt, event.timezone), HEALTH_WINDOW_DAYS);
}

/**
 * There is no start bound of its own: a member can only be an attendee after
 * registering, so "from registration" is the attendee check itself.
 */
export function healthWindowOpen(event: { timezone: string; endsAt: Date }, now: Date) {
  return calendarDateInEventTimeZone(now, event.timezone) <= healthWindowEndsOn(event);
}
