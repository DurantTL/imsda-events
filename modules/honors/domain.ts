/**
 * Honors Weekend catalog, sessions, and offerings (#357). Pure rules shared by
 * the repository, the copy preview, and the staff screens.
 */

export const honorOfferingSpanLabels = {
  SINGLE_SESSION: "One session",
  ALL_SESSIONS: "All sessions",
} as const;

export type HonorOfferingSpan = keyof typeof honorOfferingSpanLabels;

export function normalizeHonorText(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

export function normalizeHonorCode(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleUpperCase("en-US");
}

type OfferingSlot = { honorId: string; span: HonorOfferingSpan; sessionId: string | null };

/**
 * Why a new offering can't sit beside the event's existing ones, or null.
 * An honor taught across all sessions can't also be in a single session, and
 * no honor is offered twice in the same session.
 */
export function offeringSlotConflict(candidate: OfferingSlot, existing: readonly OfferingSlot[]) {
  const sameHonor = existing.filter((offering) => offering.honorId === candidate.honorId);
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
