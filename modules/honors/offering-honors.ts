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
 * How a class's set of honors changes (#812). Staff can add or remove honors even
 * after people enroll: enrollment is per class, so adding an honor gives the
 * enrollees that honor (and the write-back includes it), and removing one takes
 * it from them. The one exception is an honor already written back as completed
 * for an enrollee of the class (`writtenBackRemovalMessage`). Reordering the same
 * honors changes nothing anyone takes.
 */
export function honorSetChange(current: readonly string[], next: readonly string[]) {
  const currentSet = new Set(current);
  const nextSet = new Set(next);
  const added = next.filter((id) => !currentSet.has(id));
  const removed = current.filter((id) => !nextSet.has(id));
  const reordered = added.length === 0 && removed.length === 0 && current.some((id, index) => next[index] !== id);
  return { added, removed, reordered, changed: added.length > 0 || removed.length > 0 };
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * What staff are asked to confirm before honors change on a class people are
 * enrolled in: "12 students are enrolled. They will now take: Birds + Knots."
 */
export function honorsNeedConfirmationMessage(enrolled: number, honorNames: readonly string[]) {
  return `${enrolled === 1 ? "1 person is" : `${enrolled} people are`} enrolled. They will now take: ${joinHonorNames(honorNames)}.`;
}

/** Why an honor can't come off a class: it was already recorded as completed for enrollees. */
export function writtenBackRemovalMessage(honorName: string, people: number) {
  return `${honorName} was already recorded as completed for ${people === 1 ? "1 person" : `${people} people`} in this class, so it can't be removed. Void those records first.`;
}

/**
 * A stable order for lists of classes: by the class's honor names sorted
 * alphabetically, so reordering the honors of a class never moves it.
 */
export function offeringSortKey(honors: ReadonlyArray<{ name: string }>) {
  return honors.map((honor) => honor.name).sort((a, b) => a.localeCompare(b)).join(honorNameSeparator);
}

/** Compares two classes as the repositories load them (`honors` rows with their honor). */
export function compareOfferingRows(
  a: { id: string; honors: ReadonlyArray<HonorRow> },
  b: { id: string; honors: ReadonlyArray<HonorRow> },
) {
  return offeringSortKey(a.honors.map((row) => row.honor)).localeCompare(offeringSortKey(b.honors.map((row) => row.honor))) || a.id.localeCompare(b.id);
}
