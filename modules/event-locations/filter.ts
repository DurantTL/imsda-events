import "server-only";

import { getPrisma } from "@/lib/prisma";

export type LocationFilterOption = { id: string; name: string; isActive: boolean };

/**
 * The location filter staff views share (#413): "All locations" (`null`) plus
 * each location of the event. A `?location=` value that isn't one of this
 * event's locations falls back to all, so a stale link never hides everyone.
 * `locations` is empty for an event without locations, and the views show no
 * filter at all then.
 */
export async function resolveLocationFilter(eventId: string, requested: string | null | undefined) {
  const locations: LocationFilterOption[] = await getPrisma().eventLocation.findMany({
    where: { eventId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { name: "asc" }],
    select: { id: true, name: true, isActive: true },
  });
  const selected = locations.find((location) => location.id === requested) ?? null;
  return { locations, locationId: selected?.id ?? null, selected };
}

/** Reads `?location=` from a request URL; never throws. */
export function locationParam(request: Request) {
  return new URL(request.url).searchParams.get("location");
}
