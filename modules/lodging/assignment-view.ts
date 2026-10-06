import "server-only";

import type { PrismaClient } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { addDays, nightsInclusive, unitNight, type LodgingBathroom, type LodgingCategory, type LodgingUnitKind, type NightStatus } from "@/modules/lodging/domain";
import {
  householdColorIndex,
  occupancyByNight,
  occupancyOf,
  overBedsByNight,
  type OccupancyNight,
} from "@/modules/lodging/assignment-domain";
import {
  loadAssignmentFacts,
  visibleExceptions,
  type AssignmentFacts,
  type NoticeFact,
  type PersonFact,
  type VisibleException,
  type WaitlistFact,
} from "@/modules/lodging/assignment-facts";
import { loadRegistrantStays } from "@/modules/lodging/registrant-stays";
import { togetherGroupsOn } from "@/modules/lodging/preferences-domain";
import type { Client } from "@/modules/lodging/preferences-service";

/**
 * The staff assignment workspace (#200), the permission-scoped reports, and what an attendee sees on their private
 * page. All of them are built from `loadAssignmentFacts` so a number on one screen is the number on the others.
 *
 * Privacy: accessibility flags exist only on the staff view and only when `canSeeSensitive`; the attendee view holds
 * building, room, nights, instructions and (only when staff turned it on) roommates' first names. Never an email,
 * a phone number, an address or a last name.
 */

export const HOUSEHOLD_PALETTE_SIZE = 12;

export type OccupantCard = {
  assignmentId: string;
  occupantKey: string;
  occupantId: string;
  kind: "ATTENDEE" | "PLACEHOLDER";
  name: string;
  registrationCode: string | null;
  firstNight: string;
  lastNight: string;
  people: number;
  colorIndex: number;
  /** Placed on a registration that is no longer active. */
  inactive: boolean;
  /** Staff with VIEW_SENSITIVE_DATA only. */
  groundFloorNeeded?: boolean;
  accessibleRoomNeeded?: boolean;
};

export type UnitStatusWord = "AVAILABLE" | "PARTIAL" | "FULL" | "OVER" | "HELD" | "UNAVAILABLE" | "NOT_ASSIGNABLE";

export type UnitCard = {
  eventUnitId: string;
  key: string;
  name: string;
  kind: LodgingUnitKind;
  isArea: boolean;
  floor: number | null;
  groundLevel: boolean;
  bathroom: LodgingBathroom;
  specialUse: boolean;
  category: LodgingCategory | null;
  beds: string;
  status: UnitStatusWord;
  /** The largest number of people the unit takes on any in-service night; null is no fixed limit. */
  capacity: number | null;
  /** Per night, aligned with `nights`. */
  nightStatuses: NightStatus[];
  nightCapacities: Array<number | null>;
  nightOccupied: number[];
  holdReasons: string[];
  unavailableReason: string | null;
  /** One party is in the room above its beds (bringing extra bedding): a warning, not an over-capacity conflict. */
  extraBedding: boolean;
  occupants: OccupantCard[];
};

export type PersonCard = {
  occupantKey: string;
  occupantId: string;
  kind: "ATTENDEE" | "PLACEHOLDER";
  name: string;
  registrationId: string | null;
  registrationCode: string | null;
  registrationStatus: string | null;
  active: boolean;
  colorIndex: number;
  people: number;
  category: LodgingCategory | null;
  /** Rooms the registrant chose, and whether they will bring extra bedding (the party is larger than the beds in those rooms). */
  roomCount: number;
  bringsExtraBedding: boolean;
  asksForLodging: boolean;
  wantedFirstNight: string | null;
  wantedLastNight: string | null;
  wantedNights: number;
  placements: Array<{ assignmentId: string; unitId: string | null; bucketId: string | null; label: string; firstNight: string; lastNight: string; people: number }>;
  uncoveredNights: number;
  waitlistStatus: string | null;
  /** Other members of the keep-together group (occupant keys), for the "place the whole household" and suggestion buttons. */
  householdKeys: string[];
  /** Staff with VIEW_SENSITIVE_DATA only. */
  groundFloorNeeded?: boolean;
  accessibleRoomNeeded?: boolean;
};

