import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ getPrisma: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@/modules/registrations/lifecycle-repository", () => ({ promoteWaitlistAfterSeatsFreed: vi.fn() }));

import { checkLocationSeats, admitToLocation } from "@/modules/event-locations/admission";
import { activeCoordinatorAccountIds } from "@/modules/event-locations/coordinators";
import { coordinatorGrantActive } from "@/modules/event-locations/domain";
import { createEventLocation, listActiveAreaCoordinators, locationCoordinatorActive, updateEventLocation } from "@/modules/event-locations/repository";
import { listWaitingClubsAtLocations, listWaitingClubsForCoordinator, locationWaitlistPlace, recordLocationWaitlistChange } from "@/modules/event-locations/waitlist";
import { ZodError } from "zod";

/**
 * Location waitlists and the Area Coordinator of a location (#599), below the
 * routes: admission that waitlists instead of refusing, the place in line at a
 * location, the coordinator rules, and what gets recorded. Synthetic data only.
 */

const eventRow = {
  startsAt: new Date("2026-12-05T15:00:00Z"), endsAt: new Date("2026-12-06T22:00:00Z"), timezone: "America/Chicago",
  registrationOpensOn: null, registrationClosesOn: null, isPublished: true, lastDay: null, waitlistEnabled: true,
};

function admissionTx(options: { capacity: number | null; occupied: number; isActive?: boolean }) {
  const row = {
    id: "loc-1", eventId: "event-1", name: "Camp Heritage", address: null, firstDay: null, lastDay: null,
    capacity: options.capacity, registrationClosesOn: null, isActive: options.isActive ?? true,
  };
  return {
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    $queryRaw: vi.fn().mockResolvedValue([row]),
    eventLocation: { count: vi.fn().mockResolvedValue(1), findFirst: vi.fn().mockResolvedValue(row) },
    registrationAttendee: { count: vi.fn().mockResolvedValue(options.occupied) },
  };
}
const seatCheck = (overrides: Record<string, unknown> = {}) => ({
  eventId: "event-1", locationId: "loc-1", requestedSeats: 2, requirePick: true, ...overrides,
});

describe("admission to a full location (#599)", () => {
  it("still refuses a full location with LOCATION_FULL by default", async () => {
    const tx = admissionTx({ capacity: 3, occupied: 2 });
    await expect(checkLocationSeats(tx as never, seatCheck())).rejects.toMatchObject({ code: "LOCATION_FULL", message: "Only 1 spot remains at Camp Heritage." });
  });

  it("returns the locked location marked waitlisted, instead of refusing, when the event's waitlist is on", async () => {
    const tx = admissionTx({ capacity: 3, occupied: 2 });
    const location = await checkLocationSeats(tx as never, seatCheck({ waitlistIfFull: true }));
    expect(location).toMatchObject({ id: "loc-1", name: "Camp Heritage", waitlisted: true });
    // The row lock is still taken, so the caller's place in line is decided under it.
    expect(String(tx.$queryRaw.mock.calls[0]![0].join(" "))).toContain("FOR UPDATE");
  });

  it("does not waitlist a request that fits", async () => {
    const tx = admissionTx({ capacity: 4, occupied: 2 });
    await expect(checkLocationSeats(tx as never, seatCheck({ waitlistIfFull: true }))).resolves.toMatchObject({ waitlisted: false });
  });

  it("counts an unlimited location as never full", async () => {
    const tx = admissionTx({ capacity: null, occupied: 500 });
    await expect(checkLocationSeats(tx as never, seatCheck({ waitlistIfFull: true }))).resolves.toMatchObject({ waitlisted: false });
  });

  it("does not turn other refusals into a waitlist: an inactive or unknown location is still refused", async () => {
    await expect(checkLocationSeats(admissionTx({ capacity: 3, occupied: 3, isActive: false }) as never, seatCheck({ waitlistIfFull: true })))
      .rejects.toMatchObject({ code: "LOCATION_INVALID" });
    const unknown = admissionTx({ capacity: 3, occupied: 0 });
    unknown.$queryRaw.mockResolvedValue([]);
    await expect(checkLocationSeats(unknown as never, seatCheck({ waitlistIfFull: true }))).rejects.toMatchObject({ code: "LOCATION_INVALID" });
  });

  it("reports the closed location before the full one, waitlist or not", async () => {
    const tx = admissionTx({ capacity: 1, occupied: 1 });
    await expect(checkLocationSeats(tx as never, seatCheck({ waitlistIfFull: true }), () => { throw new Error("closed"); })).rejects.toThrow("closed");
    expect(tx.registrationAttendee.count).not.toHaveBeenCalled();
  });

  it("carries the decision through the admission with the location's own lifecycle", async () => {
    const tx = admissionTx({ capacity: 2, occupied: 2 });
    const admission = await admitToLocation(tx as never, { ...seatCheck({ waitlistIfFull: true }), event: eventRow });
    expect(admission).toMatchObject({ locationId: "loc-1", waitlisted: true });
    const noLocation = await admitToLocation(admissionTx({ capacity: 2, occupied: 2 }) as never, { ...seatCheck({ locationId: null, requirePick: false }), event: eventRow });
    expect(noLocation).toMatchObject({ locationId: null, location: null, waitlisted: false });
  });
});

