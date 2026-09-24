import "server-only";

import {
  AccessDeniedError,
  effectivePermissions,
  requireEventMembership,
  type MembershipLookup,
  type Session,
} from "@/modules/access/authorization";
import { resolveClubOversight } from "@/modules/club-rosters/event-oversight";
import { resolveEventContext } from "@/modules/events/selection";
import { getPrisma } from "@/lib/prisma";

/**
 * Who may view the Camporee club reports and print a staff-side club packet
 * (Q1, #411): staff with `VIEW_REPORTS` on this event, or a Pathfinder event
 * manager's view-only oversight of this exact club event (#387). Directors
 * get their own club's packet through a separate, roster-access-gated path
 * (`director-packet.ts`) — never through this function.
 */
export async function resolveClubReportsAccess(requestedEventId?: string) {
  const context = await resolveEventContext(requestedEventId);
  if (context.permissions.includes("VIEW_REPORTS")) {
    return { ...context, allowed: true as const, readOnly: false as const };
  }
  const oversight = await resolveClubOversight(context.event.id);
  return { ...context, allowed: oversight.allowed, readOnly: true as const };
}

export function canViewClubReports(permissions: readonly string[]) {
  return permissions.includes("VIEW_REPORTS");
}

/**
 * Session-level equivalent of `resolveClubReportsAccess`, for API routes
 * (CSV downloads, the staff club-pass QR image) that must not redirect on a
 * missing session. Grants access to `VIEW_REPORTS` holders, or to a
 * Pathfinder event manager (#387: an event administrator on this exact club,
 * church-billed event) — the same two audiences the reports page allows.
 */
export async function requireClubReportsAccess(
  session: Session,
  eventId: string,
  lookup: MembershipLookup,
) {
  const access = await requireEventMembership(session, eventId, lookup);
  const permissions = effectivePermissions(access.user, access.membership);
  if (permissions.includes("VIEW_REPORTS")) return { ...access, permissions };

  const isEventAdmin = access.user.globalRole === "SYSTEM_ADMIN" || access.membership?.role === "EVENT_ADMIN";
  if (isEventAdmin) {
    const event = await getPrisma().event.findUnique({ where: { id: eventId }, select: { billingMode: true } });
    if (event?.billingMode === "DEFERRED_ORGANIZATION_INVOICE") return { ...access, permissions };
  }
  throw new AccessDeniedError(
    "Report access, or Pathfinder event-manager oversight of this club event, is required.",
    403,
    "PERMISSION_DENIED",
  );
}
