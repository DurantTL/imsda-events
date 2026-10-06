import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => { throw new Error("not used"); } }));

import { addWaitingDemand, demandExcluding, demandFromGroups, loadDemandGroups, type Client } from "@/modules/lodging/preferences-service";
import { categoryFits, type CategoryCapacity } from "@/modules/lodging/preferences-domain";

const NIGHTS = ["2027-06-15", "2027-06-16", "2027-06-17"];
const capacity = (people: number): CategoryCapacity => ({ perNight: Object.fromEntries(NIGHTS.map((night) => [night, people])), unitsInService: 4, groundLevelUnits: 0, unitCapacity: 10 });
const day = (value: string) => new Date(`${value}T00:00:00Z`);

type Fixture = {
  requests?: Array<{ registrationId: string; category: string | null; partySize: number; firstNight?: string; lastNight?: string }>;
  placed?: Array<{ registrationId: string | null; people: number; category: string | null; firstNight?: string; lastNight?: string }>;
  entries?: Array<{ registrationId: string; category: string; partySize: number; status: string; offerExpiresAt?: Date | null; registrationStatus?: string; firstNight?: string; lastNight?: string }>;
};

function client(fixture: Fixture) {
  return {
    eventLodgingRequest: {
      findMany: vi.fn(async () => (fixture.requests ?? []).map((request, index) => ({
        id: `request-${index}`, registrationId: request.registrationId, createdAt: new Date(),
        versions: [{ version: 1, category: request.category, firstNight: request.firstNight ? day(request.firstNight) : null, lastNight: request.lastNight ? day(request.lastNight) : null, partySize: request.partySize, groundFloorNeeded: false, accessibleRoomNeeded: false, privateRoomRequested: false, householdPreference: "TOGETHER", source: "STAFF", afterDeadline: false, createdAt: new Date() }],
      }))),
    },
    eventLodgingAssignment: {
      findMany: vi.fn(async () => (fixture.placed ?? []).map((row, index) => ({
        id: `assignment-${index}`,
        people: row.people, firstNight: day(row.firstNight ?? NIGHTS[0]!), lastNight: day(row.lastNight ?? NIGHTS[2]!),
        eventUnit: { unit: { category: row.category } },
        attendee: row.registrationId ? { registrationId: row.registrationId } : null,
      }))),
    },
    eventLodgingWaitlistEntry: {
      // The query asks for active registrations only; the fake applies the same filter.
      findMany: vi.fn(async ({ where }: { where: { registration?: { status: { in: string[] } } } }) => (fixture.entries ?? [])
        .filter((entry) => !where.registration || where.registration.status.in.includes(entry.registrationStatus ?? "CONFIRMED"))
        .map((entry, index) => ({ id: `entry-${index}`, firstNight: entry.firstNight ? day(entry.firstNight) : null, lastNight: entry.lastNight ? day(entry.lastNight) : null, offerExpiresAt: entry.offerExpiresAt ?? null, ...entry }))),
    },
  } as unknown as Client;
}