describe("a club's place in line at its location", () => {
  it("counts the waiting clubs at that location at or ahead of it, whatever the event-wide positions are", async () => {
    const tx = {
      registrationWaitlistEntry: {
        findUnique: vi.fn().mockResolvedValue({ position: 11, status: "WAITING" }),
        count: vi.fn().mockResolvedValue(3),
      },
    };
    await expect(locationWaitlistPlace(tx as never, "registration-1", "loc-1")).resolves.toBe(3);
    expect(tx.registrationWaitlistEntry.count).toHaveBeenCalledWith({ where: { status: "WAITING", position: { lte: 11 }, registration: { locationId: "loc-1" } } });
  });

  it("has none without a location, without touching the database, or when the club is not waiting", async () => {
    const tx = { registrationWaitlistEntry: { findUnique: vi.fn(), count: vi.fn() } };
    await expect(locationWaitlistPlace(tx as never, "registration-1", null)).resolves.toBeNull();
    expect(tx.registrationWaitlistEntry.findUnique).not.toHaveBeenCalled();
    tx.registrationWaitlistEntry.findUnique.mockResolvedValue({ position: 2, status: "PROMOTED" });
    await expect(locationWaitlistPlace(tx as never, "registration-1", "loc-1")).resolves.toBeNull();
    tx.registrationWaitlistEntry.findUnique.mockResolvedValue(null);
    await expect(locationWaitlistPlace(tx as never, "registration-1", "loc-1")).resolves.toBeNull();
    expect(tx.registrationWaitlistEntry.count).not.toHaveBeenCalled();
  });
});

describe("recording a waitlist change", () => {
  const registrationRow = {
    eventId: "event-1", locationId: "loc-1", confirmationCode: "REG-ONE", location: { name: "Camp Heritage" },
    _count: { attendees: 12 }, clubRegistration: { organization: { name: "River City Pathfinders" } },
  };

  it("snapshots the club, the location, the people and the place, so the digest reads as things were", async () => {
    const tx = { registration: { findUnique: vi.fn().mockResolvedValue(registrationRow) }, locationWaitlistChange: { create: vi.fn().mockResolvedValue({ id: "change-1" }) } };
    await recordLocationWaitlistChange(tx as never, { registrationId: "registration-1", locationId: "loc-1", kind: "JOINED", place: 2 });
    expect(tx.locationWaitlistChange.create).toHaveBeenCalledWith({
      data: {
        eventId: "event-1", locationId: "loc-1", registrationId: "registration-1", kind: "JOINED",
        clubName: "River City Pathfinders", locationName: "Camp Heritage", attendeeCount: 12, place: 2,
      },
      select: { id: true },
    });
  });

  it("names a registration that is not a club by its confirmation code, and can carry the time of the change", async () => {
    const at = new Date("2026-10-05T15:00:00Z");
    const tx = { registration: { findUnique: vi.fn().mockResolvedValue({ ...registrationRow, clubRegistration: null }) }, locationWaitlistChange: { create: vi.fn().mockResolvedValue({}) } };
    await recordLocationWaitlistChange(tx as never, { registrationId: "registration-1", locationId: "loc-1", kind: "PROMOTED", place: null, now: at });
    expect(tx.locationWaitlistChange.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ clubName: "Registration REG-ONE", occurredAt: at, place: null }),
    }));
  });

  it("records nothing for a registration without a location", async () => {
    const tx = { registration: { findUnique: vi.fn() }, locationWaitlistChange: { create: vi.fn() } };
    expect(await recordLocationWaitlistChange(tx as never, { registrationId: "registration-1", locationId: null, kind: "JOINED", place: 1 })).toBeNull();
    expect(tx.registration.findUnique).not.toHaveBeenCalled();
    expect(tx.locationWaitlistChange.create).not.toHaveBeenCalled();
    tx.registration.findUnique.mockResolvedValue({ ...registrationRow, locationId: null, location: null });
    expect(await recordLocationWaitlistChange(tx as never, { registrationId: "registration-1", locationId: "loc-1", kind: "JOINED", place: 1 })).toBeNull();
    expect(tx.locationWaitlistChange.create).not.toHaveBeenCalled();
  });
});

