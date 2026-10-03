import { hasEventEnded } from "@/modules/events/lifecycle";

/** Post-event features (Event patches, Club assignments, Honors follow-up) stay in the launcher this long after an event ends. */
export const MODULE_STATE_AFTER_EVENT_DAYS = 60;

type ScopeEvent = { id: string; timezone: string; endsAt: Date | null; lastDay?: string | null };

/**
 * The events the staff shell loads module state for (#741): events that have not
 * ended, events that ended within the last 60 days, and the default or selected
 * event whatever its date (picking an old event refreshes the layout with that
 * event as the default). Any other event gets a launcher with the universal tools
 * only and the link to the Event modules page. Relevance only: it grants nothing.
 */
export function eventsNeedingModuleState(events: readonly ScopeEvent[], selectedEventId: string | null, now = new Date()): string[] {
  const cutoff = now.getTime() - MODULE_STATE_AFTER_EVENT_DAYS * 24 * 60 * 60 * 1000;
  return events
    .filter((event) => event.id === selectedEventId
      || !hasEventEnded(event, now)
      || (event.endsAt !== null && event.endsAt.getTime() >= cutoff))
    .map((event) => event.id);
}
