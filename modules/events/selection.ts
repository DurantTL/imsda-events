import "server-only";

import { redirect } from "next/navigation";
import { getCurrentSession } from "@/modules/access/current-session";
import { eventPermissions, rolePermissions } from "@/modules/access/permissions";
import { findActiveMembership, listEventsForUser } from "@/modules/events/repository";

export async function resolveEventContext(requestedEventId?: string) {
  const user = (await getCurrentSession()).user;
  if (!user) redirect("/login");
  const events = await listEventsForUser(user.id, user.globalRole === "SYSTEM_ADMIN");

  if (events.length === 0) {
    redirect("/no-access");
  }

  const event = events.find((candidate) => candidate.id === requestedEventId) ?? events[0];
  const membership = user.globalRole === "SYSTEM_ADMIN"
    ? null
    : await findActiveMembership(user.id, event.id);
  const permissions = user.globalRole === "SYSTEM_ADMIN"
    ? [...eventPermissions]
    : [...new Set([...(membership ? rolePermissions[membership.role] : []), ...(membership?.permissions ?? [])])];

  return { event, events, user, membership, permissions };
}