export type AssignmentWorkspaceView = {
  eventId: string;
  propertyName: string;
  nights: string[];
  settings: { showAssignmentsToAttendees: boolean; showRoommateFirstNames: boolean; attendeeInstructions: string | null };
  canSeeSensitive: boolean;
  palette: number;
  buildings: Array<{ key: string; name: string; floors: Array<{ floor: number | null; label: string; units: UnitCard[] }> }>;
  buckets: Array<{ id: string; kind: string; label: string; people: number; occupants: OccupantCard[] }>;
  people: PersonCard[];
  exceptions: VisibleException[];
  waitlist: WaitlistFact[];
  notices: NoticeFact[];
  counts: { placed: number; unplaced: number; waitingOnList: number; exceptions: number };
};

function floorLabel(floor: number | null) {
  if (floor === null) return "Grounds";
  if (floor === 1) return "1st floor";
  if (floor === 2) return "2nd floor";
  if (floor === 3) return "3rd floor";
  return `Floor ${floor}`;
}

/** The household a person is coloured by: their keep-together group when they have one, otherwise their registration. */
function householdIds(facts: AssignmentFacts) {
  const firstNight = facts.state.context.nights[0];
  const byKey = new Map<string, string>();
  const householdKeys = new Map<string, string[]>();
  const keyByPerson = new Map(facts.people.flatMap((person) => (person.personId ? [[person.personId, person.occupantKey] as const] : [])));
  if (firstNight) {
    for (const group of togetherGroupsOn(firstNight, facts.together)) {
      const keys = group.map((personId) => keyByPerson.get(personId)).filter((key): key is string => Boolean(key));
      const id = `group:${[...keys].sort()[0]}`;
      for (const key of keys) { byKey.set(key, id); householdKeys.set(key, keys); }
    }
  }
  for (const person of facts.people) {
    if (!byKey.has(person.occupantKey)) byKey.set(person.occupantKey, person.registrationId ?? person.occupantKey);
  }
  return { byKey, householdKeys };
}

