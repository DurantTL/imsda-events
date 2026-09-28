import {
  evaluateEventRegistrationPhase,
  type EventLifecycleSource,
} from "@/modules/events/lifecycle";

/**
 * What `selectEventContext` needs about each event the signed-in account may
 * open. A subset of `listEventsForUser`'s result — deliberately just the
 * fields the decision itself depends on, so it stays pure and easy to test.
 */
export type EventSelectionCandidate = EventLifecycleSource & {
  id: string;
  startsAt: Date;
};

export type EventContextSelection<T extends EventSelectionCandidate> =
  /** The requested id matched one of the account's own events. */
  | { kind: "requested"; event: T }
  /** No id was requested; the last-used-event cookie still matched one. */
  | { kind: "cookie"; event: T }
  /** No id, no usable cookie; the nearest published/open event was used. */
  | { kind: "nearest"; event: T }
  /** No id; this is the account's only event, so there is nothing to pick. */
  | { kind: "only"; event: T }
  /**
   * An id was requested but it doesn't match any event this account may
   * open — whether the event doesn't exist or the account just isn't
   * permitted on it. The two look identical on purpose: never leak which.
   */
  | { kind: "unavailable" }
  /** No id, and nothing could be chosen automatically: show the picker. */
  | { kind: "picker" };

/**
 * Decides which event a page should show (#465 — Q1: a wrong or missing
 * event never silently opens a different event).
 *
 * Pure and side-effect-free, like `resolveLoginDestination` in
 * `modules/access/login-routing.ts`: no cookies, no database, no redirects,
 * so the decision is unit-testable on its own. `resolveEventContext` in
 * `selection.ts` gathers the inputs and acts on the result.
 *
 * Rules:
 * - A requested event id that isn't one of `events` is always `unavailable`,
 *   never another event — regardless of how many events the account has.
 * - With no requested id: the account's only event needs no picking
 *   (`only`); otherwise the remembered event wins if it is still one of
 *   `events` (`cookie`); otherwise the nearest published/open event
 *   (`nearest`); otherwise the picker.
 */
export function selectEventContext<T extends EventSelectionCandidate>(input: {
  events: readonly T[];
  requestedEventId?: string | null;
  lastUsedEventId?: string | null;
  now?: Date;
}): EventContextSelection<T> {
  const { events, requestedEventId, lastUsedEventId, now = new Date() } = input;

  if (requestedEventId) {
    const requested = events.find((event) => event.id === requestedEventId);
    return requested ? { kind: "requested", event: requested } : { kind: "unavailable" };
  }

  if (events.length === 1) {
    return { kind: "only", event: events[0] };
  }

  if (lastUsedEventId) {
    const remembered = events.find((event) => event.id === lastUsedEventId);
    if (remembered) return { kind: "cookie", event: remembered };
  }

  const nearest = nearestPublishedOrOpenEvent(events, now);
  return nearest ? { kind: "nearest", event: nearest } : { kind: "picker" };
}

/**
 * Among published events, prefers one currently open for registration; falls
 * back to any published event (including a not-yet-open or already-closed
 * one) rather than a draft. Either way, "nearest" means the smallest
 * difference between `now` and the event's start date. Returns `null` when
 * every event is an unpublished draft, so the caller shows the picker
 * instead of guessing.
 */
function nearestPublishedOrOpenEvent<T extends EventSelectionCandidate>(
  events: readonly T[],
  now: Date,
): T | null {
  const published = events.filter((event) => event.isPublished);
  if (published.length === 0) return null;

  const open = published.filter((event) => evaluateEventRegistrationPhase(event, now) === "OPEN");
  const pool = open.length > 0 ? open : published;

  return pool.reduce((closest, candidate) =>
    distanceFromNow(candidate, now) < distanceFromNow(closest, now) ? candidate : closest
  );
}

function distanceFromNow(event: EventSelectionCandidate, now: Date): number {
  return Math.abs(event.startsAt.getTime() - now.getTime());
}
