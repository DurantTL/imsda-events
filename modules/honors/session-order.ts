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

export const inactiveSessionWarning =
  "No active classes — directors will see this session but can't pick anything.";

/**
 * Which warning a session needs, if any. Directors only see a session that has
 * at least one active class; a session whose classes are all inactive is
 * listed but offers nothing to pick.
 */
export function sessionClassWarning(session: { offeringCount: number; activeOfferingCount: number }) {
  if (session.offeringCount === 0) return emptySessionWarning;
  if (session.activeOfferingCount === 0) return inactiveSessionWarning;
  return null;
}

export const MAX_SESSION_ORDER = 99;

/** Default "Order" for a new session: after the last one, or the lowest unused value once 99 is taken. */
export function nextSessionOrder(sessions: readonly { sortOrder: number }[]) {
  if (sessions.length === 0) return 0;
  const max = Math.max(...sessions.map((session) => session.sortOrder));
  if (max < MAX_SESSION_ORDER) return max + 1;
  const used = new Set(sessions.map((session) => session.sortOrder));
  for (let order = 0; order <= MAX_SESSION_ORDER; order += 1) if (!used.has(order)) return order;
  return MAX_SESSION_ORDER;
}