describe("waiting clubs at locations", () => {
  const entry = (registrationId: string, locationId: string, position: number, club: string) => ({
    position, joinedAt: new Date("2026-10-01T15:00:00Z"), attendeeCount: 3,
    registration: {
      id: registrationId, eventId: "event-1", locationId, confirmationCode: `REG-${registrationId}`, event: { name: "Honors Weekend" },
      location: { name: locationId === "loc-1" ? "Camp Heritage" : "Des Moines" }, clubRegistration: { organization: { name: club } },
    },
  });

  it("numbers each location's clubs from 1 in their own order, though event-wide positions interleave", async () => {
    const client = { registrationWaitlistEntry: { findMany: vi.fn().mockResolvedValue([
      entry("r1", "loc-1", 3, "First Club"), entry("r2", "loc-2", 4, "Other Club"), entry("r3", "loc-1", 9, "Second Club"),
    ]) } };
    const rows = await listWaitingClubsAtLocations(client as never, ["loc-1", "loc-2"]);
    expect(rows.map((row) => [row.locationName, row.clubName, row.place])).toEqual([
      ["Camp Heritage", "First Club", 1], ["Des Moines", "Other Club", 1], ["Camp Heritage", "Second Club", 2],
    ]);
  });

  it("asks for nothing when there are no locations", async () => {
    const client = { registrationWaitlistEntry: { findMany: vi.fn() } };
    expect(await listWaitingClubsAtLocations(client as never, [])).toEqual([]);
    expect(client.registrationWaitlistEntry.findMany).not.toHaveBeenCalled();
  });

  it("lists a coordinator's own locations, and only while their grant is active", async () => {
    const client = {
      eventLocation: { findMany: vi.fn().mockResolvedValue([{ id: "loc-1", name: "Camp Heritage", eventId: "event-1", event: { name: "Honors Weekend" } }]) },
      registrationWaitlistEntry: { findMany: vi.fn().mockResolvedValue([entry("r1", "loc-1", 3, "First Club")]) },
    };
    const now = new Date("2026-10-05T15:00:00Z");
    const result = await listWaitingClubsForCoordinator(client as never, "account-1", now);
    expect(result).toEqual([expect.objectContaining({ locationName: "Camp Heritage", eventName: "Honors Weekend", clubs: [expect.objectContaining({ clubName: "First Club", place: 1, attendeeCount: 3 })] })]);
    expect(client.eventLocation.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        coordinatorAccountId: "account-1",
        coordinator: { disabledAt: null, areaCoordinatorGrant: { is: { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } } },
      },
    }));
  });

  it("lists a location with no clubs waiting as an empty location", async () => {
    const client = {
      eventLocation: { findMany: vi.fn().mockResolvedValue([{ id: "loc-1", name: "Camp Heritage", eventId: "event-1", event: { name: "Honors Weekend" } }]) },
      registrationWaitlistEntry: { findMany: vi.fn().mockResolvedValue([]) },
    };
    expect(await listWaitingClubsForCoordinator(client as never, "account-1")).toEqual([expect.objectContaining({ locationId: "loc-1", clubs: [] })]);
  });
});

