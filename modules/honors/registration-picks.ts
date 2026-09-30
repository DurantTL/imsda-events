/**
 * Honors picked while a club registers (#618). Pure helpers, safe on the
 * client and the server. The rules themselves (capacity, one class per
 * session, minimum age, per-site visibility) live in `enrollment-domain.ts`,
 * `locations.ts` and `enrollment-repository.ts`; nothing here repeats them.
 */
import { z } from "zod";
import { clubAttendeeClientId, clubGuestClientId, guestIsAdult } from "@/modules/club-registrations/domain";
import { consumesClassSeat, selectionProblem, type SelectableOffering } from "@/modules/honors/enrollment-domain";
import { sessionVisibleAtLocation } from "@/modules/honors/locations";

/** The picks as sent by the browser: client id to class ids, for at most 60 people (the same cap as the class save). */
export const honorSelectionsSchema = z.record(z.string().min(1).max(80), z.array(z.string().min(1).max(64)).max(6))
  .refine((picks) => Object.keys(picks).length <= 60, "Too many people in one save.");

/** Where the "your honors weren't saved" note waits across the refresh after submitting; per club and event. */
export function honorsNoteKey(organizationId: string, eventId: string) {
  return `club-honors-note:${organizationId}:${eventId}`;
}

/** A person on the not-yet-submitted registration, keyed by the same client id the event form uses. */
export type PickingAttendee = {
  clientId: string;
  firstName: string;
  lastName: string;
  ageOnEventDate: number | null;
  attendeeType: "YOUTH" | "STAFF" | "ADULT" | "UNDERAGE" | null;
  consumesSeat: boolean;
};

export function pickingAttendees(input: {
  roster: ReadonlyArray<{ memberId: string; firstName: string; lastName: string; ageOnEventDate: number | null; attendeeType: PickingAttendee["attendeeType"] }>;
  selectedMemberIds: readonly string[];
  guests: ReadonlyArray<{ id: string; firstName: string; lastName: string; age: number }>;
  /** Ages typed in for roster people with no birth date (#639), by roster member id. */
  rosterAges?: Readonly<Record<string, number>>;
}): PickingAttendee[] {
  const selected = new Set(input.selectedMemberIds);
  const people = input.roster.filter((person) => selected.has(person.memberId)).map((person) => ({
    clientId: clubAttendeeClientId(person.memberId),
    firstName: person.firstName,
    lastName: person.lastName,
    // A roster age always wins; the typed-in age only fills a missing one.
    ageOnEventDate: person.ageOnEventDate ?? input.rosterAges?.[person.memberId] ?? null,
    attendeeType: person.attendeeType,
    consumesSeat: consumesClassSeat(person.attendeeType),
  }));
  // Extra people count as adults from 18, as the registration itself decides.
  const guests = input.guests.map((guest) => {
    const attendeeType = guestIsAdult(guest) ? "ADULT" as const : "YOUTH" as const;
    return {
      clientId: clubGuestClientId(guest.id),
      firstName: guest.firstName,
      lastName: guest.lastName,
      ageOnEventDate: guest.age,
      attendeeType,
      consumesSeat: consumesClassSeat(attendeeType),
    };
  });
  return [...people, ...guests];
}

type PickableOffering = SelectableOffering & { siteId: string | null };

/** The classes this registration's site offers: the same visibility rule the server applies on save (#589). */
export function offeringsAtLocation<T extends { siteId: string | null; isActive: boolean }>(offerings: readonly T[], locationId: string | null) {
  return offerings.filter((offering) => offering.isActive && sessionVisibleAtLocation(offering.siteId, locationId));
}

/** Drops picks for people no longer going and classes not offered here, so a stale draft never blocks the form. */
export function prunePicks(
  picks: Readonly<Record<string, readonly string[]>>,
  attendees: ReadonlyArray<Pick<PickingAttendee, "clientId">>,
  offerings: ReadonlyArray<{ id: string }>,
) {
  const going = new Set(attendees.map((attendee) => attendee.clientId));
  const offered = new Set(offerings.map((offering) => offering.id));
  const next: Record<string, string[]> = {};
  for (const [clientId, ids] of Object.entries(picks)) {
    if (!going.has(clientId)) continue;
    const kept = ids.filter((id) => offered.has(id));
    if (kept.length > 0) next[clientId] = kept;
  }
  return next;
}

/** The first thing wrong with these picks by the shared enrollment rules, or null. The server checks capacity on save. */
export function firstPickProblem(
  picks: Readonly<Record<string, readonly string[]>>,
  attendees: readonly PickingAttendee[],
  offerings: readonly PickableOffering[],
) {
  const byId = new Map(offerings.map((offering) => [offering.id, offering]));
  for (const attendee of attendees) {
    const problem = selectionProblem(attendee, picks[attendee.clientId] ?? [], byId);
    if (problem) return `${attendee.firstName} ${attendee.lastName}: ${problem}`.trim();
  }
  return null;
}

/**
 * Turns picks keyed by client id into picks keyed by the saved registration
 * attendee, using the roster member or extra-person id each attendee's
 * snapshot remembers. `unknown` lists client ids with no such attendee.
 */
export function picksByAttendeeId(
  picks: Readonly<Record<string, readonly string[]>>,
  attendees: ReadonlyArray<{ id: string; clubRosterMemberId?: string | null; clubGuestId?: string | null; groupAttendeeId?: string | null }>,
) {
  const idByClientId = new Map<string, string>();
  for (const attendee of attendees) {
    if (attendee.clubRosterMemberId) idByClientId.set(clubAttendeeClientId(attendee.clubRosterMemberId), attendee.id);
    if (attendee.clubGuestId) idByClientId.set(clubGuestClientId(attendee.clubGuestId), attendee.id);
    // A "Group" person is keyed by the client id the registration form gave them (#650).
    if (attendee.groupAttendeeId) idByClientId.set(attendee.groupAttendeeId, attendee.id);
  }
  const mapped: Record<string, string[]> = {};
  const unknown: string[] = [];
  for (const [clientId, ids] of Object.entries(picks)) {
    if (ids.length === 0) continue;
    const attendeeId = idByClientId.get(clientId);
    if (attendeeId) mapped[attendeeId] = [...ids];
    else unknown.push(clientId);
  }
  return { mapped, unknown };
}
