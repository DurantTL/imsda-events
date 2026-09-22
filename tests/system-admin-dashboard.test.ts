import { describe, expect, it } from "vitest";
import {
  buildSystemAdminDashboard,
  type SystemAdminDashboardSource,
  type SystemAdminEventSource,
} from "@/modules/system-admin/dashboard";

const now = new Date("2026-07-27T18:00:00.000Z");

function event(
  overrides: Partial<SystemAdminEventSource> = {},
): SystemAdminEventSource {
  return {
    id: "event-one",
    slug: "event-one",
    name: "Event One",
    startsAt: new Date("2026-08-01T15:00:00.000Z"),
    endsAt: new Date("2026-08-03T15:00:00.000Z"),
    timezone: "America/Chicago",
    location: "Camp Heritage",
    capacity: 100,
    isPublished: true,
    registrationOpensOn: "2026-01-01",
    registrationClosesOn: "2026-07-31",
    waitlistEnabled: true,
    registrations: [],
    attendeeCount: 0,
    checkedInCount: 0,
    activeStaffCount: 2,
    publishedFormCount: 1,
    waitingCount: 0,
    importIssueCount: 0,
    importWarningCount: 0,
    deliveryIssueCount: 0,
    ...overrides,
  };
}

function source(
  overrides: Partial<SystemAdminDashboardSource> = {},
): SystemAdminDashboardSource {
  return {
    events: [],
    activeUserCount: 4,
    pendingUserCount: 1,
    systemAdminCount: 2,
    unresolvedAlertCount: 0,
    ...overrides,
  };
}

describe("system administrator dashboard", () => {
  it("summarizes active registrations, net balances, attendance, and exceptions", () => {
    const dashboard = buildSystemAdminDashboard(source({
      unresolvedAlertCount: 1,
      events: [event({
        attendeeCount: 5,
        checkedInCount: 2,
        waitingCount: 1,
        importIssueCount: 2,
        deliveryIssueCount: 1,
        registrations: [
          {
            status: "SUBMITTED",
            totalAmountCents: 20_000,
            payments: [{
              amountCents: 12_000,
              refunds: [{ amountCents: 2_000 }],
            }],
          },
          {
            status: "CONFIRMED",
            totalAmountCents: 5_000,
            payments: [{ amountCents: 5_000, refunds: [] }],
          },
          {
            status: "CANCELLED",
            totalAmountCents: 99_000,
            payments: [],
          },
        ],
      })],
    }), now);

    expect(dashboard.summary).toMatchObject({
      eventCount: 1,
      currentEventCount: 1,
      registrationCount: 2,
      attendeeCount: 5,
      checkedInCount: 2,
      ledgerBalanceCents: 10_000,
      operationalIssueCount: 4,
      unresolvedAlertCount: 1,
    });
    expect(dashboard.events[0]).toMatchObject({
      registrationPhase: "OPEN",
      timing: "UPCOMING",
      ledgerBalanceCents: 10_000,
      exceptionCount: 3,
    });
  });

  it("surfaces incomplete setup and sorts current events before past events", () => {
    const dashboard = buildSystemAdminDashboard(source({
      events: [
        event({
          id: "past",
          name: "Past",
          startsAt: new Date("2025-01-01T12:00:00.000Z"),
          endsAt: new Date("2025-01-02T12:00:00.000Z"),
        }),
        event({
          id: "draft",
          name: "Draft",
          isPublished: false,
          publishedFormCount: 0,
        }),
      ],
    }), now);

    expect(dashboard.events.map((entry) => entry.id)).toEqual(["draft", "past"]);
    expect(dashboard.events[0].setupWarnings.map((warning) => warning.label)).toEqual([
      "Event is not published",
      "No published registration form",
    ]);
    expect(dashboard.events[0].registrationPhase).toBe("DRAFT");
  });

  it("links each warning and counts import warnings without calling them exceptions", () => {
    const dashboard = buildSystemAdminDashboard(source({
      events: [event({ importIssueCount: 1, importWarningCount: 9, deliveryIssueCount: 5 })],
    }), now);

    expect(dashboard.events[0].setupWarnings).toEqual([
      { kind: "IMPORT_ISSUES", label: "1 import run failed or rejected rows", exception: true },
      { kind: "IMPORT_WARNINGS", label: "9 import runs have warnings", exception: false },
      { kind: "DELIVERY_ISSUES", label: "5 emails failed or bounced", exception: true },
    ]);
    expect(dashboard.events[0].exceptionCount).toBe(6);
    expect(dashboard.summary.operationalIssueCount).toBe(6);
  });

  it("counts whole days until an upcoming event starts", () => {
    const dashboard = buildSystemAdminDashboard(source({
      events: [
        event({ id: "soon", startsAt: new Date("2026-07-29T15:00:00.000Z") }),
        event({
          id: "now",
          startsAt: new Date("2026-07-27T12:00:00.000Z"),
          endsAt: new Date("2026-07-28T12:00:00.000Z"),
        }),
      ],
    }), now);

    expect(Object.fromEntries(dashboard.events.map((entry) => [entry.id, entry.daysUntilStart])))
      .toEqual({ soon: 2, now: null });
  });
});