describe("who counts as an active Area Coordinator", () => {
  const now = new Date("2026-10-05T15:00:00Z");
  it("needs a grant that is not revoked and not expired", () => {
    expect(coordinatorGrantActive({ revokedAt: null, expiresAt: null }, now)).toBe(true);
    expect(coordinatorGrantActive({ revokedAt: null, expiresAt: new Date("2026-10-06T00:00:00Z") }, now)).toBe(true);
    expect(coordinatorGrantActive({ revokedAt: new Date("2026-10-01T00:00:00Z"), expiresAt: null }, now)).toBe(false);
    expect(coordinatorGrantActive({ revokedAt: null, expiresAt: new Date("2026-10-04T00:00:00Z") }, now)).toBe(false);
    expect(coordinatorGrantActive(null, now)).toBe(false);
    expect(coordinatorGrantActive(undefined, now)).toBe(false);
  });

  it("also needs an enabled account, for the location's shown coordinator", () => {
    const grant = { revokedAt: null, expiresAt: null };
    const account = { id: "a", displayName: "Pat", email: "pat@example.test", disabledAt: null, areaCoordinatorGrant: grant };
    expect(locationCoordinatorActive(account, now)).toBe(true);
    expect(locationCoordinatorActive({ ...account, disabledAt: now }, now)).toBe(false);
    expect(locationCoordinatorActive({ ...account, areaCoordinatorGrant: { revokedAt: now, expiresAt: null } }, now)).toBe(false);
    expect(locationCoordinatorActive(null, now)).toBe(false);
  });

  it("filters accounts to the active coordinators, for cloning and templates", async () => {
    const db = { attendeeAccount: { findMany: vi.fn().mockResolvedValue([
      { id: "active", areaCoordinatorGrant: { revokedAt: null, expiresAt: null } },
      { id: "revoked", areaCoordinatorGrant: { revokedAt: now, expiresAt: null } },
      { id: "never", areaCoordinatorGrant: null },
    ]) } };
    const ids = await activeCoordinatorAccountIds(db as never, ["active", "revoked", "never", null, "active"], now);
    expect([...ids]).toEqual(["active"]);
    expect(db.attendeeAccount.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ["active", "revoked", "never"] }, disabledAt: null } }));
  });

  it("asks nothing when there is nobody to check", async () => {
    const db = { attendeeAccount: { findMany: vi.fn() } };
    expect((await activeCoordinatorAccountIds(db as never, [null, undefined])).size).toBe(0);
    expect(db.attendeeAccount.findMany).not.toHaveBeenCalled();
  });

  it("offers staff only enabled accounts holding an active grant, by name", async () => {
    const db = { areaCoordinatorGrant: { findMany: vi.fn().mockResolvedValue([
      { attendeeAccount: { id: "b", displayName: "Zed Coordinator", email: "zed@example.test" } },
      { attendeeAccount: { id: "a", displayName: "Ann Coordinator", email: "ann@example.test" } },
    ]) } };
    const list = await listActiveAreaCoordinators(new Date("2026-10-05T15:00:00Z"), db as never);
    expect(list.map((row) => row.name)).toEqual(["Ann Coordinator", "Zed Coordinator"]);
    expect(db.areaCoordinatorGrant.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date("2026-10-05T15:00:00Z") } }], attendeeAccount: { disabledAt: null } },
    }));
  });
});

