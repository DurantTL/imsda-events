import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ getPrisma: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));

import { listClubCheckInInfo } from "@/modules/club-registrations/repository";

beforeEach(() => {
  vi.clearAllMocks();
});

function row(
  organizationId: string,
  organizationName: string,
  confirmationCode: string,
  status: string,
  total: string,
) {
  return {
    organization: { id: organizationId, name: organizationName },
    registration: { confirmationCode, status, totalAmount: { toString: () => total } },
  };
}

describe("club check-in lookup (#412)", () => {
  it("passes through only active club registrations, scoped to the event, with what the church owes", async () => {
    const findMany = vi.fn().mockResolvedValue([
      row("org-a", "Ankeny Son-Seekers", "REG-A1", "CONFIRMED", "63"),
      row("org-z", "Zion Pathfinders", "REG-Z1", "SUBMITTED", "18.50"),
    ]);
    dependencies.getPrisma.mockReturnValue({ clubEventRegistration: { findMany } });

    const clubs = await listClubCheckInInfo("event-1");

    expect(findMany).toHaveBeenCalledWith({
      where: { eventId: "event-1", registration: { status: { in: ["SUBMITTED", "CONFIRMED"] } } },
      select: expect.any(Object),
    });
    expect(clubs).toEqual([
      { organizationId: "org-a", organizationName: "Ankeny Son-Seekers", confirmationCode: "REG-A1", amountOwedCents: 6300 },
      { organizationId: "org-z", organizationName: "Zion Pathfinders", confirmationCode: "REG-Z1", amountOwedCents: 1850 },
    ]);
  });

  it("asks Prisma to leave out waitlisted and cancelled club registrations, matching single check-in eligibility", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    dependencies.getPrisma.mockReturnValue({ clubEventRegistration: { findMany } });

    await listClubCheckInInfo("event-1");

    const whereArg = findMany.mock.calls[0][0].where;
    expect(whereArg.registration.status.in).toEqual(["SUBMITTED", "CONFIRMED"]);
    expect(whereArg.registration.status.in).not.toContain("WAITLISTED");
    expect(whereArg.registration.status.in).not.toContain("CANCELLED");
  });

  it("returns nothing for an event with no active club registrations", async () => {
    dependencies.getPrisma.mockReturnValue({
      clubEventRegistration: { findMany: vi.fn().mockResolvedValue([]) },
    });
    expect(await listClubCheckInInfo("event-1")).toEqual([]);
  });
});
