import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getPrisma: vi.fn(), writeAuditLog: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));

import { ClassSelectionError, getClassSelectionWorkspace, setClassSelections } from "@/modules/honors/enrollment-repository";
import { locationChangeBlock, sessionVisibleAtLocation } from "@/modules/honors/locations";

const now = new Date("2026-10-15T15:00:00.000Z");
const event = {
  id: "event-1", isPublished: true, endsAt: new Date("2026-12-06T20:00:00.000Z"), timezone: "America/Chicago",
  registrationOpensOn: "2026-10-01", registrationClosesOn: "2026-11-30", waitlistEnabled: false,
};

/** Sessions at Camp Heritage, Des Moines, and one no site owns; each with one class, plus an all-sessions class. */
function offering(id: string, honorName: string, sessionId: string | null, locationId: string | null, locationName: string | null) {
  return {
    id, span: sessionId ? "SINGLE_SESSION" : "ALL_SESSIONS", sessionId, capacity: 10, minimumAge: null, perClubLimit: null,
    teacherName: "", location: "", isActive: true, honor: { name: honorName, code: id.toUpperCase() },
    session: sessionId ? { name: `Session ${sessionId}`, sortOrder: 0, locationId, location: locationName ? { name: locationName } : null } : null,
  };
}
const offerings = [
  offering("knots-hr", "Knots at Heritage", "s-hr", "loc-hr", "Camp Heritage 1"),
  offering("birds-dm", "Birds at Des Moines", "s-dm", "loc-dm", "Des Moines"),
  offering("camp-shared", "Camping (no site)", "s-shared", null, null),
  offering("all-sessions", "All-sessions class", null, null, null),
];
const sessions = [
  { id: "s-hr", name: "Sabbath Morning", locationId: "loc-hr", sortOrder: 0, createdAt: now },
  { id: "s-dm", name: "Sabbath Morning", locationId: "loc-dm", sortOrder: 0, createdAt: now },
  { id: "s-shared", name: "Sunday", locationId: null, sortOrder: 1, createdAt: now },
];

function database(options: { registrationLocation: { id: string; name: string } | null; eventHasLocations: boolean }) {
  const created: Array<{ offeringId: string }> = [];
  const db = {
    clubEventRegistration: {
      findUnique: vi.fn().mockResolvedValue({
        event,
        registration: {
          id: "registration-1", status: "SUBMITTED",
          locationId: options.registrationLocation?.id ?? null, location: options.registrationLocation,
          attendees: [{ id: "attendee-1", profileSnapshot: { firstName: "Alex", lastName: "Youth", ageOnEventDate: 12, temporaryAttendeeType: "YOUTH" } }],
        },
      }),
    },
    clubRosterMember: { findMany: vi.fn().mockResolvedValue([]) },
    eventLocation: { count: vi.fn().mockResolvedValue(options.eventHasLocations ? 2 : 0) },
    honorOffering: { findMany: vi.fn().mockResolvedValue(offerings) },
    honorSession: { findMany: vi.fn().mockResolvedValue(sessions) },
    honorEnrollment: {
      groupBy: vi.fn().mockResolvedValue([]),
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn(),
      createMany: vi.fn(async ({ data }: { data: Array<{ offeringId: string }> }) => { created.push(...data); return { count: data.length }; }),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(async (work: (client: unknown) => unknown) => work(db)),
  };
  mocks.getPrisma.mockReturnValue(db);
  return { db, created };
}

const actor = { accountId: "director-1" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.writeAuditLog.mockResolvedValue({});
});