describe("choosing a location's coordinator", () => {
  const locked = { id: "loc-1", eventId: "event-1", name: "Camp Heritage", address: null, firstDay: null, lastDay: null, capacity: 5, registrationClosesOn: null, isActive: true };
  const record = (overrides: Record<string, unknown> = {}) => ({
    ...locked, normalizedName: "camp heritage", sortOrder: 0, coordinatorAccountId: null, coordinator: null,
    createdAt: new Date("2026-10-01T00:00:00Z"), updatedAt: new Date("2026-10-01T00:00:00Z"), ...overrides,
  });

  function transaction(options: { account: unknown; current?: Record<string, unknown> }) {
    const tx = {
      $executeRawUnsafe: vi.fn().mockResolvedValue(0),
      $queryRaw: vi.fn().mockResolvedValue([{ ...locked, ...options.current }]),
      attendeeAccount: { findUnique: vi.fn().mockResolvedValue(options.account) },
      eventLocation: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ coordinatorAccountId: null }),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => record(data)),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => record(data)),
      },
      registration: { count: vi.fn().mockResolvedValue(0) },
      registrationAttendee: { count: vi.fn().mockResolvedValue(0) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    dependencies.getPrisma.mockReturnValue({ $transaction: vi.fn(async (work: (client: typeof tx) => unknown) => work(tx)) });
    return tx;
  }
  const activeAccount = { disabledAt: null, areaCoordinatorGrant: { revokedAt: null, expiresAt: null } };

  beforeEach(() => vi.clearAllMocks());

  it("saves an active Area Coordinator on a new location", async () => {
    const tx = transaction({ account: activeAccount });
    await createEventLocation("event-1", "user-1", { name: "Camp Heritage", coordinatorAccountId: "account-1" });
    expect(tx.eventLocation.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ coordinatorAccountId: "account-1" }) }));
  });

  it.each([
    ["no such account", null],
    ["a revoked grant", { disabledAt: null, areaCoordinatorGrant: { revokedAt: new Date("2026-10-01T00:00:00Z"), expiresAt: null } }],
    ["an expired grant", { disabledAt: null, areaCoordinatorGrant: { revokedAt: null, expiresAt: new Date("2020-01-01T00:00:00Z") } }],
    ["no grant", { disabledAt: null, areaCoordinatorGrant: null }],
    ["a disabled account", { disabledAt: new Date("2026-10-01T00:00:00Z"), areaCoordinatorGrant: { revokedAt: null, expiresAt: null } }],
  ])("refuses %s as a coordinator", async (_label, account) => {
    const tx = transaction({ account });
    await expect(createEventLocation("event-1", "user-1", { name: "Camp Heritage", coordinatorAccountId: "account-1" }))
      .rejects.toMatchObject({ code: "LOCATION_COORDINATOR_INVALID" });
    expect(tx.eventLocation.create).not.toHaveBeenCalled();
  });

  it("creates a location with no coordinator, checking nobody", async () => {
    const tx = transaction({ account: null });
    await createEventLocation("event-1", "user-1", { name: "Camp Heritage" });
    expect(tx.attendeeAccount.findUnique).not.toHaveBeenCalled();
    expect(tx.eventLocation.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ coordinatorAccountId: null }) }));
  });

  it("checks a new pick on an edit, saves it, and audits that the coordinator changed", async () => {
    const tx = transaction({ account: activeAccount });
    await updateEventLocation("event-1", "loc-1", "user-1", { coordinatorAccountId: "account-2" });
    expect(tx.attendeeAccount.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "account-2" } }));
    expect(tx.eventLocation.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ coordinatorAccountId: "account-2" }) }));
    expect(tx.auditLog.create.mock.calls[0]![0].data.metadata).toMatchObject({ coordinatorChanged: true });
  });

  it("lets staff clear the coordinator without any check", async () => {
    const tx = transaction({ account: null });
    tx.eventLocation.findUnique.mockResolvedValue({ coordinatorAccountId: "account-2" });
    await updateEventLocation("event-1", "loc-1", "user-1", { coordinatorAccountId: null });
    expect(tx.attendeeAccount.findUnique).not.toHaveBeenCalled();
    expect(tx.eventLocation.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ coordinatorAccountId: null }) }));
  });

  it("does not re-check, or refuse, a coordinator who has since been revoked and is left as is", async () => {
    const tx = transaction({ account: null });
    tx.eventLocation.findUnique.mockResolvedValue({ coordinatorAccountId: "account-old" });
    await updateEventLocation("event-1", "loc-1", "user-1", { coordinatorAccountId: "account-old" });
    expect(tx.attendeeAccount.findUnique).not.toHaveBeenCalled();
  });

  it("leaves the coordinator alone on an edit that does not mention one", async () => {
    const tx = transaction({ account: null });
    await updateEventLocation("event-1", "loc-1", "user-1", { address: "1 Synthetic Rd" });
    expect(tx.attendeeAccount.findUnique).not.toHaveBeenCalled();
    expect(tx.eventLocation.update.mock.calls[0]![0].data).not.toHaveProperty("coordinatorAccountId");
  });

  it("rejects a malformed coordinator id before touching the database", async () => {
    const tx = transaction({ account: activeAccount });
    await expect(createEventLocation("event-1", "user-1", { name: "Camp Heritage", coordinatorAccountId: "" })).rejects.toBeInstanceOf(ZodError);
    expect(tx.eventLocation.create).not.toHaveBeenCalled();
  });

  it("serializes whether the coordinator is still active, so a revoked one shows as no active coordinator", async () => {
    const tx = transaction({ account: activeAccount });
    tx.eventLocation.findMany.mockResolvedValue([
      record({ id: "loc-1", coordinatorAccountId: "a", coordinator: { id: "a", displayName: "Pat", email: "pat@example.test", disabledAt: null, areaCoordinatorGrant: { revokedAt: null, expiresAt: null } } }),
      record({ id: "loc-2", name: "Des Moines", coordinatorAccountId: "b", coordinator: { id: "b", displayName: "Lee", email: "lee@example.test", disabledAt: null, areaCoordinatorGrant: { revokedAt: new Date("2026-10-01T00:00:00Z"), expiresAt: null } } }),
      record({ id: "loc-3", name: "Kansas City" }),
    ]);
    const { listEventLocations } = await import("@/modules/event-locations/repository");
    const locations = await listEventLocations("event-1", {
      eventLocation: tx.eventLocation, registration: { findMany: vi.fn().mockResolvedValue([]) },
    } as never);
    expect(locations.map((location) => [location.name, location.coordinatorActive, location.coordinator?.name ?? null])).toEqual([
      ["Camp Heritage", true, "Pat"], ["Des Moines", false, "Lee"], ["Kansas City", false, null],
    ]);
  });
});
