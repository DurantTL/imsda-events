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
    listChurchAmountsOwed: vi.fn(),
  };
});

vi.mock("@/modules/access/authorization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/access/authorization")>();
  return {
    ...actual,
    AccessDeniedError: dependencies.AccessDeniedError,
    requirePermission: dependencies.requirePermission,
  };
});
vi.mock("@/modules/access/current-session", () => ({
  getCurrentSession: dependencies.getCurrentSession,
}));
vi.mock("@/modules/events/repository", () => ({
  findActiveMembership: dependencies.findActiveMembership,
}));
vi.mock("@/modules/club-registrations/repository", () => ({
  listChurchAmountsOwed: dependencies.listChurchAmountsOwed,
}));

import { GET } from "@/app/api/events/[eventId]/exports/church-owed/route";

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.getCurrentSession.mockResolvedValue({ user: { id: "user_one" } });
});

describe("church-owed CSV export (#409)", () => {
  it("requires MANAGE_FINANCE", async () => {
    dependencies.requirePermission.mockRejectedValue(
      new dependencies.AccessDeniedError("Only finance staff.", 403, "PERMISSION_DENIED"),
    );
    const response = await GET(
      new Request("https://events.imsda.test/api/events/event_one/exports/church-owed"),
      { params: Promise.resolve({ eventId: "event_one" }) },
    );
    expect(response.status).toBe(403);
    expect(dependencies.listChurchAmountsOwed).not.toHaveBeenCalled();
  });

  it("exports what each church owes, with confirmation, headcount, and amount, never birth dates or medical detail", async () => {
    dependencies.requirePermission.mockResolvedValue({ user: { id: "user_one" }, membership: {} });
    dependencies.listChurchAmountsOwed.mockResolvedValue([{
      organizationId: "org-1",
      organizationName: "Ankeny Son-Seekers",
      confirmationCode: "REG-A1",
      status: "SUBMITTED",
      attendeeCount: 2,
      amountOwedCents: 1300,
    }]);

    const response = await GET(
      new Request("https://events.imsda.test/api/events/event_one/exports/church-owed"),
      { params: Promise.resolve({ eventId: "event_one" }) },
    );
    const csv = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(csv).toContain("Organization");
    expect(csv).toContain("Ankeny Son-Seekers");
    expect(csv).toContain("REG-A1");
    expect(csv).toContain("13.00");
    expect(csv).not.toMatch(/birth|medical|allerg/i);
  });

  it("escapes a church name that looks like a spreadsheet formula (CSV injection)", async () => {
    dependencies.requirePermission.mockResolvedValue({ user: { id: "user_one" }, membership: {} });
    dependencies.listChurchAmountsOwed.mockResolvedValue([{
      organizationId: "org-2",
      organizationName: "=cmd|'/c calc'!A1",
      confirmationCode: "REG-B1",
      status: "SUBMITTED",
      attendeeCount: 1,
      amountOwedCents: 900,
    }]);

    const response = await GET(
      new Request("https://events.imsda.test/api/events/event_one/exports/church-owed"),
      { params: Promise.resolve({ eventId: "event_one" }) },
    );
    const csv = await response.text();

    expect(csv).toContain("\"'=cmd|'/c calc'!A1\"");
  });
});
