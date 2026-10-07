/**
 * Honors Weekend catalog, sessions, and offerings (#357). Pure rules shared by
 * the repository, the copy preview, and the staff screens.
 */

export const honorOfferingSpanLabels = {
  SINGLE_SESSION: "One session",
  ALL_SESSIONS: "All sessions",
} as const;

export type HonorOfferingSpan = keyof typeof honorOfferingSpanLabels;

/**
 * What the session edit form sends (#615): only the fields that changed, so a
 * rename never carries a site or an order and an unchanged site is never
 * re-sent. `formLocationId` is the select's value ("" for no site).
 */
export function sessionEditPatch(
  current: { name: string; sortOrder: number; locationId: string | null },
  form: { name: string; sortOrder: number; locationId: string | null },
) {
  return {
    ...(form.name.trim() === current.name ? {} : { name: form.name }),
    ...(form.sortOrder === current.sortOrder ? {} : { sortOrder: form.sortOrder }),
    ...((form.locationId ?? null) === (current.locationId ?? null) ? {} : { locationId: form.locationId ?? null }),
  };
}

/**
 * The honors, span and session of a class being edited (#615, #812), only when
 * they changed, so a class clubs have picked can still have its seats, teacher
 * and room edited without the server treating the request as a move. The honors
 * count as changed when the set or its order differs.
 */
export function offeringPlacementPatch(
  current: { honorIds: readonly string[]; span: HonorOfferingSpan; sessionId: string | null },
  form: { honorIds: readonly string[]; span: HonorOfferingSpan; sessionId: string | null },
) {
  const span = form.span;
  const sessionId = span === "SINGLE_SESSION" ? form.sessionId : null;
  const sameHonors = form.honorIds.length === current.honorIds.length
    && form.honorIds.every((id, index) => id === current.honorIds[index]);
  return {
    ...(sameHonors ? {} : { honorIds: [...form.honorIds] }),
    ...(span === current.span ? {} : { span }),
    ...(sessionId === current.sessionId ? {} : { sessionId }),
  };
}

export function normalizeHonorText(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

export function normalizeHonorCode(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleUpperCase("en-US");
}

/**
 * The General Conference honor categories (#531), plus Master Awards. The
 * category lives on `Honor` itself; the club supply catalog import sets it
 * for linked honors and the honor catalog CSV (#385) accepts it directly.
 */
export const honorCategoryLabels = {
  NATURE: "Nature",
  HEALTH_AND_SCIENCE: "Health and Science",
  SPIRITUAL_GROWTH_OUTREACH_AND_HERITAGE: "Spiritual Growth, Outreach, and Heritage",
  ARTS_CRAFTS_AND_HOBBIES: "Arts, Crafts, and Hobbies",
  RECREATION: "Recreation",
  HOUSEHOLD_ARTS: "Household Arts",
  VOCATIONAL: "Vocational",
  OUTDOOR_INDUSTRIES: "Outdoor Industries",
  MISCELLANEOUS_HONORS: "Miscellaneous Honors",
  MASTER_AWARDS: "Master Awards",
} as const;

export type HonorCategory = keyof typeof honorCategoryLabels;

/**
 * Category or section text for lookups: whitespace and case collapsed, "&"
 * read as "and", commas ignored, and the source sheet's one typo
 * ("Reacreation") read as "Recreation".
 */
export function normalizeHonorCategoryText(value: string) {
  return value
    .normalize("NFKC")
    .replace(/&/g, " and ")
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/\breacreation\b/, "recreation");
}

const honorCategoryByText = new Map(
  (Object.entries(honorCategoryLabels) as Array<[HonorCategory, string]>)
    .flatMap(([category, label]) => [
      [normalizeHonorCategoryText(label), category] as const,
      [normalizeHonorCategoryText(category.replace(/_/g, " ")), category] as const,
    ]),
);

/** An honor category from free text (a CSV cell), or null when it matches none. */
export function resolveHonorCategory(text: string): HonorCategory | null {
  return honorCategoryByText.get(normalizeHonorCategoryText(text)) ?? null;
}

/**
 * `locationId` is the class's site (#589): a single-session class takes its
 * session's site, an all-sessions class its own. Conflicts are per site, so two
 * sites can both teach the same honor; without sites every slot is null and
 * nothing changes.
 */
type OfferingSlot = { honorId: string; span: HonorOfferingSpan; sessionId: string | null; locationId?: string | null };

/**
 * Why a new offering can't sit beside the event's existing ones, or null.
 * An honor taught across all sessions can't also be in a single session, and
 * no honor is offered twice in the same session, each within one site.
 */
export function offeringSlotConflict(candidate: OfferingSlot, existing: readonly OfferingSlot[]) {
  const sameHonor = existing.filter((offering) => offering.honorId === candidate.honorId
    && (offering.locationId ?? null) === (candidate.locationId ?? null));
  if (candidate.span === "ALL_SESSIONS") {
    if (sameHonor.some((offering) => offering.span === "ALL_SESSIONS")) {
      return "This honor is already offered across all sessions at this site.";
    }
    if (sameHonor.length > 0) {
      return "This honor is already offered in a single session. An all-sessions honor can't also be in a single session.";
    }
    return null;
  }
  if (sameHonor.some((offering) => offering.span === "ALL_SESSIONS")) {
    return "This honor is already offered across all sessions at this site, so it can't also be in a single session.";
  }
  if (sameHonor.some((offering) => offering.sessionId === candidate.sessionId)) {
    return "This honor is already offered in that session.";
  }
  return null;
}

type ClassSlot = { honorIds: readonly string[]; span: HonorOfferingSpan; sessionId: string | null; locationId?: string | null };

/**
 * Why a class that teaches `candidate.honorIds` can't sit beside the event's
 * other classes, or null (#812). The rules are `offeringSlotConflict`'s, applied
 * to each honor the class teaches against each honor the other classes teach:
 * the same honor can't be taught twice in one session (or twice across all
 * sessions at one site), whichever classes teach it. Two classes may still
 * teach the same honor in different sessions. `nameOf` names the honor in the
 * message when the class teaches several.
 */
export function classSlotConflict(
  candidate: ClassSlot,
  existing: readonly ClassSlot[],
  nameOf: (honorId: string) => string = () => "",
) {
  for (const honorId of candidate.honorIds) {
    const slots = existing.flatMap((offering) => (offering.honorIds.includes(honorId) ? [{ ...offering, honorId }] : []));
    const conflict = offeringSlotConflict({ ...candidate, honorId }, slots);
    if (conflict) return candidate.honorIds.length > 1 && nameOf(honorId) ? `${nameOf(honorId)}: ${conflict}` : conflict;
  }
  return null;
}
