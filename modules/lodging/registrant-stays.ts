import "server-only";

import { eventStartDate, minorStatusAt, personAgeFromAnswers } from "@/modules/guardian-authority/domain";
import { assignableRegistrationStatuses, type PlanUnit, type Segment } from "@/modules/lodging/assignment-domain";
import { toNight } from "@/modules/lodging/assignment-state";
import type { UnitNightState } from "@/modules/lodging/domain";
import { attendeeName, type Client } from "@/modules/lodging/preferences-service";
import { buildStays, type Stay, type StayRoommate } from "@/modules/lodging/stays";

/**
 * What the private registration page and a room notice need, loaded narrowly: one registration's own attendees and
 * assignments, the units they are in, and (only when roommates are on) the other people in those same units. It does
 * not load the event's people, requests, rules, waitlist or reports, so a guest opening their page costs a handful of
 * small queries however large the event is.
 */
export type RegistrantStays = {
  published: boolean;
  instructions: string | null;
  showRoommates: boolean;
  /** Whether the registration is submitted or confirmed (a cancelled one sees nothing). */
  active: boolean;
  stays: Stay[];
};

export async function loadRegistrantStays(client: Client, eventId: string, registrationId: string): Promise<RegistrantStays> {
  const lodging = await client.eventLodging.findUnique({
    where: { eventId },
    select: { showAssignmentsToAttendees: true, showRoommateFirstNames: true, attendeeInstructions: true, event: { select: { startsAt: true, timezone: true } } },
  });
  if (!lodging || !lodging.showAssignmentsToAttendees) return { published: false, instructions: null, showRoommates: false, active: false, stays: [] };
  const base = { published: true, instructions: lodging.attendeeInstructions, showRoommates: lodging.showRoommateFirstNames };
  const registration = await client.registration.findFirst({
    where: { id: registrationId, eventId, status: { in: [...assignableRegistrationStatuses] } },
    select: { attendees: { orderBy: [{ position: "asc" }, { id: "asc" }], select: { id: true, profileSnapshot: true, person: { select: { firstName: true, lastName: true } } } } },
  });
  if (!registration) return { ...base, active: false, stays: [] };
  const own = registration.attendees.map((attendee) => ({ occupantKey: attendee.id, name: attendeeName(attendee) }));
  const ownIds = own.map((person) => person.occupantKey);
  const ownRows = ownIds.length === 0 ? [] : await client.eventLodgingAssignment.findMany({ where: { eventId, cancelledAt: null, attendeeId: { in: ownIds } } });
  const toSegment = (row: (typeof ownRows)[number]): Segment => ({
    id: row.id, occupantKey: (row.attendeeId ?? row.placeholderId)!, unitId: row.eventLodgingUnitId, bucketId: row.bucketId,
    people: row.people, firstNight: toNight(row.firstNight), lastNight: toNight(row.lastNight),
  });
  const unitIds = [...new Set(ownRows.flatMap((row) => (row.eventLodgingUnitId ? [row.eventLodgingUnitId] : [])))];
  const bucketIds = [...new Set(ownRows.flatMap((row) => (row.bucketId ? [row.bucketId] : [])))];
  const coRows = base.showRoommates && unitIds.length > 0
    ? await client.eventLodgingAssignment.findMany({
      where: { eventId, cancelledAt: null, eventLodgingUnitId: { in: unitIds }, OR: [{ attendeeId: null }, { attendeeId: { notIn: ownIds } }] },
    })
    : [];
  const [unitRows, bucketRows] = await Promise.all([
    unitIds.length === 0 ? [] : client.eventLodgingUnit.findMany({
      where: { id: { in: unitIds }, eventId },
      include: { unit: { include: { building: true } }, holds: { where: { releasedAt: null }, select: { id: true, firstNight: true, lastNight: true } } },
    }),
    bucketIds.length === 0 ? [] : client.eventLodgingBucket.findMany({ where: { id: { in: bucketIds }, eventId }, select: { id: true, label: true } }),
  ]);
  const units = new Map<string, { name: string; buildingName: string; state: PlanUnit }>();
  for (const row of unitRows) {
    const state: UnitNightState = {
      unitId: row.id, assignable: row.assignable, retired: row.retired, defaultCapacity: row.defaultCapacity, capacityOverride: row.capacityOverride,
      unavailable: row.unavailable, activeFrom: row.unit.activeFrom ? toNight(row.unit.activeFrom) : null, activeUntil: row.unit.activeUntil ? toNight(row.unit.activeUntil) : null,
      holds: row.holds.map((hold) => ({ id: hold.id, firstNight: toNight(hold.firstNight), lastNight: toNight(hold.lastNight) })),
    };
    units.set(row.id, { name: row.unit.name, buildingName: row.unit.building.name, state: { ...state, name: row.unit.name, specialUse: row.unit.specialUse } });
  }
  const others = new Map<string, StayRoommate>();
  const coAttendeeIds = coRows.flatMap((row) => (row.attendeeId ? [row.attendeeId] : []));
  if (coAttendeeIds.length > 0) {
    const startDate = eventStartDate(lodging.event.startsAt, lodging.event.timezone);
    const attendees = await client.registrationAttendee.findMany({
      where: { id: { in: coAttendeeIds }, eventId },
      select: { id: true, profileSnapshot: true, formResponses: true, person: { select: { firstName: true, lastName: true } }, registration: { select: { status: true } } },
    });
    const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
    for (const attendee of attendees) {
      const active = (assignableRegistrationStatuses as readonly string[]).includes(attendee.registration.status);
      others.set(attendee.id, {
        name: attendeeName(attendee), people: 1,
        nameable: active && minorStatusAt(personAgeFromAnswers(record(attendee.formResponses), record(attendee.profileSnapshot)), startDate).status === "ADULT",
      });
    }
  }
  for (const row of coRows) {
    if (!row.attendeeId) others.set(row.placeholderId!, { name: "", people: row.people, nameable: false });
  }
  const stays = buildStays({
    own,
    segments: [...ownRows.map(toSegment), ...coRows.map(toSegment)],
    units,
    bucketLabels: new Map(bucketRows.map((bucket) => [bucket.id, bucket.label])),
    others,
    showRoommates: base.showRoommates,
  });
  return { ...base, active: true, stays };
}

/**
 * The assignment version of a registration: how many history rows exist for its attendees. It only ever grows, so a
 * notice written at version N is out of date as soon as any later change is recorded.
 */
export async function registrationAssignmentVersion(client: Client, eventId: string, registrationId: string) {
  const attendees = await client.registrationAttendee.findMany({ where: { eventId, registrationId }, select: { id: true } });
  if (attendees.length === 0) return 0;
  return client.eventLodgingAssignmentHistory.count({ where: { eventId, attendeeId: { in: attendees.map((attendee) => attendee.id) } } });
}
