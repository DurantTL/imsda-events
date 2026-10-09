import type { Prisma } from "@prisma/client";

/**
 * Each person's completed honors (#486): only a person-and-honor's *latest*
 * non-voided entry (highest `seq`) counts, same as the Honors page, so an
 * honor corrected back to in progress no longer counts. Shared by the
 * master-award progress and the Honors Weekend class prerequisites (#832).
 */
export async function completedHonorsByPerson(
  db: Pick<Prisma.TransactionClient, "memberHonorEntry">,
  personIds: readonly string[],
  honorIds: readonly string[],
) {
  const completed = new Map<string, Set<string>>();
  if (personIds.length === 0 || honorIds.length === 0) return completed;
  const entries = await db.memberHonorEntry.findMany({
    where: { personId: { in: [...personIds] }, honorId: { in: [...honorIds] }, void: null },
    orderBy: { seq: "desc" },
    select: { personId: true, honorId: true, status: true },
  });
  return completedFromLatestEntries(entries);
}

/** Pure form of the same rule, for tests: entries newest first (highest seq first), voided ones already left out. */
export function completedFromLatestEntries(entries: ReadonlyArray<{ personId: string; honorId: string; status: string }>) {
  const completed = new Map<string, Set<string>>();
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.personId}\u0000${entry.honorId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (entry.status !== "COMPLETED") continue;
    const set = completed.get(entry.personId) ?? new Set<string>();
    set.add(entry.honorId);
    completed.set(entry.personId, set);
  }
  return completed;
}
