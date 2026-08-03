import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => {
  class MockAccessDeniedError extends Error {
    constructor(
      message: string,
      public readonly status = 403,
      public readonly code = "PERMISSION_DENIED",
    ) {
      super(message);
    }
  }
  return {
    AccessDeniedError: MockAccessDeniedError,
    requirePermission: vi.fn(),
    getCurrentSession: vi.fn(),
    findActiveMembership: vi.fn(),
    getOperationalReport: vi.fn(),
    listRegistrations: vi.fn(),
  };
});

vi.mock("@/modules/access/authorization", () => ({
  AccessDeniedError: dependencies.AccessDeniedError,
  requirePermission: dependencies.requirePermission,
}));
vi.mock("@/modules/access/current-session", () => ({
  getCurrentSession: dependencies.getCurrentSession,
}));
vi.mock("@/modules/events/repository", () => ({
  findActiveMembership: dependencies.findActiveMembership,
}));
vi.mock("@/modules/reporting/repository", () => ({
  getOperationalReport: dependencies.getOperationalReport,
}));
vi.mock("@/modules/registrations/repository", () => ({
  listRegistrations: dependencies.listRegistrations,
}));

import { GET } from "@/app/api/events/[eventId]/reports/route";
import { GET as registrationExportGET } from "@/app/api/events/[eventId]/exports/registrations/route";

const report = {
  summary: {
    activeRegistrations: 1,
    attendees: 1,
    rosterGroups: 1,
    mealSelections: 0,
    housingSelections: 0,
    seminarInterests: 0,
    childcareSelections: 0,
    volunteerSelections: 0,
    attendanceSelections: 0,
  },
  rosterGroups: [{
    id: "group_one",
    label: "=Formula Group",
    fieldLabel: "Club",
    attendees: [{
      attendeeId: "attendee_one",
      registrationId: "registration_one",
      confirmationCode: "REG-ONE",
      firstName: "Ada",
      lastName: "Lovelace",
      attendeeType: "Adult",
      accountHolderName: "Ada Lovelace",
    }],
  }],
  meals: [],
  housing: [],
  seminars: [],
  childcare: [],
  volunteers: [],
  attendance: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.getCurrentSession.mockResolvedValue({ user: { id: "user_one" } });
  dependencies.getOperationalReport.mockResolvedValue(report);
  dependencies.listRegistrations.mockResolvedValue([]);
});

describe("registration export route", () => {
  it("exports the canonical submission timestamp as ISO 8601 and leaves unknown values empty", async () => {
    dependencies.listRegistrations.mockResolvedValue([
      {
        confirmationCode: "REG-KNOWN",
        accountHolder: { firstName: "Synthetic", lastName: "Known", email: "known@example.test" },
        status: "SUBMITTED",
        submittedAt: "2026-07-30T18:13:05.955Z",
        attendeeCount: 1,
        totalAmountCents: 12_500,
        paidCents: 5_000,
        balanceCents: 7_500,
      },
      {
        confirmationCode: "REG-UNKNOWN",
        accountHolder: { firstName: "Synthetic", lastName: "Unknown", email: "unknown@example.test" },
        status: "DRAFT",
        submittedAt: null,
        attendeeCount: 1,
        totalAmountCents: 0,
        paidCents: 0,
        balanceCents: 0,
      },
    ]);

    const response = await registrationExportGET(
      new Request("https://events.imsda.test/api/events/event_one/exports/registrations"),
      { params: Promise.resolve({ eventId: "event_one" }) },
    );
    const csv = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(csv).toContain("Submitted at (ISO 8601)");
    expect(csv).toContain("2026-07-30T18:13:05.955Z");
    expect(csv).toContain('"REG-UNKNOWN","Synthetic Unknown","unknown@example.test","DRAFT","","1"');
  });
});

describe("operational report export route", () => {
  it("authorizes, disables caching, and returns formula-safe CSV", async () => {
    const response = await GET(
      new Request("https://events.imsda.test/api/events/event_one/reports?report=roster"),
      { params: Promise.resolve({ eventId: "event_one" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toContain("event_one-roster.csv");
    expect(dependencies.requirePermission).toHaveBeenCalledWith(
      expect.anything(),
      "event_one",
      "VIEW_REPORTS",
      dependencies.findActiveMembership,
    );
    expect(await response.text()).toContain("\"'=Formula Group\"");
  });

  it("rejects unknown report kinds before loading data", async () => {
    const response = await GET(
      new Request("https://events.imsda.test/api/events/event_one/reports?report=everything"),
      { params: Promise.resolve({ eventId: "event_one" }) },
    );

    expect(response.status).toBe(400);
    expect(dependencies.getOperationalReport).not.toHaveBeenCalled();
  });

  it("returns the authorization error without loading report data", async () => {
    dependencies.requirePermission.mockRejectedValue(
      new dependencies.AccessDeniedError("Reports are restricted."),
    );
    const response = await GET(
      new Request("https://events.imsda.test/api/events/event_one/reports?report=meals"),
      { params: Promise.resolve({ eventId: "event_one" }) },
    );

    expect(response.status).toBe(403);
    expect(dependencies.getOperationalReport).not.toHaveBeenCalled();
  });
});
