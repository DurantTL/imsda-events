import "server-only";

import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import { accountNeedsSecondStep } from "@/modules/attendee-accounts/sign-in-gate";

/**
 * Area Coordinators (#387): see every club, view only, from their own account
 * (decision: all clubs). They see ages, never full birth dates, and pass the
 * same second sign-in step as club roles.
 */

export class AreaCoordinatorError extends Error {
  constructor(public readonly code: "ACCOUNT_NOT_FOUND", message: string) {
    super(message);
    this.name = "AreaCoordinatorError";
  }
}

export async function isAreaCoordinator(attendeeAccountId: string) {
  const grant = await getPrisma().areaCoordinatorGrant.findUnique({
    where: { attendeeAccountId },
    select: { revokedAt: true },
  });
  return Boolean(grant && !grant.revokedAt);
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
        update: { revokedAt: null, revokedByUserId: null, grantedByUserId: actorUserId, grantedAt: now },
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
