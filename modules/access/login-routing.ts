import { safeReturnTo } from "@/lib/return-to";

export type LoginRoutingEvent = { id: string };

export type LoginRoutingInput = {
  /** Whether the signed-in account is a system administrator. */
  isSystemAdmin: boolean;
  /**
   * The staff account's active event memberships. Ignored when
   * `isSystemAdmin` is true.
   */
  events: readonly LoginRoutingEvent[];
  /**
   * The event remembered from a previous visit (the `imsda-last-event`
   * cookie), if any. Only used when it is still one of `events`.
   */
  lastEventId?: string | null;
  /**
   * An unvalidated `next`/`returnTo` value carried by the login request, if
   * any — for example a deep link that bounced to `/login`. Validated here
   * with `safeReturnTo` before it can override role routing.
   */
  returnTo?: string | null;
};

export const SYSTEM_ADMIN_PATH = "/admin";
export const NO_EVENTS_PATH = "/no-access";
export const EVENT_PICKER_PATH = "/select-event";
/**
 * Where sign-in lands when role routing itself fails after the session is
 * already issued — the pre-#108 destination, whose workspace layout picks an
 * event on its own.
 */
export const DEFAULT_POST_LOGIN_DESTINATION = "/overview";

/**
 * Decides where a signed-in staff account lands after `/login` (#108 queue
 * 1: unified login entry and role-aware dashboard routing).
 *
 * Pure and side-effect-free — no cookies, no database, no Next.js request
 * APIs — so the decision itself is unit-testable on its own. Callers gather
 * `events` and `lastEventId` (see `modules/events/repository.ts` and
 * `modules/events/last-used-event.ts`) and pass them in.
 *
 * Order of decisions:
 * 1. A validated `returnTo` target always wins — it is what brought the
 *    person to `/login` in the first place, and applies regardless of role.
 * 2. A system administrator always goes to the System Command Center.
 * 3. No active event membership: the safe no-access page, never an error.
 * 4. Exactly one active event: straight to that event's workspace, the same
 *    `?event=` URL the event switcher uses.
 * 5. Several: the remembered event, if it is still one of the account's
 *    active events; otherwise the event picker.
 */
export function resolveLoginDestination(input: LoginRoutingInput): string {
  const returnTo = safeReturnTo(input.returnTo ?? undefined, "");
  if (returnTo) return returnTo;

  if (input.isSystemAdmin) return SYSTEM_ADMIN_PATH;

  const { events, lastEventId } = input;
  if (events.length === 0) return NO_EVENTS_PATH;
  if (events.length === 1) return eventWorkspacePath(events[0].id);

  const lastEvent = lastEventId
    ? events.find((event) => event.id === lastEventId)
    : undefined;
  if (lastEvent) return eventWorkspacePath(lastEvent.id);

  return EVENT_PICKER_PATH;
}

function eventWorkspacePath(eventId: string): string {
  return `/overview?event=${encodeURIComponent(eventId)}`;
}