const demandFor = (fixture: Fixture, registrationId = "__none__", now = new Date("2027-05-20T12:00:00Z")) => demandExcluding(client(fixture), "event-1", NIGHTS, registrationId, { now });
const at = (demand: Awaited<ReturnType<typeof demandExcluding>>, category: string, night = NIGHTS[0]!) => demand.get(category as never)?.get(night) ?? 0;
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

  it("counts a request, the same people placed in that category and an entry for them once", async () => {
    const demand = await demandFor({
      requests: [{ registrationId: "r", category: "DORM_ROOM", partySize: 2 }],
      placed: [{ registrationId: "r", people: 2, category: "DORM_ROOM" }],
      entries: [{ registrationId: "r", category: "DORM_ROOM", partySize: 2, status: "ACCEPTED" }],
    });
    expect(at(demand, "DORM_ROOM")).toBe(2);
  });

  it("still counts a cabin placement after a promotion from a dorm request that was not changed", async () => {
    const demand = await demandFor({
      requests: [{ registrationId: "r", category: "DORM_ROOM", partySize: 2 }],
      placed: [{ registrationId: "r", people: 2, category: "CABIN" }],
    });
    expect(at(demand, "CABIN")).toBe(2);
    expect(at(demand, "DORM_ROOM")).toBe(2); // conservative: both are held until staff update the request
  });

  it("counts a manual placement outside the request's category, and a request switched after placement", async () => {
    const manual = await demandFor({ requests: [{ registrationId: "r", category: "TENT", partySize: 1 }], placed: [{ registrationId: "r", people: 1, category: "CABIN" }] });
    expect(at(manual, "CABIN")).toBe(1);
    const switched = await demandFor({ requests: [{ registrationId: "r", category: "CABIN", partySize: 2 }], placed: [{ registrationId: "r", people: 2, category: "DORM_ROOM" }] });
    expect(at(switched, "DORM_ROOM")).toBe(2);
    expect(at(switched, "CABIN")).toBe(2);
  });

  it("counts people placed above the request's party and on nights outside its window", async () => {
    const above = await demandFor({ requests: [{ registrationId: "r", category: "DORM_ROOM", partySize: 1 }], placed: [{ registrationId: "r", people: 3, category: "DORM_ROOM" }] });
    expect(at(above, "DORM_ROOM")).toBe(3);
    const longer = await demandFor({
      requests: [{ registrationId: "r", category: "DORM_ROOM", partySize: 2, firstNight: NIGHTS[0], lastNight: NIGHTS[0] }],
      placed: [{ registrationId: "r", people: 2, category: "DORM_ROOM", firstNight: NIGHTS[0], lastNight: NIGHTS[1] }],
    });
    expect([at(longer, "DORM_ROOM", NIGHTS[0]), at(longer, "DORM_ROOM", NIGHTS[1]), at(longer, "DORM_ROOM", NIGHTS[2])]).toEqual([2, 2, 0]);
  });

  it("counts an entry larger than the request, and for more nights than it", async () => {
    const demand = await demandFor({
      requests: [{ registrationId: "r", category: "DORM_ROOM", partySize: 2, firstNight: NIGHTS[0], lastNight: NIGHTS[0] }],
      entries: [{ registrationId: "r", category: "DORM_ROOM", partySize: 5, status: "ACCEPTED" }],
    });
    expect([at(demand, "DORM_ROOM", NIGHTS[0]), at(demand, "DORM_ROOM", NIGHTS[1])]).toEqual([5, 5]);
  });

  it("counts live offers, never a lapsed one, and an accepted entry of a cancelled registration frees its places", async () => {
    const now = new Date("2027-05-20T12:00:00Z");
    const demand = await demandFor({
      entries: [
        { registrationId: "a", category: "DORM_ROOM", partySize: 2, status: "OFFERED", offerExpiresAt: new Date("2027-05-21T12:00:00Z") },
        { registrationId: "b", category: "DORM_ROOM", partySize: 3, status: "OFFERED", offerExpiresAt: new Date("2027-05-19T12:00:00Z") },
        { registrationId: "c", category: "DORM_ROOM", partySize: 4, status: "ACCEPTED" },
        { registrationId: "gone", category: "DORM_ROOM", partySize: 6, status: "ACCEPTED", registrationStatus: "CANCELLED" },
      ],
    }, "__none__", now);
    expect(at(demand, "DORM_ROOM")).toBe(2 + 4);
  });

  it("follows per-night capacity differences, such as a hold on one night", async () => {
    const held: CategoryCapacity = { ...capacity(40), perNight: { [NIGHTS[0]!]: 40, [NIGHTS[1]!]: 5, [NIGHTS[2]!]: 40 } };
    const demand = await demandFor({ requests: [{ registrationId: "r", category: "DORM_ROOM", partySize: 3 }] });
    expect(categoryFits({ capacity: held, demand: demand.get("DORM_ROOM" as never), nights: NIGHTS, partySize: 2 }).fits).toBe(true);
    expect(categoryFits({ capacity: held, demand: demand.get("DORM_ROOM" as never), nights: NIGHTS, partySize: 3 })).toMatchObject({ fits: false, firstFullNight: NIGHTS[1] });
    expect(categoryFits({ capacity: held, demand: demand.get("DORM_ROOM" as never), nights: [NIGHTS[0]!, NIGHTS[2]!], partySize: 37 }).fits).toBe(true);
  });

  it("adds an expected-guest group to a registration in the same category", async () => {
    const demand = await demandFor({ requests: [{ registrationId: "r", category: "DORM_ROOM", partySize: 2 }], placed: [{ registrationId: null, people: 10, category: "DORM_ROOM" }] });
    expect(at(demand, "DORM_ROOM")).toBe(12);
  });

  it("keeps a cancelled registration's request out but still counts its placement until staff release it", async () => {
    const demand = await demandFor({ placed: [{ registrationId: "gone", people: 2, category: "DORM_ROOM" }] });
    expect(at(demand, "DORM_ROOM")).toBe(2);
  });

  it("leaves the checked registration out, can leave a kind of registration out later, and a batch counts each offer against the next", async () => {
    const fixture: Fixture = {
      requests: [{ registrationId: "me", category: "DORM_ROOM", partySize: 3 }, { registrationId: "other", category: "DORM_ROOM", partySize: 2 }],
      placed: [{ registrationId: "me", people: 1, category: "DORM_ROOM" }, { registrationId: "me2", people: 1, category: "DORM_ROOM" }],
      entries: [{ registrationId: "me", category: "DORM_ROOM", partySize: 7, status: "ACCEPTED" }],
    };
    expect(at(await demandFor(fixture, "me"), "DORM_ROOM")).toBe(2 + 1);
    const filtered = await demandExcluding(client(fixture), "event-1", NIGHTS, "__none__", { countsTowardPublicCapacity: (id) => id !== "other" });
    expect(at(filtered, "DORM_ROOM")).toBe(7 + 1);
    const groups = await loadDemandGroups(client(fixture), "event-1", NIGHTS, { now: new Date("2027-05-20T12:00:00Z") });
    addWaitingDemand(groups, "newcomer", "DORM_ROOM" as never, NIGHTS, 4);
    expect(at(demandFromGroups(groups, "me"), "DORM_ROOM")).toBe(2 + 1 + 4);
  });
});
