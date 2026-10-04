import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { lockMembershipPermissions } from "@/modules/access/membership-lock";
import { writeAuditLog } from "@/modules/audit/audit-service";

/**
 * Grants or removes VIEW_HEALTH_INFORMATION on one event membership (#658).
 * Callers must already have established that the actor is a system
 * administrator. Every change is audited (who, whom, which event), and an
 * unchanged state writes nothing.
 */
export class HealthAccessGrantError extends Error {
  constructor(public readonly code: "MEMBERSHIP_NOT_FOUND" | "TARGET_IS_SYSTEM_ADMIN", message: string) {
    super(message);
    this.name = "HealthAccessGrantError";
  }
}

type Tx = Prisma.TransactionClient;

/**
 * A change of health access must not be carried by a session that predates it,
 * so the user's next sign-in has to pass two-step again (same as `setGlobalRole`).
 */
async function endUserSessions(tx: Tx, userId: string) {
  await tx.userSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
}

/**
 * Removes VIEW_HEALTH_INFORMATION from a membership inside the caller's
 * transaction (#658): used when a membership is deactivated, re-added, or its
 * role changes, so health access never survives those. Ends the user's sessions
 * and audits the revoke. Returns whether anything was removed.
 */
export async function stripHealthAccess(
  tx: Tx,
  membership: { id: string; userId: string; permissions: readonly string[]; eventId: string },
  actorUserId: string,
  reason: "DEACTIVATED" | "REACTIVATED" | "RE_ADDED" | "ROLE_CHANGED",
) {
  if (!membership.permissions.includes("VIEW_HEALTH_INFORMATION")) return false;
  // Lock the row and work from its permissions now: a concurrent grant or strip of another permission must not be undone.
  const current = await lockMembershipPermissions(tx, membership.id);
  if (!current?.includes("VIEW_HEALTH_INFORMATION")) return false;
  await tx.eventMembership.update({
    where: { id: membership.id },
    data: { permissions: current.filter((permission) => permission !== "VIEW_HEALTH_INFORMATION") as never },
  });
  await endUserSessions(tx, membership.userId);
  await writeAuditLog({
    eventId: membership.eventId,
    actorUserId,
    action: "HEALTH_ACCESS_REVOKED",
    entityType: "EventMembership",
    entityId: membership.id,
    correlationId: randomUUID(),
    summary: "Health information access was removed because the staff assignment changed.",
    metadata: { userId: membership.userId, permission: "VIEW_HEALTH_INFORMATION", reason },
  }, tx);
  return true;
}

export async function setHealthAccess(eventId: string, membershipId: string, actorUserId: string, granted: boolean) {
  return getPrisma().$transaction(async (tx) => {
    const membership = await tx.eventMembership.findFirst({
      where: { id: membershipId, eventId },
      select: { id: true, userId: true, permissions: true, user: { select: { displayName: true, globalRole: true } } },
    });
    if (!membership) throw new HealthAccessGrantError("MEMBERSHIP_NOT_FOUND", "That staff assignment no longer exists.");
    // System administrators already have access everywhere: a grant on their row would only mislead.
    if (membership.user.globalRole === "SYSTEM_ADMIN") {
      throw new HealthAccessGrantError("TARGET_IS_SYSTEM_ADMIN", "System administrators already have health information access.");
    }
    // Lock the row and work from its permissions now, so a concurrent change to another permission is not undone.
    const held = (await lockMembershipPermissions(tx, membership.id)) ?? membership.permissions;
    const has = held.includes("VIEW_HEALTH_INFORMATION");
    if (has === granted) return { granted, changed: false };
    const permissions = (granted
      ? [...held, "VIEW_HEALTH_INFORMATION"]
      : held.filter((permission) => permission !== "VIEW_HEALTH_INFORMATION")) as never;
    await tx.eventMembership.update({ where: { id: membership.id }, data: { permissions } });
    await endUserSessions(tx, membership.userId);
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
