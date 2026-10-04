import type { Prisma } from "@prisma/client";

export type LockedMembership = { role: string; status: string; permissions: string[] };

/**
 * Locks one event membership row for the rest of the caller's transaction and returns its role, status and
 * permissions as they are now (null when the row is gone). Every grant and strip of a permission on a
 * membership reads, changes and writes the array, so two of them at once (a health grant and an
 * invoice-finalization strip) must take turns or the later write resurrects what the earlier one removed.
 * Eligibility checks and strip decisions must be made from these locked values, never from a read made
 * before the lock.
 */
export async function lockMembershipPermissions(tx: Prisma.TransactionClient, membershipId: string): Promise<LockedMembership | null> {
  const rows = await tx.$queryRaw<LockedMembership[]>`
    SELECT "role"::text AS "role", "status"::text AS "status", "permissions"::text[] AS "permissions"
    FROM "EventMembership" WHERE "id" = ${membershipId} FOR UPDATE`;
  return rows[0] ?? null;
}
