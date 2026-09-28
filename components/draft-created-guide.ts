/**
 * Pure logic and best-effort storage for the "Draft created" guide banner
 * (#473). Kept dependency-injected and side-effect-free where possible so it
 * is trivial to unit test without a DOM.
 */

export const draftCreatedGuideStorageKey = "imsda-events:draft-created-guide-dismissed";

// Bounds the remembered list so a staff account that has created hundreds of
// events over the years doesn't grow this value without limit.
const maxRememberedDismissals = 200;

export type DraftCreatedGuideStorageReader = Pick<Storage, "getItem">;
export type DraftCreatedGuideStorageWriter = Pick<Storage, "setItem">;

export function isDraftCreatedGuideDismissed(
  dismissedEventIds: readonly string[],
  eventId: string,
): boolean {
  return dismissedEventIds.includes(eventId);
}

/**
 * The banner shows only right after the create-event redirect
 * (`created=1`) and only until the event has been dismissed once. It never
 * reappears for that event on a later reload, even if `created=1` is still in
 * the URL (for example from a bookmarked or reopened tab).
 */
export function shouldShowDraftCreatedGuide(
  createdParam: string | null | undefined,
  eventId: string | null | undefined,
  dismissedEventIds: readonly string[],
): boolean {
  if (createdParam !== "1") return false;
  if (!eventId) return false;
  return !isDraftCreatedGuideDismissed(dismissedEventIds, eventId);
}

/** Returns a new array; never mutates `dismissedEventIds`. */
export function withDraftCreatedGuideDismissed(
  dismissedEventIds: readonly string[],
  eventId: string,
): string[] {
  if (isDraftCreatedGuideDismissed(dismissedEventIds, eventId)) {
    return [...dismissedEventIds];
  }
  const next = [...dismissedEventIds, eventId];
  return next.length > maxRememberedDismissals
    ? next.slice(next.length - maxRememberedDismissals)
    : next;
}

/**
 * Builds the URL to replace the current one with once the banner is
 * dismissed, stripping `created` while preserving every other query param
 * (notably `event`).
 */
export function urlWithoutCreatedParam(pathname: string, currentSearch: string): string {
  const params = new URLSearchParams(currentSearch);
  params.delete("created");
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function readDismissedDraftCreatedGuideEventIds(
  storage: DraftCreatedGuideStorageReader | undefined,
): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(draftCreatedGuideStorageKey);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    // Corrupt or inaccessible storage (private browsing, blocked site data,
    // …). The banner still works correctly for this load; it just may show
    // again for an event dismissed on a previous visit.
    return [];
  }
}

export function writeDismissedDraftCreatedGuideEventIds(
  storage: DraftCreatedGuideStorageWriter | undefined,
  dismissedEventIds: readonly string[],
): void {
  if (!storage) return;
  try {
    storage.setItem(draftCreatedGuideStorageKey, JSON.stringify(dismissedEventIds));
  } catch {
    // Best-effort only. Removing `created` from the URL on dismiss is what
    // actually keeps the banner from reappearing on a plain reload.
  }
}
