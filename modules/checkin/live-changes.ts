/**
 * Live check-in list (#825): other desk devices' check-ins and undos reach
 * this device through a small delta poll, not by reloading the roster.
 *
 * Pure and client-safe (no database import) so the server route and the
 * browser share one definition of the payload and of how it is applied.
 *
 * The payload is deliberately tiny for phones on a weak cellular link: one
 * `[attendeeId, checkedInAt | null]` pair per attendee whose state changed
 * recently, never names or form answers.
 */

/** How often a visible desk device asks for changes. */
export const LIVE_POLL_INTERVAL_MS = 5_000;
/** Longest wait after repeated failures. */
export const LIVE_POLL_MAX_BACKOFF_MS = 60_000;
/** Each poll re-asks for this much earlier than the last answer, so a commit that landed just after a previous read is never missed. Re-applying a change is harmless. */
export const LIVE_POLL_OVERLAP_MS = 15_000;
/** The most pairs one answer carries; a desk never changes this many in one overlap window. */
export const LIVE_CHANGES_LIMIT = 500;

export type LiveCheckInChange = readonly [attendeeId: string, checkedInAt: string | null];

export type LiveCheckInChanges = {
  /** The server's clock when the answer was read; the next poll starts from here. */
  now: string;
  changes: LiveCheckInChange[];
};

type ChangedRow = {
  registrationAttendeeId: string;
  checkedInAt: Date;
  undoneAt: Date | null;
};

/**
 * Collapses recently changed check-in rows to one final state per attendee:
 * the newest active row wins (checked in), otherwise the attendee is
 * checked out (null).
 */
export function collapseCheckInChanges(rows: readonly ChangedRow[]): LiveCheckInChange[] {
  const byAttendee = new Map<string, Date | null>();
  const sorted = [...rows].sort((left, right) => left.checkedInAt.getTime() - right.checkedInAt.getTime());
  for (const row of sorted) {
    if (row.undoneAt === null) {
      byAttendee.set(row.registrationAttendeeId, row.checkedInAt);
    } else if (!byAttendee.has(row.registrationAttendeeId)) {
      byAttendee.set(row.registrationAttendeeId, null);
    }
  }
  return [...byAttendee].map(([attendeeId, at]) => [attendeeId, at ? at.toISOString() : null] as const);
}

/** The `since` cursor for the next poll, from the last answer's server clock (or the page's render time). */
export function nextLiveSince(serverNow: string) {
  const parsed = Date.parse(serverNow);
  return Number.isNaN(parsed) ? null : new Date(parsed - LIVE_POLL_OVERLAP_MS).toISOString();
}

/** Parses a server answer defensively; anything unexpected is ignored rather than trusted. */
export function parseLiveCheckInChanges(value: unknown): LiveCheckInChanges | null {
  if (!value || typeof value !== "object") return null;
  const { now, changes } = value as { now?: unknown; changes?: unknown };
  if (typeof now !== "string" || Number.isNaN(Date.parse(now)) || !Array.isArray(changes)) return null;
  const parsed: LiveCheckInChange[] = [];
  for (const change of changes) {
    if (
      Array.isArray(change)
      && change.length === 2
      && typeof change[0] === "string"
      && (change[1] === null || (typeof change[1] === "string" && !Number.isNaN(Date.parse(change[1]))))
    ) {
      parsed.push([change[0], change[1]] as const);
    }
  }
  return { now, changes: parsed };
}

/**
 * Applies changes to the roster. Attendees this device is acting on right now
 * (`skip`) are left alone, so a poll that was already in flight cannot flip a
 * row back under the finger that just tapped it. Returns the same array when
 * nothing differs, so React does not re-render for a quiet poll.
 */
export function applyLiveCheckInChanges<T extends { id: string; checkedIn: boolean; checkedInAt: string | null }>(
  arrivals: readonly T[],
  changes: readonly LiveCheckInChange[],
  skip: ReadonlySet<string> = new Set(),
): readonly T[] {
  if (changes.length === 0) return arrivals;
  const byId = new Map(changes.filter(([id]) => !skip.has(id)));
  let changed = false;
  const next = arrivals.map((arrival) => {
    if (!byId.has(arrival.id)) return arrival;
    const checkedInAt = byId.get(arrival.id) ?? null;
    const checkedIn = checkedInAt !== null;
    if (arrival.checkedIn === checkedIn && arrival.checkedInAt === checkedInAt) return arrival;
    changed = true;
    return { ...arrival, checkedIn, checkedInAt };
  });
  return changed ? next : arrivals;
}

/** The delay before the next poll: steady while healthy, doubling (to a cap) while failing. */
export function nextLivePollDelay(consecutiveFailures: number) {
  if (consecutiveFailures <= 0) return LIVE_POLL_INTERVAL_MS;
  return Math.min(LIVE_POLL_MAX_BACKOFF_MS, LIVE_POLL_INTERVAL_MS * 2 ** consecutiveFailures);
}

/** "Already checked in at 2:04 PM by Dana." */
export function alreadyCheckedInMessage(checkedInAt: string, checkedInBy: string | null | undefined, locale?: string) {
  const time = new Date(checkedInAt).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  return `Already checked in at ${time}${checkedInBy ? ` by ${checkedInBy}` : ""}.`;
}