export async function getAssignmentWorkspace(eventId: string, options: { canSeeSensitive: boolean; now?: Date }, client: PrismaClient = getPrisma()): Promise<AssignmentWorkspaceView> {
  const facts = await loadAssignmentFacts(client, eventId, { now: options.now });
  const { state } = facts;
  const nights = state.context.nights;
  const lodging = await client.eventLodging.findUniqueOrThrow({ where: { eventId }, select: { showAssignmentsToAttendees: true, showRoommateFirstNames: true, attendeeInstructions: true, property: { select: { name: true } } } });
  const holds = await client.eventLodgingHold.findMany({ where: { eventId, releasedAt: null }, select: { eventLodgingUnitId: true, reason: true } });
  const holdReasons = new Map<string, string[]>();
  for (const hold of holds) holdReasons.set(hold.eventLodgingUnitId, [...(holdReasons.get(hold.eventLodgingUnitId) ?? []), hold.reason]);
  const { byKey: householdOf, householdKeys } = householdIds(facts);
  const colorOf = (occupantKey: string) => householdColorIndex(householdOf.get(occupantKey) ?? occupantKey, HOUSEHOLD_PALETTE_SIZE);
  const occupancy = occupancyOf(state.segments);
  const rowById = state.rowsById;

  const occupantCard = (segment: { id: string; occupantKey: string; firstNight: string; lastNight: string; people: number }): OccupantCard => {
    const person = facts.personByKey.get(segment.occupantKey);
    const row = rowById.get(segment.id);
    return {
      assignmentId: segment.id,
      occupantKey: segment.occupantKey,
      occupantId: person?.occupantId ?? segment.occupantKey,
      kind: person?.kind ?? (row?.placeholderId && !row.attendeeId ? "PLACEHOLDER" : "ATTENDEE"),
      name: person?.name ?? "Someone",
      registrationCode: person?.registrationCode ?? null,
      firstNight: segment.firstNight,
      lastNight: segment.lastNight,
      people: segment.people,
      colorIndex: colorOf(segment.occupantKey),
      inactive: person ? !person.active : false,
      ...(options.canSeeSensitive && person ? { groundFloorNeeded: person.groundFloorNeeded, accessibleRoomNeeded: person.accessibleRoomNeeded } : {}),
    };
  };

  const buildings = new Map<string, { sort: number; key: string; name: string; floors: Map<number | null, Array<{ sort: number; card: UnitCard }>> }>();
  for (const row of state.unitRows) {
    const unitState = state.units.get(row.id)!;
    const segments = state.segments.filter((segment) => segment.unitId === row.id);
    // A retired unit stays only while someone is still placed in it.
    if (row.retired && segments.length === 0) continue;
    const nightRows = nights.map((night) => unitNight(unitState, night, occupancy.get(row.id)?.get(night) ?? 0));
    const inService = nightRows.filter((entry) => entry.status === "AVAILABLE");
    const capacities = inService.map((entry) => entry.capacity);
    const capacity = capacities.length === 0 ? 0 : capacities.includes(null) ? null : Math.max(...(capacities as number[]));
    let status: UnitStatusWord;
    let extraBedding = false;
    const overNights = overBedsByNight(unitState, segments, nights);
    if (!row.assignable || row.retired) status = "NOT_ASSIGNABLE";
    else if (nightRows.length > 0 && nightRows.every((entry) => entry.status === "UNAVAILABLE")) status = "UNAVAILABLE";
    else if (nightRows.length > 0 && nightRows.every((entry) => entry.status === "HELD" || entry.status === "UNAVAILABLE")) status = "HELD";
    else if (overNights.length > 0) {
      // Night by night, as the closeout report does: a night above the beds with one party in the room is that party bringing
      // sleeping bags or air mattresses (shown as full, with a warning); a night with anyone else in it is over capacity.
      const overParties = overNights.filter((over) => !over.oneParty);
      extraBedding = overParties.length < overNights.length;
      status = overParties.length > 0 ? "OVER" : "FULL";
    }
    else if (inService.length > 0 && inService.every((entry) => entry.capacity !== null && entry.capacity > 0 && entry.occupied >= entry.capacity)) status = "FULL";
    else if (nightRows.some((entry) => entry.occupied > 0)) status = "PARTIAL";
    else status = "AVAILABLE";
    const card: UnitCard = {
      eventUnitId: row.id,
      key: row.unit.key,
      name: row.unit.name,
      kind: row.unit.kind,
      isArea: row.unit.isArea,
      floor: row.unit.floor,
      groundLevel: row.unit.groundLevel || row.unit.kind !== "ROOM",
      bathroom: row.unit.bathroom,
      specialUse: row.unit.specialUse,
      category: row.unit.category,
      beds: row.bedsSummary,
      status,
      capacity,
      nightStatuses: nightRows.map((entry) => entry.status),
      nightCapacities: nightRows.map((entry) => entry.capacity),
      nightOccupied: nightRows.map((entry) => entry.occupied),
      holdReasons: holdReasons.get(row.id) ?? [],
      unavailableReason: row.unavailable ? row.unavailableReason : null,
      extraBedding,
      occupants: segments.map(occupantCard),
    };
    const building = buildings.get(row.unit.buildingId) ?? { sort: row.unit.building.sortOrder, key: row.unit.building.key, name: row.unit.building.name, floors: new Map() };
    const floorUnits = building.floors.get(row.unit.floor) ?? [];
    floorUnits.push({ sort: row.unit.sortOrder, card });
    building.floors.set(row.unit.floor, floorUnits);
    buildings.set(row.unit.buildingId, building);
  }

  const placementsOf = new Map<string, PersonCard["placements"]>();
  for (const segment of state.segments) {
    const label = segment.unitId ? `${state.meta.get(segment.unitId)?.name ?? "Room"}` : state.buckets.find((bucket) => bucket.id === segment.bucketId)?.label ?? "Housing";
    placementsOf.set(segment.occupantKey, [...(placementsOf.get(segment.occupantKey) ?? []), { assignmentId: segment.id, unitId: segment.unitId, bucketId: segment.bucketId, label, firstNight: segment.firstNight, lastNight: segment.lastNight, people: segment.people }]);
  }
  const people: PersonCard[] = facts.people.map((person: PersonFact) => {
    const placements = placementsOf.get(person.occupantKey) ?? [];
    const covered = new Set<string>();
    for (const placement of placements) for (const night of nightsInclusive(placement.firstNight, placement.lastNight)) covered.add(night);
    const wanted = person.wantedNights;
    return {
      occupantKey: person.occupantKey,
      occupantId: person.occupantId,
      kind: person.kind,
      name: person.name,
      registrationId: person.registrationId,
      registrationCode: person.registrationCode,
      registrationStatus: person.registrationStatus,
      active: person.active,
      colorIndex: colorOf(person.occupantKey),
      people: person.people,
      category: person.category,
      roomCount: person.roomCount,
      bringsExtraBedding: person.bringsExtraBedding,
      asksForLodging: person.asksForLodging,
      wantedFirstNight: wanted[0] ?? null,
      wantedLastNight: wanted[wanted.length - 1] ?? null,
      wantedNights: wanted.length,
      placements,
      uncoveredNights: person.active && person.asksForLodging ? wanted.filter((night) => !covered.has(night)).length : 0,
      waitlistStatus: person.waitlistStatus,
      householdKeys: (householdKeys.get(person.occupantKey) ?? []).filter((key) => key !== person.occupantKey),
      ...(options.canSeeSensitive ? { groundFloorNeeded: person.groundFloorNeeded, accessibleRoomNeeded: person.accessibleRoomNeeded } : {}),
    };
  });

  const bucketCards = state.buckets.map((bucket) => {
    const segments = state.segments.filter((segment) => segment.bucketId === bucket.id);
    return { id: bucket.id, kind: bucket.kind, label: bucket.label, people: segments.reduce((total, segment) => total + segment.people, 0), occupants: segments.map(occupantCard) };
  });
  const exceptions = visibleExceptions(facts.exceptions, options.canSeeSensitive);
  return {
    eventId,
    propertyName: lodging.property.name,
    nights,
    settings: { showAssignmentsToAttendees: lodging.showAssignmentsToAttendees, showRoommateFirstNames: lodging.showRoommateFirstNames, attendeeInstructions: lodging.attendeeInstructions },
    canSeeSensitive: options.canSeeSensitive,
    palette: HOUSEHOLD_PALETTE_SIZE,
    buildings: [...buildings.values()].sort((a, b) => a.sort - b.sort).map((building) => ({
      key: building.key,
      name: building.name,
      floors: [...building.floors.entries()]
        .sort(([a], [b]) => (a ?? 0) - (b ?? 0))
        .map(([floor, units]) => ({ floor, label: floorLabel(floor), units: units.sort((a, b) => a.sort - b.sort).map((entry) => entry.card) })),
    })),
    buckets: bucketCards,
    people,
    exceptions,
    waitlist: facts.waitlist,
    notices: facts.notices,
    counts: {
      placed: people.filter((person) => person.active && person.placements.length > 0).length,
      unplaced: people.filter((person) => person.uncoveredNights > 0).length,
      waitingOnList: facts.waitlist.filter((entry) => ["JOINED", "OFFERED", "ACCEPTED"].includes(entry.status)).length,
      exceptions: exceptions.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Reports (permission-scoped: the caller decides VIEW_REPORTS / MANAGE_REGISTRATION and VIEW_SENSITIVE_DATA)
// ---------------------------------------------------------------------------

export type RoomingOccupant = {
  assignmentId: string;
  occupantId: string;
  kind: "Attendee" | "Placeholder";
  name: string;
  registrationCode: string;
  firstNight: string;
  lastNight: string;
  people: number;
  groundFloorNeeded?: boolean;
  accessibleRoomNeeded?: boolean;
};

export type RoomingGroup = {
  /** Where: a unit ("unit:<key>") or a housing choice ("bucket:<kind>"). */
  placeKey: string;
  building: string;
  place: string;
  floor: number | null;
  capacity: number | null;
  occupants: RoomingOccupant[];
};

export type OccupancyUnitRow = {
  unitId: string;
  building: string;
  name: string;
  nights: Array<{ night: string; status: NightStatus; occupied: number; capacity: number | null; assignmentIds: string[] }>;
};

export type KeyHandoffRow = {
  building: string;
  place: string;
  placeKey: string;
  people: number;
  arrival: string;
  /** The morning after the last night. */
  departure: string;
  holder: string;
  registrationCodes: string[];
};

export type RoomingReports = {
  eventId: string;
  nights: string[];
  canSeeSensitive: boolean;
  rooming: RoomingGroup[];
  occupancy: OccupancyNight[];
  occupancyByUnit: OccupancyUnitRow[];
  unassigned: VisibleException[];
  conflicts: VisibleException[];
  closeout: VisibleException[];
  keyHandoff: KeyHandoffRow[];
};

export async function getRoomingReports(eventId: string, options: { canSeeSensitive: boolean; now?: Date }, client: PrismaClient = getPrisma()): Promise<RoomingReports> {
  const facts = await loadAssignmentFacts(client, eventId, { now: options.now });
  return buildRoomingReports(eventId, facts, options.canSeeSensitive);
}

export function buildRoomingReports(eventId: string, facts: AssignmentFacts, canSeeSensitive: boolean): RoomingReports {
  const { state } = facts;
  const nights = state.context.nights;
  const occupantOf = (segment: { id: string; occupantKey: string; firstNight: string; lastNight: string; people: number }): RoomingOccupant => {
    const person = facts.personByKey.get(segment.occupantKey);
    return {
      assignmentId: segment.id,
      occupantId: person?.occupantId ?? segment.occupantKey,
      kind: person?.kind === "PLACEHOLDER" ? "Placeholder" : "Attendee",
      name: person?.name ?? "Someone",
      registrationCode: person?.registrationCode ?? "",
      firstNight: segment.firstNight,
      lastNight: segment.lastNight,
      people: segment.people,
      ...(canSeeSensitive && person ? { groundFloorNeeded: person.groundFloorNeeded, accessibleRoomNeeded: person.accessibleRoomNeeded } : {}),
    };
  };
  const rooming: RoomingGroup[] = [];
  const units = [...state.unitRows].sort((a, b) => (a.unit.building.sortOrder - b.unit.building.sortOrder) || (a.unit.sortOrder - b.unit.sortOrder));
  for (const row of units) {
    const segments = state.segments.filter((segment) => segment.unitId === row.id);
    if (segments.length === 0) continue;
    const meta = state.meta.get(row.id)!;
    rooming.push({
      placeKey: `unit:${meta.key}`,
      building: meta.buildingName,
      place: meta.name,
      floor: meta.floor,
      capacity: row.capacityOverride ?? row.defaultCapacity,
      occupants: segments.map(occupantOf).sort((a, b) => a.name.localeCompare(b.name) || a.firstNight.localeCompare(b.firstNight)),
    });
  }
  for (const bucket of state.buckets) {
    const segments = state.segments.filter((segment) => segment.bucketId === bucket.id);
    if (segments.length === 0) continue;
    rooming.push({ placeKey: `bucket:${bucket.kind.toLowerCase()}`, building: "Housing arranged elsewhere", place: bucket.label, floor: null, capacity: null, occupants: segments.map(occupantOf).sort((a, b) => a.name.localeCompare(b.name)) });
  }
  const occupancy = occupancyByNight({ nights, units: [...state.units.values()], segments: state.segments });
  const occupied = occupancyOf(state.segments);
  const occupancyByUnit: OccupancyUnitRow[] = units
    .filter((row) => row.assignable && !row.retired)
    .map((row) => {
      const meta = state.meta.get(row.id)!;
      const unitState = state.units.get(row.id)!;
      return {
        unitId: row.id,
        building: meta.buildingName,
        name: meta.name,
        nights: nights.map((night) => {
          const entry = unitNight(unitState, night, occupied.get(row.id)?.get(night) ?? 0);
          return {
            night,
            status: entry.status,
            occupied: entry.occupied,
            capacity: entry.capacity,
            assignmentIds: state.segments.filter((segment) => segment.unitId === row.id && segment.firstNight <= night && night <= segment.lastNight).map((segment) => segment.id),
          };
        }),
      };
    });
  const visible = visibleExceptions(facts.exceptions, canSeeSensitive);
  const keyHandoff: KeyHandoffRow[] = rooming
    .filter((group) => group.placeKey.startsWith("unit:"))
    .map((group) => {
      const first = group.occupants.reduce((min, occupant) => (occupant.firstNight < min ? occupant.firstNight : min), group.occupants[0]!.firstNight);
      const last = group.occupants.reduce((max, occupant) => (occupant.lastNight > max ? occupant.lastNight : max), group.occupants[0]!.lastNight);
      const holder = group.occupants[0]!;
      return {
        building: group.building,
        place: group.place,
        placeKey: group.placeKey,
        people: group.occupants.reduce((total, occupant) => total + occupant.people, 0),
        arrival: first,
        departure: addDays(last, 1),
        holder: holder.name,
        registrationCodes: [...new Set(group.occupants.map((occupant) => occupant.registrationCode).filter(Boolean))].sort(),
      };
    });
  return {
    eventId,
    nights,
    canSeeSensitive,
    rooming,
    occupancy,
    occupancyByUnit,
    unassigned: visible.filter((row) => row.kind === "UNASSIGNED"),
    conflicts: visible.filter((row) => row.section === "CONFLICT" && row.kind !== "UNASSIGNED"),
    closeout: visible.filter((row) => row.section === "CLOSEOUT"),
    keyHandoff,
  };
}

// ---------------------------------------------------------------------------
// The attendee display (private registration page)
// ---------------------------------------------------------------------------

export type RegistrantAssignmentView = {
  /** Staff published assignments for this event. */
  published: boolean;
  instructions: string | null;
  stays: Array<{
    /** The attendee's own name: the page already shows it. */
    name: string;
    kind: "ROOM" | "ELSEWHERE";
    /** The building (or area) and room, or the housing choice's label. */
    building: string | null;
    room: string;
    firstNight: string;
    lastNight: string;
    /** First names only, and only when staff turned roommates on. Other registrations' adults; never a contact detail. */
    roommates: string[];
    /** Others in the room (children, people whose age is not known, expected guests) who are not named. */
    otherGuests: number;
  }>;
};

export async function getRegistrantAssignmentView(input: { eventId: string; registrationId: string; now?: Date }, client: Client = getPrisma()): Promise<RegistrantAssignmentView> {
  // Loaded narrowly (one registration, its units, and only when roommates are on, the people in those units).
  const loaded = await loadRegistrantStays(client, input.eventId, input.registrationId);
  if (!loaded.published) return { published: false, instructions: null, stays: [] };
  // `outOfService` is for notice staleness only: a guest is never told a room is closed.
  return { published: true, instructions: loaded.instructions, stays: loaded.stays.map(({ outOfService: _outOfService, ...stay }) => { void _outOfService; return stay; }) };
}
