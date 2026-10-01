import { calendarDateInEventTimeZone } from "@/modules/events/lifecycle";

/**
 * Coordinator health view (#658, ADR 0005 Addendum C). Pure rules: who may see
 * what, the 30-day window, and how existing answers become one sheet. Nothing
 * here reads or writes the database.
 *
 * Only these things are ever shown, per attendee of a club event:
 * - the free-text `dietary_needs` answer, labelled as entered (not an allergy record);
 * - the yes/no `medical_or_accessibility_need` flag;
 * - emergency contacts from two club forms (the permission slip's
 *   `emergency_contact_phone`, the passenger list's `passenger_N_emergency_contact`).
 * Every other field on those forms is ignored. Medications are not collected.
 */

export const HEALTH_WINDOW_DAYS = 30;

export const HEALTH_TEXT = {
  dietaryLabel: "Dietary restrictions / allergies (as entered)",
  dietaryHelp: "Free text the club typed at registration. It is not a full allergy record.",
  medicalFlagLabel: "Medical or accessibility need flag",
  medicalFlagHelp: "Yes or no only. The club director knows the details.",
  medicationsLabel: "Medications",
  medicationsValue: "Not collected",
  medicationsHelp: "The encrypted Health record (#611) will add medications.",
  emergencyLabel: "Emergency contact",
  confidential: "CONFIDENTIAL: health information for event care only. Do not copy, post, or share.",
} as const;

export const PERMISSION_SLIP_KEY = "off_premises_permission_slip";
export const PASSENGER_LIST_KEY = "transportation_passenger_list";
export const HEALTH_FORM_KEYS = [PERMISSION_SLIP_KEY, PASSENGER_LIST_KEY] as const;
export const PASSENGER_SLOTS = 20;

/** The only keys read from the sealed or plain answers of the two forms. Every other key stays unread. */
export const SLIP_EMERGENCY_KEY = "emergency_contact_phone";
export const passengerNameKey = (slot: number) => `passenger_${slot}_name`;
export const passengerEmergencyKey = (slot: number) => `passenger_${slot}_emergency_contact`;

export const ATTENDEE_DIETARY_KEY = "dietary_needs";
export const ATTENDEE_MEDICAL_FLAG_KEY = "medical_or_accessibility_need";

// ---------------------------------------------------------------------------
// The 30-day window

