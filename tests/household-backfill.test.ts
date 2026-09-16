import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ getPrisma: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));

import { backfillHouseholdMembershipEffectiveDates } from "@/modules/people/household-backfill";

beforeEach(() => vi.clearAllMocks());

function fixture() {
  const rows = [
    { id: "hhm_1", householdId: "hh_miller", personId: "per_avery", effectiveFrom: null as Date | null, createdAt: new Date("2026-01-05T00:00:00.000Z") },
    { id: "hhm_2", householdId: "hh_miller", personId: "per_jordan", effectiveFrom: null as Date | null, createdAt: new Date("2026-02-10T00:00:00.000Z") },
    { id: "hhm_3", householdId: "hh_smith", personId: "per_taylor", effectiveFrom: new Date("2026-03-01T00:00:00.000Z"), createdAt: new Date("2026-03-01T00:00:00.000Z") },
  ];
  const householdMember = {
    findMany: vi.fn(async ({ where }: { where: { effectiveFrom: null } }) =>
      rows
        .filter((row) => (where.effectiveFrom === null ? row.effectiveFrom === null : true))
        .map(({ id, householdId, personId, createdAt }) => ({ id, householdId, personId, createdAt })),
    ),
    update: vi.fn(async ({ where, data }: { where: { id: string; effectiveFrom: null }; data: { effectiveFrom: Date } }) => {
      const target = rows.find((row) => row.id === where.id);
      if (!target || target.effectiveFrom !== null) throw new Error("not found");
      target.effectiveFrom = data.effectiveFrom;
      return target;
    }),
  };
  const prisma = {
    householdMember,
    $transaction: vi.fn(async (operations: Promise<unknown>[]) => Promise.all(operations)),
  };
  mocks.getPrisma.mockReturnValue(prisma);
  return { prisma, rows, householdMember };
}

describe("backfillHouseholdMembershipEffectiveDates", () => {
  it("is a no-op report in dry-run mode", async () => {
    const { rows } = fixture();
    const report = await backfillHouseholdMembershipEffectiveDates(false);

    expect(report.dryRun).toBe(true);
    expect(report.totalCandidates).toBe(2);
    expect(report.updatedCount).toBe(0);
    expect(rows.find((row) => row.id === "hhm_1")?.effectiveFrom).toBeNull();
  });

  it("sets effectiveFrom from createdAt when applied", async () => {
    const { rows } = fixture();
    const report = await backfillHouseholdMembershipEffectiveDates(true);

    expect(report.dryRun).toBe(false);
    expect(report.updatedCount).toBe(2);
    expect(rows.find((row) => row.id === "hhm_1")?.effectiveFrom?.toISOString()).toBe("2026-01-05T00:00:00.000Z");
    expect(rows.find((row) => row.id === "hhm_2")?.effectiveFrom?.toISOString()).toBe("2026-02-10T00:00:00.000Z");
    // Already-dated legacy row is untouched.
    expect(rows.find((row) => row.id === "hhm_3")?.effectiveFrom?.toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });

  it("is idempotent: a repeated apply finds nothing left to backfill", async () => {
    const { householdMember } = fixture();

    const first = await backfillHouseholdMembershipEffectiveDates(true);
    expect(first.updatedCount).toBe(2);

    householdMember.update.mockClear();
    const second = await backfillHouseholdMembershipEffectiveDates(true);

    expect(second.totalCandidates).toBe(0);
    expect(second.updatedCount).toBe(0);
    expect(householdMember.update).not.toHaveBeenCalled();
  });
});
