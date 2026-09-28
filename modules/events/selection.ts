import "server-only";

import { redirect } from "next/navigation";
import { getCurrentSession } from "@/modules/access/current-session";
import { eventPermissions, rolePermissions } from "@/modules/access/permissions";
import { selectEventContext } from "@/modules/events/context-selection";
import { readLastUsedEventId } from "@/modules/events/last-used-event";
import { findActiveMembership, listEventsForUser } from "@/modules/events/repository";

/**
 * Resolves which event the current request should see (#465 — Q1: a wrong or
 * missing event never silently opens a different event).
 *
 * - A requested event id that doesn't match one of this account's own events
 *   — whether it's missing, mistyped, deleted, or just not permitted — is
 *   never substituted with another event. The picker (`/select-event`) opens
 *   instead, with nothing distinguishing "doesn't exist" from "not yours".
 * - No id: the last-used-event cookie is used if it's still one of this
 *   account's events; otherwise the nearest published/open event; otherwise
 *   the picker. `autoSelected` tells the caller to show the "chosen for you"
 *   notice, since the account didn't ask for this specific event.
 *
 * The selection itself is `selectEventContext` (`context-selection.ts`),
 * pure and unit-tested on its own; this function only gathers what it needs
 * (the session, the account's events, the remembered event) and acts on the
 * result.
 */
export async function resolveEventContext(requestedEventId?: string) {
  const user = (await getCurrentSession()).user;
  if (!user) redirect("/login");
  const events = await listEventsForUser(user.id, user.globalRole === "SYSTEM_ADMIN");

  if (events.length === 0) {
    redirect("/no-access");
  }

  const lastUsedEventId = requestedEventId ? null : await readLastUsedEventId();
  const selection = selectEventContext({ events, requestedEventId, lastUsedEventId });

  if (selection.kind === "unavailable") {
    redirect("/select-event?unavailable=1");
  }
  if (selection.kind === "picker") {
    redirect("/select-event");
  }

  const event = selection.event;
  const membership = user.globalRole === "SYSTEM_ADMIN"
    ? null
    : await findActiveMembership(user.id, event.id);
  const permissions = user.globalRole === "SYSTEM_ADMIN"
    ? [...eventPermissions]
    : [...new Set([...(membership ? rolePermissions[membership.role] : []), ...(membership?.permissions ?? [])])];

  return {
    event,
    events,
    user,
    membership,
    permissions,
    /** True when this event wasn't the one requested — show the "chosen for you" notice. */
    autoSelected: selection.kind === "cookie" || selection.kind === "nearest",
  };
}
