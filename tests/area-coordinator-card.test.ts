import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  grantFindUnique: vi.fn(),
  locationFindMany: vi.fn(),
  eventFindMany: vi.fn(),
  registrationFindMany: vi.fn(),
  summary: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    areaCoordinatorGrant: { findUnique: mocks.grantFindUnique },
    eventLocation: { findMany: mocks.locationFindMany },
    event: { findMany: mocks.eventFindMany },
    registration: { findMany: mocks.registrationFindMany },
  }),
}));
vi.mock("@/modules/club-reports/area-summary-repository", () => ({ getAreaClubsSummary: mocks.summary }));
vi.mock("@/modules/organizations/area-coordinators", () => ({
  areaGrantActive: (grant: { revokedAt: Date | null; expiresAt: Date | null } | null, now: Date) =>
    Boolean(grant && !grant.revokedAt && (!grant.expiresAt || grant.expiresAt > now)),
}));

import {
  areaCardLinks,
  clubsNeedingAttention,
  registrationWindow,
} from "@/modules/club-reports/area-card-domain";
import { getAreaCoordinatorCard } from "@/modules/club-reports/area-card-repository";
import type { AreaClubSummary } from "@/modules/club-reports/area-summary-domain";

const now = new Date("2026-11-20T18:00:00Z");
const active = { revokedAt: null, expiresAt: null, attendeeAccount: { disabledAt: null } };

const club = (overrides: Partial<AreaClubSummary>): AreaClubSummary => ({
  id: "c",
  name: "Synthetic Club",
  church: "",
  directors: [],
  rosterSize: 0,
  registrationOnTime: true,
  backgroundChecks: { missing: 0, notInCompliance: 0, expiringSoon: 0 },
  months: [],
  submitted: 0,
  late: 0,
  drafts: 0,
  missing: 0,
  lastReportMonth: null,
  reportPoints: 0,
  totalPoints: 0,
  ...overrides,
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.locationFindMany.mockResolvedValue([]);
  mocks.eventFindMany.mockResolvedValue([]);
  mocks.registrationFindMany.mockResolvedValue([]);
  mocks.summary.mockResolvedValue([]);
});

describe("area coordinator card domain", () => {
  it("describes the registration window", () => {
    expect(registrationWindow("2026-12-01", null, now)).toEqual({ label: "Opens 2026-12-01", open: false });
    expect(registrationWindow(null, "2026-11-19", now)).toEqual({ label: "Closed", open: false });
    expect(registrationWindow(null, "2026-11-20", now)).toEqual({ label: "Open, closes 2026-11-20", open: true });
    expect(registrationWindow(null, null, now)).toEqual({ label: "Open", open: true });
  });

  it("counts clubs needing attention without naming them", () => {
    const counts = clubsNeedingAttention([
      club({ id: "a", missing: 1 }),
      club({ id: "b", backgroundChecks: { missing: 1, notInCompliance: 0, expiringSoon: 2 } }),
      club({ id: "c", missing: 2, backgroundChecks: { missing: 0, notInCompliance: 1, expiringSoon: 0 } }),
      club({ id: "d" }),
    ]);
    expect(counts).toEqual({ overdueReports: 2, backgroundCheckReminders: 2, either: 3 });
  });

  it("links to the clubs overview", () => {
    expect(areaCardLinks().map((link) => link.href)).toContain("/account/area-clubs/overview");
  });
});

describe("getAreaCoordinatorCard", () => {
  it.each([
    ["no grant", null],
    ["revoked", { ...active, revokedAt: new Date("2026-11-01T00:00:00Z") }],
    ["expired", { ...active, expiresAt: new Date("2026-11-01T00:00:00Z") }],
    ["disabled account", { ...active, attendeeAccount: { disabledAt: new Date("2026-11-01T00:00:00Z") } }],
  ])("returns nothing and reads no event data for %s", async (_label, grant) => {
    mocks.grantFindUnique.mockResolvedValue(grant);
    expect(await getAreaCoordinatorCard("acct-1", now)).toBeNull();
    expect(mocks.locationFindMany).not.toHaveBeenCalled();
    expect(mocks.eventFindMany).not.toHaveBeenCalled();
    expect(mocks.summary).not.toHaveBeenCalled();
  });

  it("scopes locations to the coordinator and upcoming, published club events", async () => {
    mocks.grantFindUnique.mockResolvedValue(active);
    await getAreaCoordinatorCard("acct-1", now);
    expect(mocks.locationFindMany.mock.calls[0]![0].where).toEqual({
      coordinatorAccountId: "acct-1",
      isActive: true,
      event: { endsAt: { gte: now } },
    });
    expect(mocks.eventFindMany.mock.calls[0]![0].where).toEqual({ isPublished: true, audience: "CLUB", endsAt: { gte: now } });
  });

  it("builds location and club event rows with registered headcounts only", async () => {
    mocks.grantFindUnique.mockResolvedValue(active);
    const event = {
      id: "ev-1", name: "Synthetic Camporee", startsAt: new Date("2026-12-04T15:00:00Z"), endsAt: new Date("2026-12-06T15:00:00Z"),
      timezone: "America/Chicago", registrationOpensOn: null, registrationClosesOn: "2026-12-01",
    };
    mocks.locationFindMany.mockResolvedValue([{ id: "loc-1", name: "North site", registrationClosesOn: "2026-11-25", event }]);
    mocks.registrationFindMany.mockResolvedValue([
      { locationId: "loc-1", _count: { attendees: 12 } },
      { locationId: "loc-1", _count: { attendees: 8 } },
    ]);
    mocks.eventFindMany.mockResolvedValue([{
      ...event,
      clubRegistrations: [
        { registration: { status: "CONFIRMED", _count: { attendees: 10 } } },
        { registration: { status: "WAITLISTED", _count: { attendees: 5 } } },
        { registration: { status: "CANCELLED", _count: { attendees: 7 } } },
      ],
    }]);
    mocks.summary.mockResolvedValue([club({ missing: 1 }), club({ id: "x" })]);

    const card = await getAreaCoordinatorCard("acct-1", now);
    expect(card?.coordinatedLocations).toEqual([expect.objectContaining({
      eventName: "Synthetic Camporee", locationName: "North site", clubsRegistered: 2, headcount: 20,
      registration: { label: "Open, closes 2026-11-25", open: true },
    })]);
    expect(card?.clubEvents).toEqual([expect.objectContaining({
      clubsRegistered: 1, headcount: 10, registration: { label: "Open, closes 2026-12-01", open: true },
    })]);
    expect(card?.needingAttention).toMatchObject({ overdueReports: 1, either: 1 });
    expect(mocks.registrationFindMany.mock.calls[0]![0].where.locationId).toEqual({ in: ["loc-1"] });
  });
});
