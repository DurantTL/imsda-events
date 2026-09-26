import "server-only";

import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { getCurrentSession } from "@/modules/access/current-session";
import { isSessionIdle } from "@/modules/access/session-store";

/**
 * Staff "act as" Area Coordinator / club director (#442).
 *
 * Decisions (Caleb, 2026-09-25 and 2026-09-27): the staff user's own
 * attendee/portal account is never touched. Acting works entirely inside the
 * staff session — a `StaffActAs` row tied to it, not a grant on any attendee
 * account. Club and Area Coordinator pages resolve access from that row.
 * Club-director acting has full director powers, attributed to the staff
 * user, never to an attendee account that didn't act. Area Coordinator
 * acting stays view-only. Only one act-as is active per staff session, and
 * the window lasts two hours unless "Stop acting" or sign-out ends it first.
 */

export const ACT_AS_MINUTES = 120;

export class StaffActAsError extends Error {
  constructor(public readonly code: "CLUB_NOT_FOUND", message: string) {
    super(message);
    this.name = "StaffActAsError";
  }
}

export type StaffActAsRole = "AREA_COORDINATOR" | "CLUB_DIRECTOR";

export type ActiveStaffActAs = {
  id: string;
  userId: string;
  staffSessionId: string;
  role: StaffActAsRole;
  organizationId: string | null;
  expiresAt: Date;
};

/**
 * The staff session's own validity, independent of whether it is expired,
 * revoked, or idle right now — the same rules `getCurrentSession` checks.
 * An act-as is never active once its staff session itself is dead, even
 * before anything writes `endedAt`.
 */
async function staffSessionIsValid(staffSessionId: string, now: Date) {
  const session = await getPrisma().userSession.findUnique({
    where: { id: staffSessionId },
    select: {
      expiresAt: true,
      revokedAt: true,
      lastSeenAt: true,
      user: { select: { accountStatus: true, credential: { select: { disabledAt: true } } } },
    },
  });
  if (!session || session.revokedAt || session.expiresAt <= now) return false;
  if (!session.user.credential || session.user.credential.disabledAt) return false;
  if (session.user.accountStatus !== "ACTIVE") return false;
  if (isSessionIdle(session.lastSeenAt, now)) return false;
  return true;
}

/**
 * The staff session's active act-as, or null. Active means: not ended,
 * `expiresAt` still in the future, and the staff session itself still valid.
 * A row past its `expiresAt` is opportunistically marked `EXPIRED` so it
 * stops showing as active anywhere else that reads it directly, but that
 * write is best-effort — the read above already treats it as inactive.
 */
export async function resolveActiveActAs(staffSessionId: string, now = new Date()): Promise<ActiveStaffActAs | null> {
  const row = await getPrisma().staffActAs.findFirst({
    where: { staffSessionId, endedAt: null },
    select: { id: true, userId: true, staffSessionId: true, role: true, organizationId: true, expiresAt: true },
  });
  if (!row) return null;
  if (row.expiresAt <= now) {
    await getPrisma().staffActAs.updateMany({
      where: { id: row.id, endedAt: null },
      data: { endedAt: now, endedReason: "EXPIRED" },
    }).catch(() => {});
    return null;
  }
  if (!(await staffSessionIsValid(staffSessionId, now))) return null;
  return row;
}

export type StaffActingContext = {
  userId: string;
  staffSessionId: string;
  actAsId: string;
  role: StaffActAsRole;
  organizationId: string | null;
  expiresAt: Date;
};

/** The signed-in staff member's active act-as, from the staff session alone. */
export async function currentStaffActingContext(): Promise<StaffActingContext | null> {
  const { user, sessionId } = await getCurrentSession();
  if (!user || !sessionId) return null;
  const active = await resolveActiveActAs(sessionId);
  if (!active) return null;
  return {
    userId: active.userId,
    staffSessionId: active.staffSessionId,
    actAsId: active.id,
    role: active.role,
    organizationId: active.organizationId,
    expiresAt: active.expiresAt,
  };
}

async function endActiveActAs(
  tx: Prisma.TransactionClient,
  staffSessionId: string,
  reason: "REPLACED",
  now: Date,
) {
  await tx.staffActAs.updateMany({
    where: { staffSessionId, endedAt: null },
    data: { endedAt: now, endedReason: reason },
  });
}

