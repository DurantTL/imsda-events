// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  orgFindMany: vi.fn(),
  reportFindMany: vi.fn(),
  locationFindMany: vi.fn(),
  eventFindMany: vi.fn(),
  registrationFindMany: vi.fn(),
  checkCounts: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    organization: { findMany: mocks.orgFindMany },
    clubMonthlyReport: { findMany: mocks.reportFindMany },
    eventLocation: { findMany: mocks.locationFindMany },
    event: { findMany: mocks.eventFindMany },
    registration: { findMany: mocks.registrationFindMany },
  }),
}));
vi.mock("@/modules/background-checks/repository", () => ({ clubsComplianceReminderCounts: mocks.checkCounts }));
vi.mock("@/lib/logger", () => ({ logError: mocks.logError }));

import { AreaCoordinatorCardSection } from "@/components/area-coordinator-card";
import {
  areaCardLinks,
  clubsNeedingAttention,
  registrationWindow,
} from "@/modules/club-reports/area-card-domain";
import { getAreaCoordinatorCard } from "@/modules/club-reports/area-card-repository";

// September and October reports are past due (Oct 10, Nov 10); November is not.
const now = new Date("2026-11-20T18:00:00Z");
const noChecks = { missing: 0, notInCompliance: 0, expiringSoon: 0 };
const filed = (organizationId: string, reportMonth: string) =>
  ({ organizationId, reportMonth, status: "SUBMITTED" as const, totalPoints: 10, onTimePoints: 10 });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.orgFindMany.mockResolvedValue([]);
  mocks.reportFindMany.mockResolvedValue([]);
  mocks.locationFindMany.mockResolvedValue([]);
  mocks.eventFindMany.mockResolvedValue([]);
  mocks.registrationFindMany.mockResolvedValue([]);
  mocks.checkCounts.mockResolvedValue(new Map());
});

describe("area coordinator card domain", () => {
  it("describes the registration window", () => {
    expect(registrationWindow("2026-12-01", null, now)).toEqual({ label: "Opens 2026-12-01", open: false });
    expect(registrationWindow(null, "2026-11-19", now)).toEqual({ label: "Closed", open: false });
    expect(registrationWindow(null, "2026-11-20", now)).toEqual({ label: "Open, closes 2026-11-20", open: true });
    expect(registrationWindow(null, null, now)).toEqual({ label: "Open", open: true });
  });

  it("counts clubs needing attention without naming them", () => {
    const counts = clubsNeedingAttention({
      clubIds: ["a", "b", "c", "d"],
      clubYear: "2026-27",
      now,
      reports: [
        // b, c and d filed both past-due months; a filed none.
        ...["b", "c", "d"].flatMap((id) => [filed(id, "2026-09"), filed(id, "2026-10")]),
      ],
      checks: new Map([
        ["b", { missing: 1, notInCompliance: 0, expiringSoon: 2 }],
        ["c", { missing: 0, notInCompliance: 1, expiringSoon: 0 }],
        ["d", noChecks],
      ]),
    });
    expect(counts).toEqual({ overdueReports: 1, backgroundCheckReminders: 2, either: 3 });
  });

  it("does not count a draft or a not-yet-due month as overdue", () => {
    const counts = clubsNeedingAttention({
      clubIds: ["a"],
      clubYear: "2026-27",
      now,
      reports: [
        { organizationId: "a", reportMonth: "2026-09", status: "DRAFT", totalPoints: 0, onTimePoints: 0 },
        filed("a", "2026-10"),
      ],
      checks: new Map(),
    });
    expect(counts.overdueReports).toBe(0);
  });

  it("links to the clubs overview", () => {
    expect(areaCardLinks().map((link) => link.href)).toContain("/account/area-clubs/overview");
  });
});

