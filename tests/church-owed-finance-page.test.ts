import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  listEventsForUser: vi.fn(),
  findActiveMembership: vi.fn(),
  listChurchAmountsOwed: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("redirected");
  }),
}));
vi.mock("@/modules/access/current-session", () => ({
  getCurrentSession: dependencies.getCurrentSession,
}));
vi.mock("@/modules/events/repository", () => ({
  listEventsForUser: dependencies.listEventsForUser,
  findActiveMembership: dependencies.findActiveMembership,
}));
vi.mock("@/modules/club-registrations/repository", () => ({
  listChurchAmountsOwed: dependencies.listChurchAmountsOwed,
}));

import ChurchOwedPage from "@/app/(workspace)/finance/church-owed/page";

function event(id: string) {
  return { id, name: `Event ${id}`, billingMode: "DEFERRED_ORGANIZATION_INVOICE" };
}

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.getCurrentSession.mockResolvedValue({
    user: { id: "user_one", email: "finance@example.test", displayName: "Finance" },
  });
  dependencies.listChurchAmountsOwed.mockResolvedValue([]);
});

describe("owed-by-churches page access (#409, #465)", () => {
  it("never loads event B's amounts — or falls back to event A's — for a finance manager assigned only to event A; it sends them to the picker instead", async () => {
    dependencies.listEventsForUser.mockResolvedValue([event("event_a")]);
    dependencies.findActiveMembership.mockImplementation(async (userId: string, eventId: string) => (
      eventId === "event_a"
        ? { eventId, userId, role: "FINANCE_MANAGER", status: "ACTIVE", permissions: [] }
        : null
    ));

    await expect(ChurchOwedPage({ searchParams: Promise.resolve({ event: "event_b" }) })).rejects.toThrow("redirected");

    expect(dependencies.listChurchAmountsOwed).not.toHaveBeenCalled();
  });

  it("refuses event B when the user holds MANAGE_FINANCE only on event A", async () => {
    dependencies.listEventsForUser.mockResolvedValue([event("event_a"), event("event_b")]);
    dependencies.findActiveMembership.mockImplementation(async (userId: string, eventId: string) => ({
      eventId,
      userId,
      role: eventId === "event_a" ? "FINANCE_MANAGER" : "READ_ONLY_STAFF",
      status: "ACTIVE",
      permissions: [],
    }));

    const markup = renderToStaticMarkup(
      await ChurchOwedPage({ searchParams: Promise.resolve({ event: "event_b" }) }),
    );

    expect(markup).toContain("Finance is restricted");
    expect(dependencies.listChurchAmountsOwed).not.toHaveBeenCalled();
  });
});
