import "server-only";

import { getPrisma } from "@/lib/prisma";

export type HouseholdBackfillRow = {
  id: string;
  householdId: string;
  personId: string;
  effectiveFrom: string;
};

export type HouseholdBackfillReport = {
  dryRun: boolean;
  totalCandidates: number;
  updatedCount: number;
  rows: HouseholdBackfillRow[];
};

/**
 * Populates `effectiveFrom` on legacy `HouseholdMember` rows (created before
 * the identity slice 1 migration) from their `createdAt`, leaving
 * `effectiveTo` open. Idempotent: it only ever selects rows where
 * `effectiveFrom` is still null, so a repeated run — dry or applied — finds
 * nothing left to do once every legacy row has been backfilled, mirroring
 * `backfillAttendeeTypes` in `modules/attendee-types/repository.ts`.
 *
 * `apply` defaults to false (dry run): the report is always returned, and
 * rows are only written when `apply` is true. This mirrors the
 * dry-run-by-default convention `scripts/backfill-attendee-types.ts` uses,
 * so an operator can inspect the plan before committing to it — the human
 * checkpoint AGENTS.md requires for changes to existing data.
 */
export async function backfillHouseholdMembershipEffectiveDates(
  apply = false,
): Promise<HouseholdBackfillReport> {
  const prisma = getPrisma();
  const candidates = await prisma.householdMember.findMany({
    where: { effectiveFrom: null },
    select: { id: true, householdId: true, personId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  let updatedCount = 0;
  if (apply && candidates.length > 0) {
    await prisma.$transaction(
      candidates.map((row) =>
        prisma.householdMember.update({
          where: { id: row.id, effectiveFrom: null },
          data: { effectiveFrom: row.createdAt },
        }),
      ),
    );
    updatedCount = candidates.length;
  }

  return {
    dryRun: !apply,
    totalCandidates: candidates.length,
    updatedCount,
    rows: candidates.map((row) => ({
      id: row.id,
      householdId: row.householdId,
      personId: row.personId,
      effectiveFrom: row.createdAt.toISOString(),
    })),
  };
}