function addDays(isoDate: string, days: number) {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/**
 * The last calendar day (event time zone, inclusive) the health view is open:
 * 30 days after the event's last day. This is this view's own rule; the club
 * forms "has not ended" rule is separate and unchanged.
 */
export function healthWindowEndsOn(event: { timezone: string; endsAt: Date }) {
  return addDays(calendarDateInEventTimeZone(event.endsAt, event.timezone), HEALTH_WINDOW_DAYS);
}

/** Open from registration until 30 days after the event ends, then closed for everyone, system administrators included. */
export function healthWindowOpen(event: { timezone: string; endsAt: Date }, now = new Date()) {
  return calendarDateInEventTimeZone(now, event.timezone) <= healthWindowEndsOn(event);
}

// ---------------------------------------------------------------------------
// Who may see it

export type HealthActor =
  | { kind: "ATTENDEE"; accountId: string }
  | { kind: "STAFF_ACTING"; userId: string; actAsId: string };

export type HealthViewer =
  /** Automatic. A staff account, which already passed two-step sign-in. */
  | { kind: "SYSTEM_ADMIN"; userId: string }
  /** Holds VIEW_HEALTH_INFORMATION on these events only (granted by a system administrator). */
  | { kind: "HEALTH_ROLE"; userId: string; eventIds: readonly string[] }
  /** Automatic. An active Area Coordinator who passed the second step. */
  | { kind: "AREA_COORDINATOR"; accountId: string }
  /** The club's own director or deputy, for that club only. */
  | { kind: "CLUB_LEADER"; organizationId: string; actor: HealthActor };

export function viewerCanSeeEvent(viewer: HealthViewer, eventId: string) {
  return viewer.kind !== "HEALTH_ROLE" || viewer.eventIds.includes(eventId);
}

export function viewerCanSeeClub(viewer: HealthViewer, organizationId: string) {
  return viewer.kind !== "CLUB_LEADER" || viewer.organizationId === organizationId;
}

/** Audit fields that say who looked, never what they saw. */
export function healthAuditActor(viewer: HealthViewer): {
  actorUserId?: string;
  metadata: { viewerKind: HealthViewer["kind"]; actorAttendeeAccountId?: string; actAsId?: string };
} {
  switch (viewer.kind) {
    case "SYSTEM_ADMIN":
    case "HEALTH_ROLE":
      return { actorUserId: viewer.userId, metadata: { viewerKind: viewer.kind } };
    case "AREA_COORDINATOR":
      return { metadata: { viewerKind: viewer.kind, actorAttendeeAccountId: viewer.accountId } };
    case "CLUB_LEADER":
      return viewer.actor.kind === "ATTENDEE"
        ? { metadata: { viewerKind: viewer.kind, actorAttendeeAccountId: viewer.actor.accountId } }
        : { actorUserId: viewer.actor.userId, metadata: { viewerKind: viewer.kind, actAsId: viewer.actor.actAsId } };
  }
}

// ---------------------------------------------------------------------------
// Building the sheet

export type EmergencyContact = {
  value: string;
  formName: string;
  /** ISO date the form was submitted. */
  submittedOn: string | null;
  /** Roster-linked slips are exact; passenger lists are matched by name within the club. */
  matchedBy: "ROSTER_MEMBER" | "NAME";
  kind: "PHONE_ONLY" | "NAME_AND_PHONE";
};

export type HealthAttendeeRow = {
  attendeeId: string;
  name: string;
  dietary: string | null;
  medicalFlag: "Yes" | "No" | null;
  emergencyContacts: EmergencyContact[];
};

export type HealthClubSheet = {
  organizationId: string;
  clubName: string;
  attendees: HealthAttendeeRow[];
};

function shortText(value: unknown, max: number) {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

export function normalizeName(first: string, last: string) {
  return `${first} ${last}`.replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
}

export function dietaryFromResponses(responses: unknown) {
  if (!responses || typeof responses !== "object") return null;
  return shortText((responses as Record<string, unknown>)[ATTENDEE_DIETARY_KEY], 500);
}

export function medicalFlagFromResponses(responses: unknown): "Yes" | "No" | null {
  if (!responses || typeof responses !== "object") return null;
  const value = shortText((responses as Record<string, unknown>)[ATTENDEE_MEDICAL_FLAG_KEY], 10);
  return value === "Yes" || value === "No" ? value : null;
}

export type SlipEmergencyInput = { rosterMemberId: string | null; formName: string; submittedAt: Date | null; emergencyPhone: unknown };
export type PassengerEmergencyInput = {
  formName: string;
  submittedAt: Date | null;
  passengers: Array<{ name: unknown; emergencyContact: unknown }>;
};

export function slipContact(input: SlipEmergencyInput): EmergencyContact | null {
  const value = shortText(input.emergencyPhone, 60);
  if (!value) return null;
  return { value, formName: input.formName, submittedOn: input.submittedAt?.toISOString().slice(0, 10) ?? null, matchedBy: "ROSTER_MEMBER", kind: "PHONE_ONLY" };
}

export function passengerContacts(input: PassengerEmergencyInput) {
  return input.passengers.flatMap((passenger) => {
    const name = shortText(passenger.name, 120);
    const value = shortText(passenger.emergencyContact, 200);
    if (!name || !value) return [];
    return [{
      name,
      contact: {
        value,
        formName: input.formName,
        submittedOn: input.submittedAt?.toISOString().slice(0, 10) ?? null,
        matchedBy: "NAME" as const,
        kind: "NAME_AND_PHONE" as const,
      } satisfies EmergencyContact,
    }];
  });
}

/** Sorts a club's attendees by name for a stable sheet. */
export function sortAttendees(rows: HealthAttendeeRow[]) {
  return [...rows].sort((left, right) => left.name.localeCompare(right.name, "en-US"));
}
