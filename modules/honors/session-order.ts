/**
 * Honors sessions render in the order the administrator saved (`sortOrder`,
 * ascending). Sessions that share a `sortOrder` (the column defaults to 0, so
 * a site whose sessions were all added without an order ties everywhere) keep
 * the order they were created in instead of falling back to alphabetical,
 * which put "Sabbath Afternoon" above "Morning" (#570). The repositories sort
 * in the database with the same keys; this is the shared, client-safe
 * comparator so a screen never depends on query order.
 */
export type OrderableHonorSession = { sortOrder: number; createdAt?: Date | string | null };

const time = (value: Date | string | null | undefined) => (value == null ? 0 : new Date(value).getTime());

export function compareHonorSessions(a: OrderableHonorSession, b: OrderableHonorSession) {
  return a.sortOrder - b.sortOrder || time(a.createdAt) - time(b.createdAt);
}

/** Stable: sessions the comparator cannot separate keep their incoming (database) order. */
export function sortHonorSessions<T extends OrderableHonorSession>(sessions: readonly T[]): T[] {
  return [...sessions].sort(compareHonorSessions);
}

export const emptySessionWarning =
  "No classes yet — this session will be hidden from directors until you add one.";
