import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ getPrisma: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));

import {
  addHouseholdMember,
  closeHouseholdMember,
  currentHouseholdMembers,
  householdMembersAsOf,
  personHouseholdsAsOf,
} from "@/modules/people/household-repository";

const d = (iso: string) => new Date(iso);

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "hhm_1",
    householdId: "hh_miller",
    personId: "per_avery",
    relationship: "Child",
    canManage: false,
    effectiveFrom: d("2026-01-01T00:00:00.000Z"),
    effectiveTo: null,
    createdAt: d("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function fixture(members: ReturnType<typeof row>[] = []) {
  const householdMember = {
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      return members.filter((member) => {
        if (where.householdId && member.householdId !== where.householdId) return false;
        if (where.personId && member.personId !== where.personId) return false;
        return true;
      });
    }),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
      members.find((member) => member.id === where.id) ?? null,
    ),
    create: vi.fn(),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const existing = members.find((member) => member.id === where.id);
      const updated = { ...existing, ...data };
      return updated;
    }),
  };
  const prisma = {
    household: { findUnique: vi.fn().mockResolvedValue({ id: "hh_miller" }) },
    person: { findUnique: vi.fn().mockResolvedValue({ id: "per_avery" }) },
    householdMember,
  };
  mocks.getPrisma.mockReturnValue(prisma);
  return { prisma, householdMember };
}

beforeEach(() => vi.clearAllMocks());

describe("addHouseholdMember", () => {
  it("opens a new membership with the given or default effectiveFrom", async () => {
    const { householdMember } = fixture([]);
    householdMember.create.mockResolvedValue(row({ id: "hhm_new" }));

    const result = await addHouseholdMember("hh_miller", "per_avery", { relationship: "Child" });
    expect(result.id).toBe("hhm_new");
    expect(householdMember.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ householdId: "hh_miller", personId: "per_avery" }) }),
    );
  });

  it("rejects adding a person who already has an open membership in the same household", async () => {
    fixture([row({ effectiveTo: null })]);
    await expect(addHouseholdMember("hh_miller", "per_avery", {})).rejects.toMatchObject({
      code: "OVERLAPPING_MEMBERSHIP",
    });
  });

  it("allows adding a person whose only prior membership in that household is closed", async () => {
    const { householdMember } = fixture([
      row({ id: "hhm_old", effectiveFrom: d("2025-01-01T00:00:00.000Z"), effectiveTo: d("2025-06-01T00:00:00.000Z") }),
    ]);
    householdMember.create.mockResolvedValue(row({ id: "hhm_rejoined", effectiveFrom: d("2026-01-01T00:00:00.000Z") }));

    const result = await addHouseholdMember("hh_miller", "per_avery", {
      effectiveFrom: d("2026-01-01T00:00:00.000Z"),
    });
    expect(result.id).toBe("hhm_rejoined");
  });

  it("allows the same person to belong to two different households at once", async () => {
    const { householdMember } = fixture([row({ householdId: "hh_miller", effectiveTo: null })]);
    householdMember.create.mockResolvedValue(row({ id: "hhm_second", householdId: "hh_other" }));

    const result = await addHouseholdMember("hh_other", "per_avery", {});
    expect(result.householdId).toBe("hh_other");
  });

  it("maps a database exclusion-constraint violation to the same domain error as the pre-check", async () => {
    const { householdMember } = fixture([]);
    householdMember.create.mockRejectedValue(
      new Prisma.PrismaClientUnknownRequestError(
        'conflicting key value violates exclusion constraint "HouseholdMember_no_overlapping_membership"',
        { clientVersion: "test" },
      ),
    );
    await expect(addHouseholdMember("hh_miller", "per_avery", {})).rejects.toMatchObject({
      code: "OVERLAPPING_MEMBERSHIP",
    });
  });
});

