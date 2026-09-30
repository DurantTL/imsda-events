import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getPrisma: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));

import { loadMasterAwardProgress } from "@/modules/earned-awards/order-source";

/** Master Award progress options used by the director export (#655). Synthetic data only. */

const people = Array.from({ length: 10 }, (_, index) => ({ id: `p${index}`, firstName: `Member${index}`, lastName: `Test${index}` }));
const prisma = {
  masterAwardRule: { findMany: vi.fn() },
  clubRosterMember: { findMany: vi.fn() },
  memberHonorEntry: { findMany: vi.fn() },
  person: { findMany: vi.fn() },
  clubOrderNeed: { findMany: vi.fn() },
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getPrisma.mockReturnValue(prisma);
  prisma.masterAwardRule.findMany.mockResolvedValue([{
    id: "rule-1", name: "Sample Master Award", itemId: null,
    groups: [{ minimum: 2, honors: [{ honorId: "h1" }, { honorId: "h2" }] }],
  }]);
  // Everyone has completed exactly one of the two honors: in progress, not earned.
  prisma.memberHonorEntry.findMany.mockResolvedValue(people.map((person) => ({ personId: person.id, honorId: "h1", status: "COMPLETED" })));
  prisma.person.findMany.mockResolvedValue(people);
  prisma.clubOrderNeed.findMany.mockResolvedValue([]);
});

describe("loadMasterAwardProgress options", () => {
  it("cuts the closest list to 8 by default and keeps everyone with no limit", async () => {
    const personIds = people.map((person) => person.id);
    const [cut] = await loadMasterAwardProgress("club-1", new Date("2026-10-01T12:00:00Z"), { personIds });
    expect(cut.closest).toHaveLength(8);
    const [all] = await loadMasterAwardProgress("club-1", new Date("2026-10-01T12:00:00Z"), { personIds, closestLimit: Number.POSITIVE_INFINITY });
    expect(all.closest).toHaveLength(10);
  });

  it("uses the given people instead of the current year's roster", async () => {
    await loadMasterAwardProgress("club-1", new Date("2026-10-01T12:00:00Z"), { personIds: ["p1", "p2"] });
    expect(prisma.clubRosterMember.findMany).not.toHaveBeenCalled();
    expect(prisma.memberHonorEntry.findMany.mock.calls[0][0].where.personId).toEqual({ in: ["p1", "p2"] });
  });
});
