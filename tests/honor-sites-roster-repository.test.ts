import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getPrisma: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));

import { getHonorRosterData } from "@/modules/honors/roster-repository";

// Synthetic data only.
const at = new Date("2026-10-01T09:00:00Z");

function database() {
  const sessions = [
    { id: "s-dm", name: "Sabbath Morning", locationId: "loc-dm", sortOrder: 0, createdAt: at, location: { name: "Des Moines" } },
    { id: "s-shared", name: "Sunday", locationId: null, sortOrder: 1, createdAt: at, location: null },
  ];
  const offerings = [
    { id: "o-dm", span: "SINGLE_SESSION", sessionId: "s-dm", locationId: null, site: null, capacity: 5, teacherName: "", location: "", isActive: true, honor: { name: "Birds", code: "B" } },
    { id: "o-hr", span: "SINGLE_SESSION", sessionId: "s-hr", locationId: null, site: null, capacity: 5, teacherName: "", location: "", isActive: true, honor: { name: "Knots at Heritage", code: "K" } },
    { id: "o-all", span: "ALL_SESSIONS", sessionId: null, locationId: null, site: null, capacity: 5, teacherName: "", location: "", isActive: true, honor: { name: "Camping", code: "C" } },
    { id: "o-all-dm", span: "ALL_SESSIONS", sessionId: null, locationId: "loc-dm", site: { name: "Des Moines" }, capacity: 5, teacherName: "", location: "", isActive: true, honor: { name: "Fire", code: "F" } },
    { id: "o-all-hr", span: "ALL_SESSIONS", sessionId: null, locationId: "loc-hr", site: { name: "Camp Heritage 1" }, capacity: 5, teacherName: "", location: "", isActive: true, honor: { name: "Stars", code: "S" } },
  ];
  const db = {
    event: { findUnique: vi.fn().mockResolvedValue({ id: "e1", name: "Honors", startsAt: at, endsAt: at, timezone: "America/Chicago", location: null }) },
    honorSession: { findMany: vi.fn().mockResolvedValue(sessions) },
    honorOffering: { findMany: vi.fn().mockResolvedValue(offerings) },
    clubEventRegistration: {
      findMany: vi.fn().mockResolvedValue([{
        organizationId: "club-1", organization: { name: "Iowa Club" },
        registration: {
          locationId: "loc-dm", location: { name: "Des Moines" }, publicFormSubmission: null,
          attendees: [{ id: "a1", profileSnapshot: { firstName: "Alex", lastName: "Youth", temporaryAttendeeType: "YOUTH" }, checkIns: [] }],
        },
      }]),
    },
    clubRosterMember: { findMany: vi.fn().mockResolvedValue([]) },
    honorEnrollment: { findMany: vi.fn().mockResolvedValue([{ offeringId: "o-dm", registrationAttendeeId: "a1", consumesSeat: true }]) },
    eventLocation: {
      findMany: vi.fn().mockResolvedValue([{ id: "loc-dm", name: "Des Moines", sortOrder: 0 }, { id: "loc-hr", name: "Camp Heritage 1", sortOrder: 1 }]),
    },
  };
  mocks.getPrisma.mockReturnValue(db);
  return db;
}

beforeEach(() => vi.clearAllMocks());

describe("honors rosters filtered by site (#589)", () => {
  it("asks only for the site's registrations and sessions (plus sessions with no site)", async () => {
    const db = database();
    await getHonorRosterData("e1", { includeDietary: false, locationId: "loc-dm" });
    expect(db.honorSession.findMany.mock.calls[0][0].where).toEqual({
      eventId: "e1", OR: [{ locationId: "loc-dm" }, { locationId: null }],
    });
    expect(db.clubEventRegistration.findMany.mock.calls[0][0].where.registration).toEqual({
      status: { in: ["SUBMITTED", "CONFIRMED"] }, locationId: "loc-dm",
    });
  });

  it("asks for everything with no site, and reports the event's sites", async () => {
    const db = database();
    const data = (await getHonorRosterData("e1", { includeDietary: false }))!;
    expect(data.offerings.map((offering) => offering.id)).toEqual(["o-dm", "o-all", "o-all-dm", "o-all-hr"]);
    expect(db.honorSession.findMany.mock.calls[0][0].where).toEqual({ eventId: "e1" });
    expect(db.clubEventRegistration.findMany.mock.calls[0][0].where.registration).toEqual({ status: { in: ["SUBMITTED", "CONFIRMED"] } });
    expect(data.hasLocations).toBe(true);
    expect(data.locations.map((location) => location.name)).toEqual(["Des Moines", "Camp Heritage 1"]);
  });

  it("names the site on classes, people, and clubs, and drops classes of sessions outside the filter", async () => {
    database();
    const data = (await getHonorRosterData("e1", { includeDietary: false, locationId: "loc-dm" }))!;
    // Another site's single-session and all-sessions classes drop out; classes with no site stay.
    expect(data.offerings.map((offering) => [offering.id, offering.siteName])).toEqual([["o-dm", "Des Moines"], ["o-all", null], ["o-all-dm", "Des Moines"]]);
    expect(data.attendees[0]).toMatchObject({ locationId: "loc-dm", locationName: "Des Moines" });
    expect(data.clubs).toEqual([{ id: "club-1", name: "Iowa Club", siteName: "Des Moines" }]);
  });
});
