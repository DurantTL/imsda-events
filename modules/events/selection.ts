import "server-only";

import { staffLoginRedirectPath } from "@/modules/access/login-redirect";
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
  const { user, events } = await loadSignedInEvents();
  const isSystemAdmin = user.globalRole === "SYSTEM_ADMIN";

  const lastUsedEventId = requestedEventId ? null : await readLastUsedEventId();
  const selection = selectEventContext({ events, requestedEventId, lastUsedEventId });

  // System administrators can't use /select-event (it sends them to /admin,
  // their home, which lists every event and renders without one), so they
  // go straight to /admin instead — a direct hop, never a loop.
  if (selection.kind === "unavailable") {
    redirect(isSystemAdmin ? "/admin?unavailable=1" : "/select-event?unavailable=1");
  }
  if (selection.kind === "picker") {
    redirect(isSystemAdmin ? "/admin" : "/select-event");
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

async function loadSignedInEvents(options: { allowNoEvents?: boolean } = {}) {
  const user = (await getCurrentSession()).user;
  if (!user) redirect(await staffLoginRedirectPath());
  const events = await listEventsForUser(user.id, user.globalRole === "SYSTEM_ADMIN");

  // A system administrator with zero events still owns the global /admin/*
  // pages (#567 F-6), which need no event. Only the workspace layout opts in;
  // pages that need an event still resolve (and redirect) on their own.
  if (events.length === 0 && !(options.allowNoEvents && user.globalRole === "SYSTEM_ADMIN")) {
    redirect("/no-access");
  }
  return { user, events };
}

/**
 * What the `(workspace)` layout needs for the shell: the signed-in account,
 * its events, and the event a page with no `?event=` will show (#465).
 *
 * Unlike `resolveEventContext`, this never redirects for event selection —
 * a layout can't see the page's `?event=` and wraps `/admin` too, so
 * redirecting here would bounce valid deep links and loop admins between
 * `/admin` and the picker. Pages still resolve (and redirect) on their own.
 *
 * The default comes from the same `selectEventContext` call a page with no
 * `?event=` makes, so the shell's switcher, nav links and "chosen for you"
 * notice agree with what the page renders. `defaultEventId` is `null` when
 * nothing can be chosen automatically (the picker case).
 */
export async function loadWorkspaceEventContext() {
  const { user, events } = await loadSignedInEvents({ allowNoEvents: true });
  const selection = selectEventContext({ events, lastUsedEventId: await readLastUsedEventId() });
  const defaultEvent = selection.kind === "picker" || selection.kind === "unavailable" ? null : selection.event;

  return {
    user,
    events,
    defaultEventId: defaultEvent?.id ?? null,
    /** True when the default was chosen automatically — the shell shows the notice. */
    autoSelected: selection.kind === "cookie" || selection.kind === "nearest",
  };
}
