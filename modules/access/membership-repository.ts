import "server-only";

import { randomUUID } from "node:crypto";
import type { EventPermission, EventRole } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { wouldRemoveLastActiveEventAdmin } from "@/modules/access/membership-rules";
import { hashPassword } from "@/modules/access/passwords";
import { createOpaqueToken } from "@/modules/access/tokens";
import { rolePermissions } from "@/modules/access/permissions";

export class MembershipOperationError extends Error {
  constructor(public readonly code: "MEMBERSHIP_NOT_FOUND" | "LAST_EVENT_ADMIN", message: string) {
    super(message);
    this.name = "MembershipOperationError";
  }
}

export type StaffMembershipRecord = Awaited<ReturnType<typeof listStaffMemberships>>[number];

export async function listActiveEventPermissionsForUser(
  userId: string,
  eventIds: readonly string[],
) {
  if (eventIds.length === 0) return new Map<string, EventPermission[]>();
  const memberships = await getPrisma().eventMembership.findMany({
    where: {
      userId,
      eventId: { in: [...eventIds] },
      status: "ACTIVE",
    },
    select: {
      eventId: true,
      role: true,
      permissions: true,
    },
  });
  return new Map(memberships.map((membership) => [
    membership.eventId,
    [...new Set([
      ...rolePermissions[membership.role],
      ...membership.permissions,
    ])] as EventPermission[],
  ]));
}

export async function listStaffMemberships(eventId: string) {
  const rows = await getPrisma().eventMembership.findMany({
    where: { eventId },
    orderBy: [{ status: "asc" }, { role: "asc" }, { user: { displayName: "asc" } }],
    select: {
      id: true,
      role: true,
      status: true,
      permissions: true,
      createdAt: true,
      updatedAt: true,
      user: { select: { id: true, displayName: true, email: true, globalRole: true, credential: { select: { disabledAt: true } } } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    status: row.status,
    permissions: row.permissions,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    user: {
      id: row.user.id,
      displayName: row.user.displayName,
      email: row.user.email,
      globalRole: row.user.globalRole,
      accountDisabled: Boolean(row.user.credential?.disabledAt),
    },
  }));
}

export async function addStaffMembership(eventId: string, actorUserId: string, input: { email: string; displayName: string; role: EventRole }) {
  const email = input.email.trim().toLowerCase();
  const placeholderHash = await hashPassword(`${createOpaqueToken()}-local-setup`);
  const result = await getPrisma().$transaction(async (tx) => {
    let user = await tx.user.findUnique({ where: { email }, select: { id: true, credential: { select: { id: true } } } });
    let credentialCreated = false;
    if (!user) {
      user = await tx.user.create({
        data: { email, displayName: input.displayName.trim(), credential: { create: { passwordHash: placeholderHash } } },
        select: { id: true, credential: { select: { id: true } } },
      });
      credentialCreated = true;
    } else {
      await tx.user.update({ where: { id: user.id }, data: { displayName: input.displayName.trim() } });
      if (!user.credential) {
        await tx.authCredential.create({ data: { userId: user.id, passwordHash: placeholderHash } });
        credentialCreated = true;
      }
    }

    const existing = await tx.eventMembership.findUnique({ where: { eventId_userId: { eventId, userId: user.id } } });
    const membership = existing
      ? await tx.eventMembership.update({ where: { id: existing.id }, data: { role: input.role, status: "ACTIVE" } })
      : await tx.eventMembership.create({ data: { eventId, userId: user.id, role: input.role, status: "ACTIVE" } });

    await writeAuditLog({
      eventId,
      actorUserId,
      action: existing ? "EVENT_MEMBERSHIP_REACTIVATED" : "EVENT_MEMBERSHIP_CREATED",
      entityType: "EventMembership",
      entityId: membership.id,
      correlationId: randomUUID(),
      summary: `${input.displayName.trim()} was assigned as ${input.role.toLowerCase().replaceAll("_", " ")}.`,
      metadata: { userId: user.id, email, role: input.role, previousRole: existing?.role ?? null, previousStatus: existing?.status ?? null },
    }, tx);
    return { credentialCreated };
  });
  return { membership: (await listStaffMemberships(eventId)).find((row) => row.user.email === email)!, credentialCreated: result.credentialCreated };
}

export async function updateStaffMembership(eventId: string, membershipId: string, actorUserId: string, input: { role: EventRole; status: "ACTIVE" | "INACTIVE" }) {
  await getPrisma().$transaction(async (tx) => {
    const current = await tx.eventMembership.findFirst({
      where: { id: membershipId, eventId },
      include: { user: { select: { displayName: true, email: true } } },
    });
    if (!current) throw new MembershipOperationError("MEMBERSHIP_NOT_FOUND", "That staff assignment no longer exists.");

    if (current.role === "EVENT_ADMIN" && current.status === "ACTIVE") {
      const otherActiveAdminCount = await tx.eventMembership.count({
        where: { eventId, id: { not: current.id }, role: "EVENT_ADMIN", status: "ACTIVE" },
      });
      if (wouldRemoveLastActiveEventAdmin(current, input, otherActiveAdminCount)) {
        throw new MembershipOperationError("LAST_EVENT_ADMIN", "Assign another active event administrator before changing this account.");
      }
    }

    const updated = await tx.eventMembership.update({ where: { id: current.id }, data: input });
    await writeAuditLog({
      eventId,
      actorUserId,
      action: current.status !== input.status ? "EVENT_MEMBERSHIP_STATUS_CHANGED" : "EVENT_MEMBERSHIP_ROLE_CHANGED",
      entityType: "EventMembership",
      entityId: current.id,
      correlationId: randomUUID(),
      summary: `${current.user.displayName} is now ${input.status.toLowerCase()} as ${input.role.toLowerCase().replaceAll("_", " ")}.`,
      metadata: { userId: current.userId, email: current.user.email, before: { role: current.role, status: current.status }, after: { role: updated.role, status: updated.status } },
    }, tx);
  });
  return (await listStaffMemberships(eventId)).find((row) => row.id === membershipId)!;
}
