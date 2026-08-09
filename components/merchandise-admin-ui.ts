export type MerchandiseAdminStatus = "enabled" | "disabled" | "archived" | "scheduled";

export function merchandiseAdminStatus(input: { isEnabled: boolean; isArchived?: boolean; startsAt?: string | null; endsAt?: string | null; now?: Date }) {
  if (input.isArchived) return "archived" as const;
  if (!input.isEnabled) return "disabled" as const;
  const now = input.now ?? new Date();
  if (input.startsAt && new Date(input.startsAt) > now) return "scheduled" as const;
  if (input.endsAt && new Date(input.endsAt) < now) return "disabled" as const;
  return "enabled" as const;
}

export function formatMerchandiseMoney(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

export function merchandiseEndpoint(eventId: string, suffix = "") {
  return `/api/events/${encodeURIComponent(eventId)}/merchandise${suffix}`;
}

export function assetEndpoint(eventId: string, suffix = "") {
  return `/api/events/${encodeURIComponent(eventId)}/assets${suffix}`;
}

/** The URL the staff member's own browser can load inline for a preview
 * thumbnail. The safe preview DTO only carries an assetId, never a URL. */
export function artworkPreviewUrl(eventId: string, assetId: string) {
  return assetEndpoint(eventId, `/${encodeURIComponent(assetId)}?disposition=inline`);
}

/** A `datetime-local` input has no timezone of its own; the browser value is
 * interpreted (and round-tripped) as the staff member's local time. */
export function toIsoOrNull(localValue: string) {
  const trimmed = localValue.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export type PositionedItem = { id: string; position?: number };

/**
 * Computes the minimal set of position writes needed to move `id` one step
 * in `direction` within `items`' current display order (position ascending,
 * with ties broken by each item's existing array order — the same order the
 * server returns via `position asc, createdAt asc`). Newly created rows can
 * all share position 0, so a plain two-item position swap is a no-op once
 * more than two items are tied; resequencing the whole run to unique,
 * sequential positions in the same pass guarantees the move is never
 * silently swallowed by a tie. Only items whose position actually changes
 * are returned, so an already-sequenced list still produces exactly the two
 * writes a simple swap would have.
 */
export function resequenceAfterMove(items: PositionedItem[], id: string, direction: -1 | 1) {
  const ordered = [...items].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const index = ordered.findIndex((item) => item.id === id);
  const swapIndex = index + direction;
  if (index < 0 || swapIndex < 0 || swapIndex >= ordered.length) return null;
  [ordered[index], ordered[swapIndex]] = [ordered[swapIndex], ordered[index]];
  return ordered
    .map((item, position) => ({ id: item.id, position, dirty: (item.position ?? 0) !== position }))
    .filter((entry) => entry.dirty)
    .map(({ id: itemId, position }) => ({ id: itemId, position }));
}

export function toLocalInputValue(iso?: string | null) {
  if (!iso) return "";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}
