import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => { throw new Error("not used"); } }));

import { demandExcluding, type Client } from "@/modules/lodging/preferences-service";
import { categoryFits, type CategoryCapacity } from "@/modules/lodging/preferences-domain";

const NIGHTS = ["2027-06-15", "2027-06-16"];
const capacity = (people: number): CategoryCapacity => ({ perNight: Object.fromEntries(NIGHTS.map((night) => [night, people])), unitsInService: 4, groundLevelUnits: 0, unitCapacity: 10 });
const day = (value: string) => new Date(`${value}T00:00:00Z`);

type Fixture = {
  requests?: Array<{ registrationId: string; category: string | null; partySize: number }>;
  placed?: Array<{ registrationId: string | null; people: number; category: string | null }>;
  entries?: Array<{ id?: string; registrationId: string; category: string; partySize: number; status: string; offerExpiresAt?: Date | null }>;
};

function client(fixture: Fixture) {
  return {
    eventLodgingRequest: {
      findMany: vi.fn(async () => (fixture.requests ?? []).map((request, index) => ({
        id: `request-${index}`, registrationId: request.registrationId, createdAt: new Date(),
        versions: [{ version: 1, category: request.category, firstNight: null, lastNight: null, partySize: request.partySize, groundFloorNeeded: false, accessibleRoomNeeded: false, privateRoomRequested: false, householdPreference: "TOGETHER", source: "STAFF", afterDeadline: false, createdAt: new Date() }],
      }))),
    },
    eventLodgingAssignment: {
      findMany: vi.fn(async () => (fixture.placed ?? []).map((row) => ({
        attendeeId: row.registrationId ? `attendee-of-${row.registrationId}` : null,
        people: row.people, firstNight: day(NIGHTS[0]!), lastNight: day(NIGHTS[1]!),
        eventUnit: { unit: { category: row.category } },
        attendee: row.registrationId ? { registrationId: row.registrationId } : null,
      }))),
    },
    eventLodgingWaitlistEntry: {
      findMany: vi.fn(async () => (fixture.entries ?? []).map((entry, index) => ({
        id: entry.id ?? `entry-${index}`, firstNight: null, lastNight: null, offerExpiresAt: entry.offerExpiresAt ?? null, ...entry,
      }))),
    },
  } as unknown as Client;
}

const demandFor = (fixture: Fixture, registrationId = "__none__", now = new Date("2027-05-20T12:00:00Z")) => demandExcluding(client(fixture), "event-1", NIGHTS, registrationId, { now });
const fits = (demand: Awaited<ReturnType<typeof demandExcluding>>, partySize: number, category = "DORM_ROOM") => categoryFits({ capacity: capacity(40), demand: demand.get(category as never), nights: NIGHTS, partySize }).fits;

describe("one counting rule for a category's free space (#200)", () => {
  it("scenario A: forty requests and nobody placed leave no place to offer", async () => {
    const requests = Array.from({ length: 40 }, (_, index) => ({ registrationId: `reg-${index}`, category: "DORM_ROOM", partySize: 1 }));
    const demand = await demandFor({ requests, entries: [{ registrationId: "waiter", category: "DORM_ROOM", partySize: 1, status: "JOINED" }] }, "waiter");
    expect(fits(demand, 1)).toBe(false);
  });

  it("scenario B: a placed expected group of ten leaves thirty for the registration form", async () => {
    const demand = await demandFor({ placed: [{ registrationId: null, people: 10, category: "DORM_ROOM" }] });
    expect(fits(demand, 30)).toBe(true);
    expect(fits(demand, 31)).toBe(false);
  });

  it("counts a placed person who has a request once, as the request, and one without a request as a placement", async () => {
    const backed = await demandFor({ requests: [{ registrationId: "reg-1", category: "DORM_ROOM", partySize: 1 }], placed: [{ registrationId: "reg-1", people: 1, category: "DORM_ROOM" }] });
    expect(backed.get("DORM_ROOM" as never)?.get(NIGHTS[0]!)).toBe(1);
    const unbacked = await demandFor({ placed: [{ registrationId: "reg-2", people: 1, category: "DORM_ROOM" }] });
    expect(unbacked.get("DORM_ROOM" as never)?.get(NIGHTS[0]!)).toBe(1);
    const noCategoryRequest = await demandFor({ requests: [{ registrationId: "reg-3", category: null, partySize: 2 }], placed: [{ registrationId: "reg-3", people: 1, category: "DORM_ROOM" }] });
    expect(noCategoryRequest.get("DORM_ROOM" as never)?.get(NIGHTS[0]!)).toBe(1);
  });

  it("counts a live offer and an accepted entry once, never an expired offer, and never twice when a request already counts it", async () => {
    const now = new Date("2027-05-20T12:00:00Z");
    const future = new Date("2027-05-21T12:00:00Z");
    const past = new Date("2027-05-19T12:00:00Z");
    const demand = await demandFor({
      entries: [
        { registrationId: "a", category: "DORM_ROOM", partySize: 2, status: "OFFERED", offerExpiresAt: future },
        { registrationId: "b", category: "DORM_ROOM", partySize: 3, status: "OFFERED", offerExpiresAt: past },
        { registrationId: "c", category: "DORM_ROOM", partySize: 4, status: "ACCEPTED" },
        { registrationId: "d", category: "DORM_ROOM", partySize: 5, status: "OFFERED", offerExpiresAt: future },
      ],
      requests: [{ registrationId: "d", category: "DORM_ROOM", partySize: 5 }],
    }, "__none__", now);
    // a (2) + c (4) as reservations, d (5) as its request; b's offer lapsed.
    expect(demand.get("DORM_ROOM" as never)?.get(NIGHTS[0]!)).toBe(2 + 4 + 5);
  });

  it("leaves the checked registration's own request, placements and entries out, and can leave a kind of registration out later", async () => {
    const fixture: Fixture = {
      requests: [{ registrationId: "me", category: "DORM_ROOM", partySize: 3 }, { registrationId: "other", category: "DORM_ROOM", partySize: 2 }],
      placed: [{ registrationId: "me2", people: 1, category: "DORM_ROOM" }],
      entries: [{ registrationId: "me", category: "DORM_ROOM", partySize: 7, status: "ACCEPTED" }],
    };
    const own = await demandFor({ ...fixture, placed: [{ registrationId: "me", people: 1, category: "DORM_ROOM" }] }, "me");
    expect(own.get("DORM_ROOM" as never)?.get(NIGHTS[0]!)).toBe(2);
    const filtered = await demandExcluding(client(fixture), "event-1", NIGHTS, "__none__", { countsTowardPublicCapacity: (id) => id !== "other" });
    expect(filtered.get("DORM_ROOM" as never)?.get(NIGHTS[0]!)).toBe(3 + 1);
  });
});
