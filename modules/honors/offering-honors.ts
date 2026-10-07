/**
 * A class can teach several catalog honors (#812). Pure helpers shared by the
 * repositories, the screens and the exports, so every place names the honors of
 * a class the same way. `HonorOfferingHonor` rows are the source of truth;
 * `HonorOffering.honorId` is only the primary (first) honor.
 */

export type OfferingHonor = { id: string; code: string; name: string; isActive: boolean };

/** The Prisma select for a class's honors, in the order staff set them. */
export const offeringHonorsSelect = {
  orderBy: [{ position: "asc" as const }, { createdAt: "asc" as const }, { honorId: "asc" as const }],
  select: { honor: { select: { id: true, code: true, name: true, isActive: true } } },
};

type HonorRow = { honor: OfferingHonor };

/** Joined with " + ", which neither a code nor a catalog name uses, so a CSV cell stays unambiguous. */
export const honorNameSeparator = " + ";

export function joinHonorNames(names: readonly string[]) {
  return names.join(honorNameSeparator);
}

/**
 * What every reader of a class needs: the honors in order, their ids, and the
 * joined name and code that stand in for the old single `honorName` / `honorCode`.
 */
export function summarizeOfferingHonors(rows: readonly HonorRow[]) {
  const honors = rows.map((row) => row.honor);
  return {
    honors,
    honorIds: honors.map((honor) => honor.id),
    honorName: joinHonorNames(honors.map((honor) => honor.name)),
    honorCode: joinHonorNames(honors.map((honor) => honor.code)),
  };
}

export type OfferingHonorSummary = ReturnType<typeof summarizeOfferingHonors>;

/**
 * How a class's set of honors changes (#812). Once anyone is enrolled the set is
 * frozen, honor by honor: an honor can't be dropped (enrollees and written-back
 * records name it) and one can't be added (enrollees chose the class for the
 * honors it listed, so a new honor would enroll them in something they never
 * saw). Reordering the same honors changes nothing anyone is enrolled in.
 */
export function honorSetChange(current: readonly string[], next: readonly string[]) {
  const currentSet = new Set(current);
  const nextSet = new Set(next);
  const added = next.filter((id) => !currentSet.has(id));
  const removed = current.filter((id) => !nextSet.has(id));
  const reordered = added.length === 0 && removed.length === 0 && current.some((id, index) => next[index] !== id);
  return { added, removed, reordered, changed: added.length > 0 || removed.length > 0 };
}

/** Why a change to a class's honors is refused once clubs are enrolled, or null. Names the honors that block it. */
export function honorSetLockMessage(
  change: Pick<ReturnType<typeof honorSetChange>, "added" | "removed">,
  nameOf: (honorId: string) => string,
) {
  if (change.removed.length === 0 && change.added.length === 0) return null;
  const names = (ids: readonly string[]) => ids.map(nameOf).join(", ");
  const parts = [
    change.removed.length ? `${names(change.removed)} can't be removed` : "",
    change.added.length ? `${names(change.added)} can't be added` : "",
  ].filter(Boolean).join(" and ");
  return `Clubs have already picked this class, so its honors are locked: ${parts}. Their order can still change. Delete the class (which removes those picks) or add a new one.`;
}
