type WithId = { id: string };

/**
 * The shell's current event (#616). The workspace layout does not re-render on
 * client navigation, so its `defaultEvent` can be stale after an in-page link
 * with no `?event=`. The shell therefore remembers the last valid event it saw
 * (`seenEvent`) and uses the layout default only when it has seen none.
 *
 * A `?event=` that matches nothing selects nothing, rather than quietly
 * showing another event.
 */
export function resolveShellEvent<T extends WithId>(input: {
  requestedEventId: string | null;
  events: readonly T[];
  seenEventId: string | null;
  defaultEventId: string | null;
}): T | undefined {
  const { requestedEventId, events, seenEventId, defaultEventId } = input;
  const byId = (id: string | null) => (id ? events.find((event) => event.id === id) : undefined);
  if (requestedEventId) return byId(requestedEventId);
  return byId(seenEventId) ?? byId(defaultEventId);
}

/**
 * Whether a valid `?event=` needs to be sent to the server as the remembered
 * event: only when it is a known event and differs from what was last
 * remembered (the layout default at first, then each id already sent).
 */
export function eventToRemember(input: {
  requestedEventId: string | null;
  knownEventIds: readonly string[];
  lastRememberedId: string | null;
}): string | null {
  const { requestedEventId, knownEventIds, lastRememberedId } = input;
  if (!requestedEventId || !knownEventIds.includes(requestedEventId)) return null;
  return requestedEventId === lastRememberedId ? null : requestedEventId;
}
