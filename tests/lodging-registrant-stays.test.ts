import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { loadRegistrantStays } from "@/modules/lodging/registrant-stays";
import type { Client } from "@/modules/lodging/preferences-service";

const day = (value: string) => new Date(`${value}T00:00:00Z`);

type Occupant = { id: string; registrationId: string; first: string; last: string; age: number | null; email: string; phone: string; status?: string };

const occupants: Occupant[] = [
  { id: "att-own", registrationId: "reg-own", first: "Olive", last: "Ownerson", age: 41, email: "olive@lodging.example.test", phone: "555-0100" },
  { id: "att-adult", registrationId: "reg-other", first: "Avery", last: "Adultsurname", age: 35, email: "avery@lodging.example.test", phone: "555-0101" },
  { id: "att-minor", registrationId: "reg-other", first: "Minnie", last: "Minorsurname", age: 9, email: "minnie@lodging.example.test", phone: "555-0102" },
  { id: "att-unknown", registrationId: "reg-third", first: "Una", last: "Unknownsurname", age: null, email: "una@lodging.example.test", phone: "555-0103" },
  { id: "att-cancelled", registrationId: "reg-gone", first: "Cleo", last: "Cancelledsurname", age: 50, email: "cleo@lodging.example.test", phone: "555-0104", status: "CANCELLED" },
];

function assignment(id: string, attendeeId: string | null, placeholderId: string | null, people = 1) {
  return { id, eventId: "event-1", eventLodgingUnitId: "unit-1", bucketId: null, attendeeId, placeholderId, people, firstNight: day("2027-06-15"), lastNight: day("2027-06-18"), cancelledAt: null };
}

function fakeClient(options: { showRoommates: boolean; published?: boolean }) {
  const queried: { attendeeIds: string[][] } = { attendeeIds: [] };
  const own = [assignment("a-own", "att-own", null)];
  const co = [assignment("a-adult", "att-adult", null), assignment("a-minor", "att-minor", null), assignment("a-unknown", "att-unknown", null), assignment("a-cancelled", "att-cancelled", null), assignment("a-ghost", null, "ph-1", 3)];
  const client = {
    eventLodging: {
      findUnique: vi.fn(async () => ({ showAssignmentsToAttendees: options.published ?? true, showRoommateFirstNames: options.showRoommates, attendeeInstructions: "Check in at the office.", event: { startsAt: day("2027-06-15"), timezone: "America/Chicago" } })),
    },
    registration: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => (where.id === "reg-own"
        ? { attendees: [{ id: "att-own", profileSnapshot: { firstName: "Olive", lastName: "Ownerson" }, person: { firstName: "Olive", lastName: "Ownerson" } }] }
        : null)),
    },
    eventLodgingAssignment: {
      findMany: vi.fn(async ({ where }: { where: { attendeeId?: { in?: string[] } } }) => {
        if (where.attendeeId?.in) { queried.attendeeIds.push(where.attendeeId.in); return own; }
        return co;
      }),
    },
    eventLodgingUnit: {
      findMany: vi.fn(async () => [{
        id: "unit-1", assignable: true, retired: false, defaultCapacity: 8, capacityOverride: null, unavailable: false, holds: [],
        unit: { name: "224", specialUse: null, activeFrom: null, activeUntil: null, building: { name: "Girls Dorm" } },
      }]),
    },
    eventLodgingBucket: { findMany: vi.fn(async () => []) },
    registrationAttendee: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => occupants.filter((entry) => where.id.in.includes(entry.id)).map((entry) => ({
        id: entry.id, profileSnapshot: { firstName: entry.first, lastName: entry.last },
        formResponses: entry.age === null ? {} : { attendee_age: entry.age },
        person: { firstName: entry.first, lastName: entry.last },
        registration: { status: entry.status ?? "CONFIRMED" },
      }))),
    },
  };
  return { client: client as unknown as Client, queried };
}

describe("what the private registration page loads and shows (#200)", () => {
  it("names only adults of other active registrations, by first name, and never leaks a surname, contact detail or code", async () => {
    const { client } = fakeClient({ showRoommates: true });
    const result = await loadRegistrantStays(client, "event-1", "reg-own");
    expect(result.stays).toHaveLength(1);
    const stay = result.stays[0]!;
    expect(stay.roommates).toEqual(["Avery"]);
    // Counted, never named: a child, an unknown age, a cancelled registration's adult and an expected guest group.
    expect(stay.otherGuests).toBe(1 + 1 + 1 + 3);
    const shown = JSON.stringify(result);
    for (const occupant of occupants.filter((entry) => entry.id !== "att-own")) {
      expect(shown).not.toContain(occupant.last);
      expect(shown).not.toContain(occupant.email);
      expect(shown).not.toContain(occupant.phone);
      expect(shown).not.toContain(occupant.registrationId);
    }
    expect(shown).not.toContain("Minnie");
    expect(shown).not.toContain("Una");
    expect(shown).not.toContain("Cleo");
    expect(shown).not.toMatch(/@|555-/);
  });

  it("names nobody and does not even load other people when roommates are off", async () => {
    const { client } = fakeClient({ showRoommates: false });
    const result = await loadRegistrantStays(client, "event-1", "reg-own");
    expect(result.stays[0]!.roommates).toEqual([]);
    expect(result.stays[0]!.otherGuests).toBe(0);
    expect((client as unknown as { registrationAttendee: { findMany: ReturnType<typeof vi.fn> } }).registrationAttendee.findMany).not.toHaveBeenCalled();
  });

  it("loads only the registration's own assignments by attendee, and nothing at all until staff publish", async () => {
    const { client, queried } = fakeClient({ showRoommates: true });
    await loadRegistrantStays(client, "event-1", "reg-own");
    expect(queried.attendeeIds).toEqual([["att-own"]]);
    const hidden = fakeClient({ showRoommates: true, published: false });
    const none = await loadRegistrantStays(hidden.client, "event-1", "reg-own");
    expect(none).toMatchObject({ published: false, stays: [] });
    expect((hidden.client as unknown as { registration: { findFirst: ReturnType<typeof vi.fn> } }).registration.findFirst).not.toHaveBeenCalled();
  });

  it("shows another registration nothing of this one", async () => {
    const { client } = fakeClient({ showRoommates: true });
    const result = await loadRegistrantStays(client, "event-1", "reg-someone-else");
    expect(result).toMatchObject({ active: false, stays: [] });
    expect(JSON.stringify(result)).not.toContain("Olive");
  });
});
