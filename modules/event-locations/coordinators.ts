import "server-only";

import type { Prisma } from "@prisma/client";
import { coordinatorGrantActive } from "@/modules/event-locations/domain";

type Db = Pick<Prisma.TransactionClient, "attendeeAccount">;

/**
 * Of these attendee accounts, the ones that are enabled and hold an active
 * Area Coordinator grant right now. Cloning an event or applying a template
 * carries a location's coordinator only when they are in this set (#599).
 */
export async function activeCoordinatorAccountIds(
  db: Db,
  accountIds: readonly (string | null | undefined)[],
  now = new Date(),
) {
  const ids = [...new Set(accountIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return new Set<string>();
  const accounts = await db.attendeeAccount.findMany({
    where: { id: { in: ids }, disabledAt: null },
    select: { id: true, areaCoordinatorGrant: { select: { revokedAt: true, expiresAt: true } } },
  });
  return new Set(accounts.filter((account) => coordinatorGrantActive(account.areaCoordinatorGrant, now)).map((account) => account.id));
}
