import "server-only";

import type { GlobalRole } from "@prisma/client";
import { listActiveEventPermissionsForUser } from "@/modules/access/membership-repository";
import { readLastUsedEventId } from "@/modules/events/last-used-event";
import { listEventsForUser } from "@/modules/events/repository";

export type CheckInEventCandidate = {
  id: string;
  endsAt: Date;
  /** Whether the account holds MANAGE_CHECK_IN on this event. */
  canCheckIn: boolean;
};

/**
 * Picks which event a bare `/check-in` (no `?event=`) should open (#470).
 * Pure, so the choice is testable without a database or cookies.
 *
 * Only events where the account can actually check people in qualify. Among
 * those: the remembered event if it is one, otherwise the nearest event that
 * hasn't ended yet (candidates arrive in start order), otherwise the most
 * recent past one. Returns null when no event qualifies, so the caller shows
 * the restricted page rather than guessing.
 */
export function chooseCheckInEventId(
  candidates: readonly CheckInEventCandidate[],
  lastEventId: string | null,
  now: Date = new Date(),
): string | null {
  const eligible = candidates.filter((candidate) => candidate.canCheckIn);
  if (eligible.length === 0) return null;
  const remembered = lastEventId ? eligible.find((candidate) => candidate.id === lastEventId) : undefined;
  if (remembered) return remembered.id;
  const current = eligible.find((candidate) => candidate.endsAt.getTime() >= now.getTime());
  return (current ?? eligible[eligible.length - 1]).id;
}

/**
 * Gathers the signed-in account's events, its MANAGE_CHECK_IN grants, and
 * the remembered event, then applies `chooseCheckInEventId`. The result is
 * only a default for the URL: the check-in page still authorizes the chosen
 * event itself through `resolveEventContext`.
 */
export async function findDefaultCheckInEventId(
  user: { id: string; globalRole?: GlobalRole | null },
): Promise<string | null> {
  const isSystemAdmin = user.globalRole === "SYSTEM_ADMIN";
  const [events, lastEventId] = await Promise.all([
    listEventsForUser(user.id, isSystemAdmin),
    readLastUsedEventId(),
  ]);
  if (events.length === 0) return null;
  const permissionsByEvent = isSystemAdmin
    ? null
    : await listActiveEventPermissionsForUser(user.id, events.map((event) => event.id));
  return chooseCheckInEventId(
    events.map((event) => ({
      id: event.id,
      endsAt: event.endsAt,
      canCheckIn: isSystemAdmin || (permissionsByEvent?.get(event.id) ?? []).includes("MANAGE_CHECK_IN"),
    })),
    lastEventId,
  );
}
