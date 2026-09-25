import "server-only";

import type { GlobalRole } from "@prisma/client";
import { resolveLoginDestination } from "@/modules/access/login-routing";
import { readLastUsedEventId } from "@/modules/events/last-used-event";
import { listEventsForUser } from "@/modules/events/repository";

/**
 * Gathers what `resolveLoginDestination` needs (the account's active events
 * and its remembered event) and applies it. Split from the pure function so
 * the routing decision itself stays testable without a database or cookies
 * (#108 queue 1).
 */
export async function resolvePostLoginDestination(
  user: { id: string; globalRole?: GlobalRole | null },
  options: { returnTo?: string | null } = {},
): Promise<string> {
  const isSystemAdmin = user.globalRole === "SYSTEM_ADMIN";
  const [events, lastEventId] = await Promise.all([
    isSystemAdmin ? Promise.resolve([]) : listEventsForUser(user.id, false),
    isSystemAdmin ? Promise.resolve(null) : readLastUsedEventId(),
  ]);

  return resolveLoginDestination({
    isSystemAdmin,
    events,
    lastEventId,
    returnTo: options.returnTo,
  });
}
