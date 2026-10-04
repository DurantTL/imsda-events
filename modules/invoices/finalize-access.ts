import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { lockMembershipPermissions } from "@/modules/access/membership-lock";
import { rolePermissions } from "@/modules/access/permissions";
import { writeAuditLog } from "@/modules/audit/audit-service";

/**
 * Grants or removes FINALIZE_INVOICES on one event membership (#167, ADR 0008; Caleb Oct 4, 2026: a
 * dedicated permission that system administrators have automatically and that can be given to named
 * people such as the conference treasurer; MANAGE_FINANCE and Event Admin do not include it). It is a
 * grant on a staff assignment, the same model as the health permission, so it is per event. Callers
 * must already have established that the actor is a system administrator. Every change is audited
 * (who, whom, which event) and an unchanged state writes nothing. The membership row is locked while
 * its permissions are read and written, so a concurrent change to another permission is never undone.
 */
export class InvoiceAccessGrantError extends Error {
  constructor(public readonly code: "MEMBERSHIP_NOT_FOUND" | "MEMBERSHIP_INACTIVE" | "TARGET_IS_SYSTEM_ADMIN" | "ROLE_LACKS_FINANCE", message: string) {
    super(message);
    this.name = "InvoiceAccessGrantError";
  }
}

type Tx = Prisma.TransactionClient;

/**
 * Removes the grant inside the caller's transaction when the assignment changes (deactivated, re-added, role
 * changed), so it never survives those: only a system administrator grants it again. Audited.
 */
export async function stripInvoiceFinalizationAccess(
  tx: Tx,
  membership: { id: string; userId: string; permissions: readonly string[]; eventId: string },
  actorUserId: string,
  reason: "DEACTIVATED" | "REACTIVATED" | "RE_ADDED" | "ROLE_CHANGED",
) {
  if (!membership.permissions.includes("FINALIZE_INVOICES")) return false;
  // Lock the row and work from its permissions now: another strip (health access) may have changed them in this transaction.
  const current = await lockMembershipPermissions(tx, membership.id);
  if (!current?.includes("FINALIZE_INVOICES")) return false;
  await tx.eventMembership.update({
    where: { id: membership.id },
    data: { permissions: current.filter((permission) => permission !== "FINALIZE_INVOICES") as never },
  });
  await writeAuditLog({
    eventId: membership.eventId,
    actorUserId,
    action: "INVOICE_FINALIZATION_ACCESS_REVOKED",
    entityType: "EventMembership",
    entityId: membership.id,
    correlationId: randomUUID(),
    summary: "Permission to finalize invoices was removed because the staff assignment changed.",
    metadata: { userId: membership.userId, permission: "FINALIZE_INVOICES", reason },
  }, tx);
  return true;
}

export async function setInvoiceFinalizationAccess(eventId: string, membershipId: string, actorUserId: string, granted: boolean) {
  return getPrisma().$transaction(async (tx) => {
    const membership = await tx.eventMembership.findFirst({
      where: { id: membershipId, eventId },
      select: { id: true, userId: true, role: true, status: true, permissions: true, user: { select: { displayName: true, globalRole: true } } },
    });
    if (!membership) throw new InvoiceAccessGrantError("MEMBERSHIP_NOT_FOUND", "That staff assignment no longer exists.");
    // System administrators already have it everywhere: a grant on their row would only mislead.
    if (membership.user.globalRole === "SYSTEM_ADMIN") {
      throw new InvoiceAccessGrantError("TARGET_IS_SYSTEM_ADMIN", "System administrators can already finalize invoices.");
    }
    const held = (await lockMembershipPermissions(tx, membership.id)) ?? membership.permissions;
    const has = held.includes("FINALIZE_INVOICES");
    if (has === granted) return { granted, changed: false };
    if (granted && membership.status !== "ACTIVE") {
      throw new InvoiceAccessGrantError("MEMBERSHIP_INACTIVE", "Restore this person's access to the event before giving them permission to finalize invoices.");
    }
    // Finalizing also needs finance access to the event, so a grant on a role without it would do nothing and mislead.
    if (granted && !rolePermissions[membership.role].includes("MANAGE_FINANCE")) {
      throw new InvoiceAccessGrantError("ROLE_LACKS_FINANCE", "This person's event role does not include finance access. Change their role to Finance Manager (or Event Admin) first; finalizing invoices needs both.");
    }
    const permissions = (granted ? [...held, "FINALIZE_INVOICES"] : held.filter((permission) => permission !== "FINALIZE_INVOICES")) as never;
    await tx.eventMembership.update({ where: { id: membership.id }, data: { permissions } });
    await writeAuditLog({
      eventId,
      actorUserId,
      action: granted ? "INVOICE_FINALIZATION_ACCESS_GRANTED" : "INVOICE_FINALIZATION_ACCESS_REVOKED",
      entityType: "EventMembership",
      entityId: membership.id,
      correlationId: randomUUID(),
      summary: granted
        ? `${membership.user.displayName} was given permission to finalize invoices.`
        : `${membership.user.displayName} can no longer finalize invoices.`,
      metadata: { userId: membership.userId, permission: "FINALIZE_INVOICES" },
    }, tx);
    return { granted, changed: true };
  });
}
