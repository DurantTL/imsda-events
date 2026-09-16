import { z } from "zod";

export const householdMemberInputSchema = z.object({
  relationship: z.string().trim().max(120).optional(),
  canManage: z.boolean().default(false),
  effectiveFrom: z.coerce.date().optional(),
});

export type HouseholdMemberInput = z.infer<typeof householdMemberInputSchema>;

export type HouseholdMemberRecord = {
  id: string;
  householdId: string;
  personId: string;
  relationship: string | null;
  /** Household-convenience flag only — never guardian authority. See the
   * `HouseholdMember` model doc in `prisma/schema.prisma` and #43. */
  canManage: boolean;
  effectiveFrom: string | null;
  effectiveTo: string | null;
};

/**
 * Whether two membership intervals overlap, using the same open-upper-bound
 * (`[from, to)`) semantics as the database's `EXCLUDE USING gist`
 * constraint: a null bound is unbounded in that direction. Exported so the
 * repository's pre-check and its tests share one definition of "overlap"
 * with the invariant the database enforces.
 */
export function membershipIntervalsOverlap(
  a: { effectiveFrom: Date | null; effectiveTo: Date | null },
  b: { effectiveFrom: Date | null; effectiveTo: Date | null },
): boolean {
  const aStartsBeforeBEnds = b.effectiveTo === null || a.effectiveFrom === null || a.effectiveFrom < b.effectiveTo;
  const bStartsBeforeAEnds = a.effectiveTo === null || b.effectiveFrom === null || b.effectiveFrom < a.effectiveTo;
  return aStartsBeforeBEnds && bStartsBeforeAEnds;
}

/** Whether a membership interval covers a given point in time. */
export function membershipCoversDate(
  member: { effectiveFrom: Date | null; effectiveTo: Date | null },
  asOf: Date,
): boolean {
  const startedByThen = member.effectiveFrom === null || member.effectiveFrom <= asOf;
  const notYetEnded = member.effectiveTo === null || member.effectiveTo > asOf;
  return startedByThen && notYetEnded;
}
