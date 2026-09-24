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
  realRequirePermission.current = actual.requirePermission;
  // The real error class, so the real permission check's refusals are
  // recognised by the route the same way the mocked ones are.
  dependencies.AccessDeniedError = actual.AccessDeniedError as never;
  return {
    ...actual,
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

const realRequirePermission = vi.hoisted(() => ({
  current: null as null | typeof import("@/modules/access/authorization").requirePermission,
}));

import { GET } from "@/app/api/events/[eventId]/exports/church-owed/route";

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.getCurrentSession.mockResolvedValue({ user: { id: "user_one" } });
});

function row(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: "org-1",
    organizationName: "Club",
    churchId: "church-1",
    churchName: "Ankeny SDA Church",
    confirmationCode: "REG-1",
    status: "SUBMITTED",
    attendeeCount: 1,
    isBilled: true,
    amountOwedCents: 900,
    ...overrides,
  };
}

describe("church-owed CSV export (#409)", () => {
  it("refuses a finance manager of event A who requests event B's export", async () => {
    dependencies.getCurrentSession.mockResolvedValue({
      user: { id: "user_one", email: "finance@example.test", displayName: "Finance" },
    });
    dependencies.findActiveMembership.mockImplementation(async (userId: string, eventId: string) => (
      eventId === "event_a"
        ? { eventId, userId, role: "FINANCE_MANAGER", status: "ACTIVE", permissions: [] }
        : null
    ));
    dependencies.requirePermission.mockImplementation(realRequirePermission.current!);

    const refused = await GET(
      new Request("https://events.imsda.test/api/events/event_b/exports/church-owed"),
      { params: Promise.resolve({ eventId: "event_b" }) },
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: "EVENT_ACCESS_DENIED" });
    expect(dependencies.listChurchAmountsOwed).not.toHaveBeenCalled();

    dependencies.listChurchAmountsOwed.mockResolvedValue([]);
    const allowed = await GET(
      new Request("https://events.imsda.test/api/events/event_a/exports/church-owed"),
      { params: Promise.resolve({ eventId: "event_a" }) },
    );
    expect(allowed.status).toBe(200);
    expect(dependencies.listChurchAmountsOwed).toHaveBeenCalledWith("event_a");
  });

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
    dependencies.listChurchAmountsOwed.mockResolvedValue([
      row({ organizationName: "Ankeny Son-Seekers", confirmationCode: "REG-A1", attendeeCount: 2, amountOwedCents: 1300 }),
      row({ organizationId: "org-3", organizationName: "Ankeny Adventurers", confirmationCode: "REG-A2", amountOwedCents: 900 }),
      row({ organizationId: "org-4", organizationName: "Waiting Club", confirmationCode: "REG-W1", status: "WAITLISTED", isBilled: false, amountOwedCents: 0 }),
      row({ organizationId: "org-5", organizationName: "Gone Club", confirmationCode: "REG-C1", status: "CANCELLED", isBilled: false, amountOwedCents: 0 }),
    ]);

    const response = await GET(
      new Request("https://events.imsda.test/api/events/event_one/exports/church-owed"),
      { params: Promise.resolve({ eventId: "event_one" }) },
    );
    const csv = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe(
      '"Church","Club","Confirmation code","Status","Billed to church","Attendees","Estimated amount owed","Church estimated total","Note"',
    );
    // Each billed club carries its church and that church's subtotal.
    expect(lines[1]).toBe(
      '"Ankeny SDA Church","Ankeny Adventurers","REG-A2","SUBMITTED","Yes","1","9.00","22.00","Billed to the church after the event, not paid online"',
    );
    expect(lines[2]).toContain('"Ankeny Son-Seekers","REG-A1","SUBMITTED","Yes","2","13.00","22.00"');
    // Waitlisted and cancelled clubs are listed, labelled, and owe $0.
    expect(csv).toContain('"REG-W1","WAITLISTED","No","1","0.00","","No amount owed while waitlisted"');
    expect(csv).toContain('"REG-C1","CANCELLED","No","1","0.00","","Cancelled — nothing owed"');
    expect(csv).not.toMatch(/birth|medical|allerg/i);
  });

  it("escapes a church name that looks like a spreadsheet formula (CSV injection)", async () => {
    dependencies.requirePermission.mockResolvedValue({ user: { id: "user_one" }, membership: {} });
    dependencies.listChurchAmountsOwed.mockResolvedValue([
      row({ organizationId: "org-2", organizationName: "=cmd|'/c calc'!A1", confirmationCode: "REG-B1" }),
    ]);

    const response = await GET(
      new Request("https://events.imsda.test/api/events/event_one/exports/church-owed"),
      { params: Promise.resolve({ eventId: "event_one" }) },
    );
    const csv = await response.text();

    expect(csv).toContain("\"'=cmd|'/c calc'!A1\"");
  });
});