describe("getAreaCoordinatorCard", () => {
  const event = {
    id: "ev-1", name: "Synthetic Camporee", startsAt: new Date("2026-12-04T15:00:00Z"), endsAt: new Date("2026-12-06T15:00:00Z"),
    timezone: "America/Chicago", registrationOpensOn: null, registrationClosesOn: "2026-12-01",
  };

  it("scopes locations and events to published, upcoming club events and counts only active clubs", async () => {
    await getAreaCoordinatorCard({ id: "acct-1" }, now);
    expect(mocks.locationFindMany.mock.calls[0]![0].where).toEqual({
      coordinatorAccountId: "acct-1",
      isActive: true,
      event: { isPublished: true, audience: "CLUB", endsAt: { gte: now } },
    });
    expect(mocks.eventFindMany.mock.calls[0]![0].where).toEqual({ isPublished: true, audience: "CLUB", endsAt: { gte: now } });
    expect(mocks.eventFindMany.mock.calls[0]![0].select.clubRegistrations.where).toEqual({ organization: { isActive: true } });
    expect(mocks.orgFindMany.mock.calls[0]![0].where).toEqual({ type: "CLUB", isActive: true });
  });

  it("excludes locations of unpublished and GENERAL events", async () => {
    type Row = { id: string; name: string; registrationClosesOn: null; event: typeof event & { isPublished: boolean; audience: string } };
    const rows: Row[] = [
      { id: "loc-club", name: "Club site", registrationClosesOn: null, event: { ...event, isPublished: true, audience: "CLUB" } },
      { id: "loc-draft", name: "Unpublished site", registrationClosesOn: null, event: { ...event, isPublished: false, audience: "CLUB" } },
      { id: "loc-general", name: "General site", registrationClosesOn: null, event: { ...event, isPublished: true, audience: "GENERAL" } },
    ];
    // A stand-in database that honours the event part of the filter.
    mocks.locationFindMany.mockImplementation(async ({ where }: { where: { event: { isPublished: boolean; audience: string } } }) =>
      rows.filter((row) => row.event.isPublished === where.event.isPublished && row.event.audience === where.event.audience));
    const card = await getAreaCoordinatorCard({ id: "acct-1" }, now);
    expect(card.coordinatedLocations.map((location) => location.locationName)).toEqual(["Club site"]);
  });

  it("builds location and club event rows with registered headcounts only, at active clubs", async () => {
    mocks.locationFindMany.mockResolvedValue([{ id: "loc-1", name: "North site", registrationClosesOn: "2026-11-25", event }]);
    mocks.registrationFindMany.mockResolvedValue([
      { locationId: "loc-1", clubRegistration: { organizationId: "org-1" }, _count: { attendees: 12 } },
      { locationId: "loc-1", clubRegistration: { organizationId: "org-2" }, _count: { attendees: 8 } },
    ]);
    mocks.eventFindMany.mockResolvedValue([{
      ...event,
      clubRegistrations: [
        { organizationId: "org-1", registration: { status: "CONFIRMED", _count: { attendees: 10 } } },
        { organizationId: "org-2", registration: { status: "WAITLISTED", _count: { attendees: 5 } } },
        { organizationId: "org-3", registration: { status: "CANCELLED", _count: { attendees: 7 } } },
      ],
    }]);

    const card = await getAreaCoordinatorCard({ id: "acct-1" }, now);
    expect(card.coordinatedLocations).toEqual([expect.objectContaining({
      eventName: "Synthetic Camporee", locationName: "North site", clubsRegistered: 2, headcount: 20,
      registration: { label: "Open, closes 2026-11-25", open: true },
    })]);
    expect(card.clubEvents).toEqual([expect.objectContaining({
      clubsRegistered: 1, headcount: 10, registration: { label: "Open, closes 2026-12-01", open: true },
    })]);
    expect(mocks.registrationFindMany.mock.calls[0]![0].where).toMatchObject({
      locationId: { in: ["loc-1"] },
      clubRegistration: { organization: { isActive: true } },
    });
  });

  it("computes attention counts directly from reports and batched check counts, not the full summary", async () => {
    mocks.orgFindMany.mockResolvedValue([{ id: "a" }, { id: "b" }]);
    mocks.reportFindMany.mockResolvedValue([filed("b", "2026-09"), filed("b", "2026-10")]);
    mocks.checkCounts.mockResolvedValue(new Map([["b", { missing: 0, notInCompliance: 0, expiringSoon: 1 }]]));
    const card = await getAreaCoordinatorCard({ id: "acct-1" }, now);
    expect(card.needingAttention).toEqual({ overdueReports: 1, backgroundCheckReminders: 1, either: 2, clubYear: "2026-27" });
    expect(mocks.checkCounts).toHaveBeenCalledWith(["a", "b"], "2026-27");
  });
});

describe("AreaCoordinatorCardSection", () => {
  it("renders the card", async () => {
    const html = renderToStaticMarkup(await AreaCoordinatorCardSection({ account: { id: "acct-1" } }));
    expect(html).toContain("Clubs overview");
    expect(html).not.toContain("Summary unavailable");
  });

  it("degrades to a single line when the loader fails", async () => {
    mocks.locationFindMany.mockRejectedValue(new Error("database down"));
    const html = renderToStaticMarkup(await AreaCoordinatorCardSection({ account: { id: "acct-1" } }));
    expect(html).toContain("Summary unavailable right now.");
    expect(html).not.toContain("Clubs overview");
    expect(mocks.logError).toHaveBeenCalled();
  });
});
