/**
 * Restoring the location a director picked before reloading (#659). The draft
 * keeps only the location id and reserves no seats, so on restore each
 * location is checked again: one that is now closed, full, or removed is
 * explained instead of silently replaced.
 */
export type DraftLocationOption = {
  id: string;
  name: string;
  full: boolean;
  waitlistOnFull?: boolean;
  open: boolean;
  phase?: string;
  isActive?: boolean;
};

export function isPickableLocation(location: DraftLocationOption) {
  return location.isActive !== false && location.open && (!location.full || Boolean(location.waitlistOnFull));
}

export function restoreDraftLocation(
  locations: readonly DraftLocationOption[],
  savedId: string | null | undefined,
): { locationId: string | null; note: string | null } {
  const pickable = locations.filter(isPickableLocation);
  // With one choice there is nothing to decide, so it is picked for the director.
  const fallback = pickable.length === 1 ? pickable[0]!.id : null;
  if (locations.length === 0 || !savedId) return { locationId: fallback, note: null };
  const saved = locations.find((location) => location.id === savedId);
  if (!saved) {
    return { locationId: fallback, note: "The location you chose earlier is no longer offered. Choose a location to continue." };
  }
  if (isPickableLocation(saved)) return { locationId: saved.id, note: null };
  const reason = saved.full
    ? "is now full"
    : saved.phase === "UPCOMING" ? "is not open for registration yet" : "is now closed for registration";
  return { locationId: fallback, note: `${saved.name} ${reason}. Choose another location to continue.` };
}
