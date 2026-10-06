import { createHash } from "node:crypto";
import { nightsInclusive, unitNight } from "@/modules/lodging/domain";
import { firstNameOf, type PlanUnit, type Segment } from "@/modules/lodging/assignment-domain";

/**
 * What a registration is told about where it is staying (#200): the same facts the private page shows and a room notice
 * says, built from plain data so the staff screens (which hold every fact) and the private page (which loads only
 * what it needs) cannot disagree. Pure.
 *
 * A stay carries `outOfService` (the room is closed or held on one of its nights): it is never shown to the guest, but it
 * is part of the notice fingerprint, so a room that closes after a notice was written makes the notice obsolete.
 */

export type StayPerson = { occupantKey: string; name: string };

export type StayRoommate = {
  name: string;
  people: number;
  /** An attendee of an active registration whose age says adult. Only such a person is ever named. */
  nameable: boolean;
};

export type Stay = {
  name: string;
  kind: "ROOM" | "ELSEWHERE";
  building: string | null;
  room: string;
  firstNight: string;
  lastNight: string;
  roommates: string[];
  otherGuests: number;
  outOfService: boolean;
};

export function buildStays(input: {
  own: readonly StayPerson[];
  /** Current segments of the people in `own`, and of everyone else who shares one of their units. */
  segments: readonly Segment[];
  units: ReadonlyMap<string, { name: string; buildingName: string; state: PlanUnit }>;
  bucketLabels: ReadonlyMap<string, string>;
  /** Other people by occupant key (not needed when roommates are off). */
  others: ReadonlyMap<string, StayRoommate>;
  showRoommates: boolean;
}): Stay[] {
  const ownKeys = new Set(input.own.map((person) => person.occupantKey));
  const stays: Stay[] = [];
  for (const person of input.own) {
    for (const segment of input.segments.filter((candidate) => candidate.occupantKey === person.occupantKey)) {
      const unit = segment.unitId ? input.units.get(segment.unitId) : undefined;
      const roommates: string[] = [];
      let otherGuests = 0;
      if (unit && input.showRoommates) {
        for (const other of input.segments) {
          if (other.unitId !== segment.unitId || other.id === segment.id || ownKeys.has(other.occupantKey)) continue;
          if (other.firstNight > segment.lastNight || segment.firstNight > other.lastNight) continue;
          const roommate = input.others.get(other.occupantKey);
          if (roommate?.nameable) roommates.push(firstNameOf(roommate.name));
          else otherGuests += roommate?.people ?? other.people;
        }
      }
      const outOfService = unit
        ? nightsInclusive(segment.firstNight, segment.lastNight).some((night) => unitNight(unit.state, night).status !== "AVAILABLE")
        : false;
      stays.push({
        name: person.name,
        kind: unit ? "ROOM" : "ELSEWHERE",
        building: unit ? unit.buildingName : null,
        room: unit ? unit.name : (segment.bucketId ? input.bucketLabels.get(segment.bucketId) : undefined) ?? "Housing arranged elsewhere",
        firstNight: segment.firstNight,
        lastNight: segment.lastNight,
        roommates: [...new Set(roommates)].sort(),
        otherGuests,
        outOfService,
      });
    }
  }
  return stays.sort((a, b) => a.name.localeCompare(b.name) || a.firstNight.localeCompare(b.firstNight));
}

/** What a room notice would say right now. A notice is current only while this still matches what it was sent with. */
export function noticeContentHash(stays: readonly Stay[], instructions: string | null, published: boolean) {
  return createHash("sha256").update(JSON.stringify([published, instructions ?? "", stays])).digest("hex");
}