describe("the director's class picker at a site (#589)", () => {
  it("shows only the registration's site, plus sessions and classes with no site", async () => {
    database({ registrationLocation: { id: "loc-dm", name: "Des Moines" }, eventHasLocations: true });
    const workspace = await getClassSelectionWorkspace("club-1", "event-1", now);
    expect(workspace.locationRequired).toBe(false);
    expect(workspace.location).toEqual({ id: "loc-dm", name: "Des Moines" });
    expect(workspace.sessions.map((session) => session.id)).toEqual(["s-dm", "s-shared"]);
    expect(workspace.offerings.map((row) => row.id)).toEqual(["birds-dm", "camp-shared", "all-sessions"]);
  });

  it("shows the other site to a club registered there", async () => {
    database({ registrationLocation: { id: "loc-hr", name: "Camp Heritage 1" }, eventHasLocations: true });
    const workspace = await getClassSelectionWorkspace("club-1", "event-1", now);
    expect(workspace.offerings.map((row) => row.id)).toEqual(["knots-hr", "camp-shared", "all-sessions"]);
  });

  it("says to choose a location first, and shows no classes, before a site is picked", async () => {
    database({ registrationLocation: null, eventHasLocations: true });
    const workspace = await getClassSelectionWorkspace("club-1", "event-1", now);
    expect(workspace).toMatchObject({ locationRequired: true, locationMessage: "Choose your location first.", sessions: [], offerings: [] });
  });

  it("works exactly as before for an event without locations", async () => {
    const { db } = database({ registrationLocation: null, eventHasLocations: false });
    // No locations means no session has a site.
    db.honorSession.findMany.mockResolvedValue(sessions.map((session) => ({ ...session, locationId: null })));
    db.honorOffering.findMany.mockResolvedValue([
      offering("knots", "Knots", "s-hr", null, null),
      offering("birds", "Birds", "s-dm", null, null),
      offering("all-sessions", "All-sessions class", null, null, null),
    ]);
    const workspace = await getClassSelectionWorkspace("club-1", "event-1", now);
    expect(workspace).toMatchObject({ locationRequired: false, locationMessage: null, location: null });
    expect(workspace.sessions).toHaveLength(3);
    expect(workspace.offerings.map((row) => row.id)).toEqual(["knots", "birds", "all-sessions"]);
    expect(sessionVisibleAtLocation(null, null)).toBe(true);
  });
});

describe("the server keeps a club to its own site's classes (#589)", () => {
  it("refuses a pick at another site and saves nothing", async () => {
    const { db, created } = database({ registrationLocation: { id: "loc-dm", name: "Des Moines" }, eventHasLocations: true });
    await expect(setClassSelections("club-1", "event-1", actor, { "attendee-1": ["knots-hr"] }, now))
      .rejects.toMatchObject({ code: "SELECTION_INVALID", message: expect.stringContaining("isn't offered at your location, Des Moines") });
    expect(created).toEqual([]);
    expect(db.honorEnrollment.createMany).not.toHaveBeenCalled();
  });

  it("refuses any pick before a site is chosen", async () => {
    const { created } = database({ registrationLocation: null, eventHasLocations: true });
    await expect(setClassSelections("club-1", "event-1", actor, { "attendee-1": ["camp-shared"] }, now))
      .rejects.toMatchObject({ code: "LOCATION_REQUIRED", message: "Choose your location first." });
    expect(created).toEqual([]);
  });

  it("accepts classes at the club's site and classes with no site", async () => {
    const { created } = database({ registrationLocation: { id: "loc-dm", name: "Des Moines" }, eventHasLocations: true });
    await setClassSelections("club-1", "event-1", actor, { "attendee-1": ["birds-dm", "camp-shared"] }, now);
    expect(created.map((row) => row.offeringId).sort()).toEqual(["birds-dm", "camp-shared"]);
  });

  it("uses a ClassSelectionError the routes already map", async () => {
    database({ registrationLocation: null, eventHasLocations: true });
    await expect(setClassSelections("club-1", "event-1", actor, { "attendee-1": [] }, now)).rejects.toBeInstanceOf(ClassSelectionError);
  });
});

describe("changing a club's location with class picks (#589)", () => {
  const client = (picks: number, locationName: string | null = "Camp Heritage 1") => ({
    honorEnrollment: { count: vi.fn().mockResolvedValue(picks) },
    eventLocation: { findUnique: vi.fn().mockResolvedValue(locationName ? { name: locationName } : null) },
  });

  it("refuses with the site's name when the club has class picks there, and removes nothing", async () => {
    const tx = client(3);
    const message = await locationChangeBlock(tx as never, "registration-1", "loc-hr");
    expect(message).toBe("Remove this club's class picks at Camp Heritage 1 before changing location.");
    expect(tx.honorEnrollment.count).toHaveBeenCalledWith({
      where: { registrationId: "registration-1", offering: { session: { locationId: "loc-hr" } } },
    });
    expect(tx).not.toHaveProperty("honorEnrollment.deleteMany");
  });

  it("allows the change when the club has no picks at the old site", async () => {
    expect(await locationChangeBlock(client(0) as never, "registration-1", "loc-hr")).toBeNull();
  });

  it("has nothing to guard when the registration has no site yet", async () => {
    const tx = client(5);
    expect(await locationChangeBlock(tx as never, "registration-1", null)).toBeNull();
    expect(tx.honorEnrollment.count).not.toHaveBeenCalled();
  });
});
