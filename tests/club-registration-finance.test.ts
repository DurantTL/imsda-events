import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ getPrisma: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));

import { listChurchAmountsOwed } from "@/modules/club-registrations/repository";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("what each church owes (#409)", () => {
  it("lists each club's confirmation, headcount, and amount owed, sorted by church", async () => {
    dependencies.getPrisma.mockReturnValue({
      clubEventRegistration: {
        findMany: vi.fn().mockResolvedValue([
          {
            organization: { id: "org-z", name: "Zion SDA Church Pathfinders" },
            registration: { confirmationCode: "REG-Z1", status: "SUBMITTED", totalAmount: { toString: () => "63" }, _count: { attendees: 5 } },
          },
          {
            organization: { id: "org-a", name: "Ankeny Son-Seekers" },
            registration: { confirmationCode: "REG-A1", status: "SUBMITTED", totalAmount: { toString: () => "13" }, _count: { attendees: 2 } },
          },
        ]),
      },
    });

    const owed = await listChurchAmountsOwed("event-1");

    // Sorted by church name, not submission order.
    expect(owed.map((row) => row.organizationName)).toEqual(["Ankeny Son-Seekers", "Zion SDA Church Pathfinders"]);
    expect(owed[0]).toMatchObject({
      organizationId: "org-a",
      confirmationCode: "REG-A1",
      status: "SUBMITTED",
      attendeeCount: 2,
      amountOwedCents: 1300,
    });
    expect(owed[1]).toMatchObject({ amountOwedCents: 6300 });
  });

  it("returns nothing for an event with no church-billed registrations", async () => {
    dependencies.getPrisma.mockReturnValue({
      clubEventRegistration: { findMany: vi.fn().mockResolvedValue([]) },
    });
    expect(await listChurchAmountsOwed("event-1")).toEqual([]);
  });
});
