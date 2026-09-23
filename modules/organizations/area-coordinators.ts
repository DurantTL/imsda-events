import "server-only";

import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { findSwitchableAttendeeAccountForStaff, getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import { accountNeedsSecondStep } from "@/modules/attendee-accounts/sign-in-gate";

/**
 * Area Coordinators (#387): see every club, view only, from their own account
 * (decision: all clubs). They see ages, never full birth dates, and pass the
 * same second sign-in step as club roles.
 */

/** How long a system administrator's "act as" role lasts (#387). */
export const ACT_AS_MINUTES = 120;

export class AreaCoordinatorError extends Error {
  constructor(public readonly code: "ACCOUNT_NOT_FOUND" | "NO_OWN_ACCOUNT" | "CLUB_NOT_FOUND", message: string) {
    super(message);
    this.name = "AreaCoordinatorError";
  }
}

/** Active: not removed, and not past a temporary "act as" end. */
export function areaGrantActive(grant: { revokedAt: Date | null; expiresAt: Date | null } | null, now = new Date()) {
  return Boolean(grant && !grant.revokedAt && (!grant.expiresAt || grant.expiresAt > now));
}

export async function isAreaCoordinator(attendeeAccountId: string, now = new Date()) {
  const grant = await getPrisma().areaCoordinatorGrant.findUnique({
    where: { attendeeAccountId },
    select: { revokedAt: true, expiresAt: true },
  });
  return areaGrantActive(grant, now);
}

/**
 * The signed-in Area Coordinator, or null. Checks the second sign-in step
 * itself rather than trusting the account layout to have done so.
 */
export async function currentAreaCoordinator() {
  const { account, via, sessionId } = await getCurrentAttendee();
  if (!account || via !== "attendee") return null;
  if (!(await isAreaCoordinator(account.id))) return null;
  if ((await accountNeedsSecondStep(account.id, sessionId)) !== "OK") return null;
  return account;
}

/** Every active club, for the Area Coordinator's Clubs list. */
export async function listClubsForArea() {
  const clubs = await getPrisma().organization.findMany({
    where: { type: "CLUB", isActive: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true, parentOrganization: { select: { name: true } } },
  });
  return clubs.map((club) => ({
    organizationId: club.id,
    name: club.name,
    sponsoringChurch: club.parentOrganization?.name ?? null,
  }));
}

export async function setAreaCoordinator(attendeeAccountId: string, on: boolean, actorUserId: string, now = new Date()) {
  const prisma = getPrisma();
  await prisma.$transaction(async (tx) => {
    const account = await tx.attendeeAccount.findUnique({ where: { id: attendeeAccountId }, select: { id: true } });
    if (!account) throw new AreaCoordinatorError("ACCOUNT_NOT_FOUND", "That account could not be found.");
    if (on) {
      await tx.areaCoordinatorGrant.upsert({
        where: { attendeeAccountId },
        create: { attendeeAccountId, grantedByUserId: actorUserId, grantedAt: now },
        update: { revokedAt: null, revokedByUserId: null, expiresAt: null, grantedByUserId: actorUserId, grantedAt: now },
      });
    } else {
      await tx.areaCoordinatorGrant.updateMany({
        where: { attendeeAccountId, revokedAt: null },
        data: { revokedAt: now, revokedByUserId: actorUserId },
      });
    }
    await writeAuditLog({
      actorUserId,
      action: on ? "AREA_COORDINATOR_GRANTED" : "AREA_COORDINATOR_REVOKED",
      entityType: "AttendeeAccount",
      entityId: attendeeAccountId,
      summary: on ? "Made an account an Area Coordinator." : "Removed an Area Coordinator.",
      metadata: { attendeeAccountId },
    }, tx);
  });
}

/**
 * The system administrator's own attendee account (same email, verified):
 * "act as" roles are given to it, never to someone else's account.
 */
async function ownAttendeeAccount(staff: { email: string }) {
  const account = await findSwitchableAttendeeAccountForStaff(staff.email);
  if (!account) {
    throw new AreaCoordinatorError(
      "NO_OWN_ACCOUNT",
      `Acting as a club role uses your own account at /account. Create and verify one with ${staff.email} first (Sign up at /account/sign-up), then try again.`,
    );
  }
  return account;
}

/**
 * Lets a system administrator work as an Area Coordinator for a while (#387),
 * through their own account: a real, audited role that ends by itself. A
 * lasting role already held is left as it is.
 */
export async function actAsAreaCoordinator(staff: { id: string; email: string }, now = new Date()) {
  const account = await ownAttendeeAccount(staff);
  const expiresAt = new Date(now.getTime() + ACT_AS_MINUTES * 60_000);
  const existing = await getPrisma().areaCoordinatorGrant.findUnique({ where: { attendeeAccountId: account.id }, select: { revokedAt: true, expiresAt: true } });
  if (areaGrantActive(existing, now) && !existing!.expiresAt) return { expiresAt: null };
  await getPrisma().$transaction(async (tx) => {
    await tx.areaCoordinatorGrant.upsert({
      where: { attendeeAccountId: account.id },
      create: { attendeeAccountId: account.id, grantedByUserId: staff.id, grantedAt: now, expiresAt },
      update: { revokedAt: null, revokedByUserId: null, grantedByUserId: staff.id, grantedAt: now, expiresAt },
    });
    await writeAuditLog({
      actorUserId: staff.id,
      action: "ACT_AS_AREA_COORDINATOR",
      entityType: "AttendeeAccount",
      entityId: account.id,
      summary: "A system administrator is acting as an Area Coordinator for a limited time.",
      metadata: { attendeeAccountId: account.id, expiresAt: expiresAt.toISOString() },
    }, tx);
  });
  return { expiresAt };
}

/**
 * Lets a system administrator work as a club's Director for a while (#387):
 * a real Director role on their own account, shown in the club's admin list
 * with its reason, audited, and ending by itself. If they are already its
 * Director, nothing changes.
 */
export async function actAsClubDirector(staff: { id: string; email: string }, organizationId: string, now = new Date()) {
  const account = await ownAttendeeAccount(staff);
  const expiresAt = new Date(now.getTime() + ACT_AS_MINUTES * 60_000);
  return getPrisma().$transaction(async (tx) => {
    const club = await tx.organization.findUnique({ where: { id: organizationId }, select: { type: true, isActive: true, name: true } });
    if (!club || club.type !== "CLUB" || !club.isActive) {
      throw new AreaCoordinatorError("CLUB_NOT_FOUND", "That club could not be found, or it's inactive.");
    }
    // Only a Director role already held is enough; a lower role (e.g. a
    // registrar) still gets the temporary Director role, which outranks it.
    const current = await tx.clubDirectorGrant.findFirst({
      where: {
        organizationId,
        attendeeAccountId: account.id,
        role: "DIRECTOR",
        revokedAt: null,
        effectiveFrom: { lte: now },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
      },
      select: { role: true, effectiveTo: true },
    });
    if (current) return { expiresAt: current.effectiveTo, alreadyHadRole: true, role: current.role };
    const grant = await tx.clubDirectorGrant.create({
      data: {
        organizationId,
        attendeeAccountId: account.id,
        role: "DIRECTOR",
        effectiveFrom: now,
        effectiveTo: expiresAt,
        reason: "System administrator acting as director (ends automatically).",
        grantedByUserId: staff.id,
      },
    });
    await writeAuditLog({
      actorUserId: staff.id,
      action: "ACT_AS_CLUB_DIRECTOR",
      entityType: "ClubDirectorGrant",
      entityId: grant.id,
      summary: `A system administrator is acting as director of ${club.name} for a limited time.`,
      metadata: { organizationId, attendeeAccountId: account.id, expiresAt: expiresAt.toISOString() },
    }, tx);
    return { expiresAt, alreadyHadRole: false, role: "DIRECTOR" as const };
  });
}