describe("closeHouseholdMember", () => {
  it("closes an open membership rather than deleting it", async () => {
    const { householdMember } = fixture([row({ id: "hhm_1", effectiveTo: null })]);
    const closedAt = d("2026-06-01T00:00:00.000Z");

    const result = await closeHouseholdMember("hhm_1", closedAt);

    expect(result.effectiveTo).toBe(closedAt.toISOString());
    expect(householdMember.update).toHaveBeenCalledWith({
      where: { id: "hhm_1" },
      data: { effectiveTo: closedAt },
    });
    // Never a delete call of any kind.
    expect((householdMember as unknown as { delete?: unknown }).delete).toBeUndefined();
  });

  it("refuses to close a membership that is already closed", async () => {
    fixture([row({ id: "hhm_1", effectiveTo: d("2026-03-01T00:00:00.000Z") })]);
    await expect(closeHouseholdMember("hhm_1", d("2026-06-01T00:00:00.000Z"))).rejects.toMatchObject({
      code: "NOT_ACTIVE",
    });
  });

  it("refuses to close a membership at or before it started", async () => {
    fixture([row({ id: "hhm_1", effectiveFrom: d("2026-06-01T00:00:00.000Z"), effectiveTo: null })]);
    await expect(closeHouseholdMember("hhm_1", d("2026-06-01T00:00:00.000Z"))).rejects.toMatchObject({
      code: "INVALID_RANGE",
    });
  });
});

describe("point-in-time household resolution", () => {
  it("a person moving households mid-year reads correctly for each period", async () => {
    const members = [
      row({
        id: "hhm_old_household",
        householdId: "hh_old",
        personId: "per_avery",
        effectiveFrom: d("2026-01-01T00:00:00.000Z"),
        effectiveTo: d("2026-07-01T00:00:00.000Z"),
      }),
      row({
        id: "hhm_new_household",
        householdId: "hh_new",
        personId: "per_avery",
        effectiveFrom: d("2026-07-01T00:00:00.000Z"),
        effectiveTo: null,
      }),
    ];
    fixture(members);

    const inSpring = await householdMembersAsOf("hh_old", d("2026-03-01T00:00:00.000Z"));
    expect(inSpring.map((m) => m.id)).toEqual(["hhm_old_household"]);

    const inFall = await householdMembersAsOf("hh_new", d("2026-09-01T00:00:00.000Z"));
    expect(inFall.map((m) => m.id)).toEqual(["hhm_new_household"]);

    // The old household no longer shows them once they've moved.
    const oldHouseholdNow = await householdMembersAsOf("hh_old", d("2026-09-01T00:00:00.000Z"));
    expect(oldHouseholdNow).toHaveLength(0);
  });

  it("a person in two households at once appears in both as of today", async () => {
    const members = [
      row({ id: "hhm_a", householdId: "hh_a", personId: "per_avery", effectiveTo: null }),
      row({ id: "hhm_b", householdId: "hh_b", personId: "per_avery", effectiveTo: null }),
    ];
    fixture(members);

    const households = await personHouseholdsAsOf("per_avery", d("2026-06-01T00:00:00.000Z"));
    expect(households.map((m) => m.householdId).sort()).toEqual(["hh_a", "hh_b"]);
  });

  it("a closed membership is still visible to a past-dated (e.g. registration-time) query", async () => {
    const members = [
      row({
        id: "hhm_closed",
        householdId: "hh_miller",
        personId: "per_avery",
        effectiveFrom: d("2025-01-01T00:00:00.000Z"),
        effectiveTo: d("2025-12-01T00:00:00.000Z"),
      }),
    ];
    fixture(members);

    // A registration submitted in mid-2025, read back today, should still
    // see the household context as it was then.
    const asOfRegistration = await householdMembersAsOf("hh_miller", d("2025-06-01T00:00:00.000Z"));
    expect(asOfRegistration.map((m) => m.id)).toEqual(["hhm_closed"]);

    // Today's view of the same household does not include them.
    const today = await currentHouseholdMembers("hh_miller");
    expect(today).toHaveLength(0);
  });
});
