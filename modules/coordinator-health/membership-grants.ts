import "server-only";

import { randomUUID } from "node:crypto";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";

/**
 * Grants or removes VIEW_HEALTH_INFORMATION on one event membership (#658).
 * Callers must already have established that the actor is a system
 * administrator. Every change is audited (who, whom, which event), and an
 * unchanged state writes nothing.
 */
export class HealthAccessGrantError extends Error {
  constructor(public readonly code: "MEMBERSHIP_NOT_FOUND", message: string) {
    super(message);
    this.name = "HealthAccessGrantError";
  }
}

export async function setHealthAccess(eventId: string, membershipId: string, actorUserId: string, granted: boolean) {
  return getPrisma().$transaction(async (tx) => {
    const membership = await tx.eventMembership.findFirst({
      where: { id: membershipId, eventId },
      select: { id: true, userId: true, permissions: true, user: { select: { displayName: true } } },
    });
    if (!membership) throw new HealthAccessGrantError("MEMBERSHIP_NOT_FOUND", "That staff assignment no longer exists.");
    const has = membership.permissions.includes("VIEW_HEALTH_INFORMATION");
    if (has === granted) return { granted, changed: false };
    const permissions = granted
      ? [...membership.permissions, "VIEW_HEALTH_INFORMATION" as const]
      : membership.permissions.filter((permission) => permission !== "VIEW_HEALTH_INFORMATION");
    await tx.eventMembership.update({ where: { id: membership.id }, data: { permissions } });
    await writeAuditLog({
      eventId,
      actorUserId,
      action: granted ? "HEALTH_ACCESS_GRANTED" : "HEALTH_ACCESS_REVOKED",
      entityType: "EventMembership",
      entityId: membership.id,
      correlationId: randomUUID(),
      summary: granted
        ? `${membership.user.displayName} was given health information access.`
        : `${membership.user.displayName} no longer has health information access.`,
      metadata: { userId: membership.userId, permission: "VIEW_HEALTH_INFORMATION" },
    }, tx);
    return { granted, changed: true };
  });
}