/** Starts (or restarts) acting as an Area Coordinator for the staff session (#442). Ends any active act-as first. */
export async function actAsAreaCoordinator(staff: { id: string }, staffSessionId: string, now = new Date()) {
  const expiresAt = new Date(now.getTime() + ACT_AS_MINUTES * 60_000);
  return getPrisma().$transaction(async (tx) => {
    await endActiveActAs(tx, staffSessionId, "REPLACED", now);
    const row = await tx.staffActAs.create({
      data: { userId: staff.id, staffSessionId, role: "AREA_COORDINATOR", organizationId: null, startedAt: now, expiresAt },
      select: { id: true },
    });
    await writeAuditLog({
      actorUserId: staff.id,
      action: "ACT_AS_AREA_COORDINATOR",
      entityType: "StaffActAs",
      entityId: row.id,
      summary: "A system administrator is acting as an Area Coordinator for a limited time.",
      metadata: { actAsId: row.id, expiresAt: expiresAt.toISOString() },
    }, tx);
    return { expiresAt, actAsId: row.id };
  });
}

/** Starts (or restarts) acting as a club's Director for the staff session (#442). Ends any active act-as first. */
export async function actAsClubDirector(staff: { id: string }, staffSessionId: string, organizationId: string, now = new Date()) {
  const expiresAt = new Date(now.getTime() + ACT_AS_MINUTES * 60_000);
  return getPrisma().$transaction(async (tx) => {
    const club = await tx.organization.findUnique({ where: { id: organizationId }, select: { type: true, isActive: true, name: true } });
    if (!club || club.type !== "CLUB" || !club.isActive) {
      throw new StaffActAsError("CLUB_NOT_FOUND", "That club could not be found, or it's inactive.");
    }
    await endActiveActAs(tx, staffSessionId, "REPLACED", now);
    const row = await tx.staffActAs.create({
      data: { userId: staff.id, staffSessionId, role: "CLUB_DIRECTOR", organizationId, startedAt: now, expiresAt },
      select: { id: true },
    });
    await writeAuditLog({
      actorUserId: staff.id,
      action: "ACT_AS_CLUB_DIRECTOR",
      entityType: "StaffActAs",
      entityId: row.id,
      summary: `A system administrator is acting as director of ${club.name} for a limited time.`,
      metadata: { actAsId: row.id, organizationId, expiresAt: expiresAt.toISOString() },
    }, tx);
    return { expiresAt, actAsId: row.id, clubName: club.name };
  });
}

/** Ends the staff session's active act-as right away ("Stop acting"). Returns null when nothing was active. */
export async function stopActingAs(staff: { id: string }, staffSessionId: string, now = new Date()) {
  return getPrisma().$transaction(async (tx) => {
    const active = await tx.staffActAs.findFirst({
      where: { staffSessionId, endedAt: null },
      select: { id: true, role: true, organizationId: true },
    });
    if (!active) return null;
    await tx.staffActAs.update({ where: { id: active.id }, data: { endedAt: now, endedReason: "STOPPED" } });
    await writeAuditLog({
      actorUserId: staff.id,
      action: "ACT_AS_STOPPED",
      entityType: "StaffActAs",
      entityId: active.id,
      summary: "A system administrator stopped acting as a club role.",
      metadata: { actAsId: active.id, role: active.role, organizationId: active.organizationId },
    }, tx);
    return active;
  });
}

/** Ends the staff session's active act-as because the staff member signed out (#442). Never throws: sign-out must still succeed. */
export async function endActiveActAsOnSignOut(staffSessionId: string, now = new Date()) {
  const prisma = getPrisma();
  const active = await prisma.staffActAs.findFirst({
    where: { staffSessionId, endedAt: null },
    select: { id: true, userId: true, role: true, organizationId: true },
  });
  if (!active) return;
  await prisma.$transaction(async (tx) => {
    await tx.staffActAs.update({ where: { id: active.id }, data: { endedAt: now, endedReason: "SIGNED_OUT" } });
    await writeAuditLog({
      actorUserId: active.userId,
      action: "ACT_AS_STOPPED",
      entityType: "StaffActAs",
      entityId: active.id,
      summary: "Acting as a club role ended because the staff member signed out.",
      metadata: { actAsId: active.id, role: active.role, organizationId: active.organizationId, reason: "SIGNED_OUT" },
    }, tx);
  }).catch(() => {});
}
