import type { Prisma } from "@prisma/client";

/**
 * Locks one event membership row for the rest of the caller's transaction and returns its permissions as
 * they are now (null when the row is gone). Every grant and strip of a permission on a membership reads,
 * changes and writes the array, so two of them at once (a health grant and an invoice-finalization strip)
 * must take turns or the later write resurrects what the earlier one removed.
 */
export async function lockMembershipPermissions(tx: Prisma.TransactionClient, membershipId: string): Promise<string[] | null> {
  const rows = await tx.$queryRaw<Array<{ permissions: string[] }>>`
    SELECT "permissions"::text[] AS "permissions" FROM "EventMembership" WHERE "id" = ${membershipId} FOR UPDATE`;
  return rows[0]?.permissions ?? null;
}
