import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { createClubTeamInvite } from "@/modules/club-imports/invites";
import { getAccountEmailSender, isAccountEmailConfigured } from "@/modules/communications/account-email";
import {
  clubDirectorRoleLabels,
  clubRoleIsAssignableByClub,
  directorGrantIsActive,
  directorGrantStatus,
  directorGrantWindowsOverlap,
  type ClubRole,
} from "@/modules/organizations/director-grants-domain";
import type { CreateClubTeamGrantInput, CreateDirectorGrantInput } from "@/modules/organizations/director-grants-schemas";
import { OrganizationOperationError } from "@/modules/organizations/repository";

/** A short notice for someone who already has an account (#425): the invite email explains it, this doesn't need to. */
function clubTeamRoleNotificationEmail(input: { role: ClubRole; clubName: string }) {
  const role = clubDirectorRoleLabels[input.role];
  return {
    subject: `You've been given ${role} access to ${input.clubName}`,
    bodyText: [
      `You've been given ${role} access to ${input.clubName} on IMSDA Events.`,
      "",
      "Sign in to your account to see it: /account",
      "",
      "If you weren't expecting this, contact the club's director.",
      "",
      "IMSDA Events",
    ].join("\n"),
  };
}

const grantInclude = {
  attendeeAccount: { select: { id: true, displayName: true, email: true } },
  grantedBy: { select: { id: true, displayName: true } },
  revokedBy: { select: { id: true, displayName: true } },
} satisfies Prisma.ClubDirectorGrantInclude;

type StoredGrant = Prisma.ClubDirectorGrantGetPayload<{ include: typeof grantInclude }>;

function serializeGrant(grant: StoredGrant, now: Date) {
  return {
    id: grant.id,
    organizationId: grant.organizationId,
    role: grant.role,
    status: directorGrantStatus(grant, now),
    effectiveFrom: grant.effectiveFrom.toISOString(),
    effectiveTo: grant.effectiveTo?.toISOString() ?? null,
    reason: grant.reason,
    revokedAt: grant.revokedAt?.toISOString() ?? null,
    revokeReason: grant.revokeReason,
    createdAt: grant.createdAt.toISOString(),
    account: grant.attendeeAccount,
    grantedBy: grant.grantedBy,
    revokedBy: grant.revokedBy,
  };
}

export type DirectorGrantRecord = ReturnType<typeof serializeGrant>;

async function requireClub(
  tx: Prisma.TransactionClient,
  organizationId: string,
  { mustBeActive }: { mustBeActive: boolean },
) {
  const club = await tx.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, name: true, type: true, isActive: true },
  });
  if (!club) {
    throw new OrganizationOperationError("ORGANIZATION_NOT_FOUND", "That club could not be found.");
  }
  if (club.type !== "CLUB") {
    throw new OrganizationOperationError("CLUB_REQUIRED", "Directors can only be assigned to clubs.");
  }
  if (mustBeActive && !club.isActive) {
    throw new OrganizationOperationError(
      "CLUB_INACTIVE",
      "That club is inactive. Reactivate it before assigning a director.",
    );
  }
  return club;
}

export async function listDirectorGrants(organizationId: string, now = new Date()) {
  const prisma = getPrisma();
  const club = await requireClub(prisma, organizationId, { mustBeActive: false });
  const grants = await prisma.clubDirectorGrant.findMany({
    where: { organizationId },
    include: grantInclude,
    orderBy: [{ revokedAt: { sort: "desc", nulls: "first" } }, { effectiveFrom: "desc" }],
  });
  return { club, grants: grants.map((grant) => serializeGrant(grant, now)) };
}

function isSerializationFailure(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
}

/**
 * Serializable so two staff members granting the same person at once cannot
 * both pass the overlap check.
 */
async function serializable<T>(work: (tx: Prisma.TransactionClient) => Promise<T>) {
  const prisma = getPrisma();
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await prisma.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (!isSerializationFailure(error) || attempt === 2) throw error;
    }
  }
}

export async function createDirectorGrant(
  organizationId: string,
  input: CreateDirectorGrantInput,
  actorUserId: string,
  now = new Date(),
) {
  const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : now;
  const effectiveTo = input.effectiveTo ? new Date(input.effectiveTo) : null;
  if (effectiveTo && (effectiveTo <= effectiveFrom || effectiveTo <= now)) {
    throw new OrganizationOperationError(
      "DIRECTOR_GRANT_WINDOW_INVALID",
      "The end date must be after the start date and in the future.",
    );
  }

  await serializable(async (tx) => {
    const club = await requireClub(tx, organizationId, { mustBeActive: true });
    const account = await tx.attendeeAccount.findUnique({
      where: { email: input.email },
      select: { id: true, status: true, emailVerifiedAt: true, disabledAt: true },
    });
    if (!account || account.status !== "ACTIVE" || !account.emailVerifiedAt || account.disabledAt) {
      throw new OrganizationOperationError(
        "ATTENDEE_ACCOUNT_NOT_FOUND",
        "No active, verified account uses that email. Ask the director to create one at /account/sign-up and verify their email, then try again.",
      );
    }

    const existing = await tx.clubDirectorGrant.findMany({
      where: { organizationId, attendeeAccountId: account.id, revokedAt: null },
      select: { effectiveFrom: true, effectiveTo: true },
    });
    if (existing.some((grant) => directorGrantWindowsOverlap(grant, { effectiveFrom, effectiveTo }))) {
      throw new OrganizationOperationError(
        "DIRECTOR_GRANT_CONFLICT",
        "This person already has a role in this club during those dates. Revoke or end it first.",
      );
    }

    const grant = await tx.clubDirectorGrant.create({
      data: {
        organizationId,
        attendeeAccountId: account.id,
        role: input.role,
        effectiveFrom,
        effectiveTo,
        reason: input.reason,
        grantedByUserId: actorUserId,
      },
    });
    await writeAuditLog({
      actorUserId,
      action: "CLUB_DIRECTOR_GRANTED",
      entityType: "ClubDirectorGrant",
      entityId: grant.id,
      summary: `Granted ${clubDirectorRoleLabels[input.role].toLocaleLowerCase("en-US")} access to ${club.name}.`,
      metadata: {
        organizationId,
        attendeeAccountId: account.id,
        role: input.role,
        effectiveFrom: effectiveFrom.toISOString(),
        effectiveTo: effectiveTo?.toISOString() ?? null,
      },
    }, tx);
  });

  return listDirectorGrants(organizationId, now);
}

export async function revokeDirectorGrant(
  organizationId: string,
  grantId: string,
  reason: string,
  actorUserId: string,
  now = new Date(),
) {
  await serializable(async (tx) => {
    const club = await requireClub(tx, organizationId, { mustBeActive: false });
    const revoked = await tx.clubDirectorGrant.updateMany({
      where: { id: grantId, organizationId, revokedAt: null },
      data: { revokedAt: now, revokedByUserId: actorUserId, revokeReason: reason },
    });
    if (revoked.count === 0) {
      const grant = await tx.clubDirectorGrant.findFirst({
        where: { id: grantId, organizationId },
        select: { id: true },
      });
      throw grant
        ? new OrganizationOperationError("DIRECTOR_GRANT_ALREADY_REVOKED", "That role was already revoked.")
        : new OrganizationOperationError("DIRECTOR_GRANT_NOT_FOUND", "That role could not be found.");
    }
    await writeAuditLog({
      actorUserId,
      action: "CLUB_DIRECTOR_REVOKED",
      entityType: "ClubDirectorGrant",
      entityId: grantId,
      summary: `Revoked a club role for ${club.name}.`,
      metadata: { organizationId, reason },
    }, tx);
  });

  return listDirectorGrants(organizationId, now);
}

/**
 * The club's current team as its own director or deputy sees it (#375):
 * active roles only, with names and account emails. No staff reasons or
 * history, which stay on the staff screen.
 */
export async function listClubTeam(organizationId: string, now = new Date()) {
  const grants = await getPrisma().clubDirectorGrant.findMany({
    where: {
      organizationId,
      revokedAt: null,
      effectiveFrom: { lte: now },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
    },
    orderBy: [{ role: "asc" }, { attendeeAccount: { displayName: "asc" } }],
    select: {
      id: true,
      role: true,
      effectiveFrom: true,
      effectiveTo: true,
      revokedAt: true,
      attendeeAccount: { select: { id: true, displayName: true, email: true } },
    },
  });
  return grants
    .filter((grant) => directorGrantIsActive(grant, now))
    .map((grant) => ({
      id: grant.id,
      role: grant.role as ClubRole,
      accountId: grant.attendeeAccount.id,
      displayName: grant.attendeeAccount.displayName,
      email: grant.attendeeAccount.email,
      since: grant.effectiveFrom.toISOString(),
      removableByClub: clubRoleIsAssignableByClub(grant.role),
    }));
}

export type ClubTeamMember = Awaited<ReturnType<typeof listClubTeam>>[number];

/**
 * A club director or deputy gives someone the Registrar or Reporter role
 * (#375). No verified account yet? An invite is created and emailed instead
 * (#425); it becomes this same grant when they sign up and accept it.
 */
export async function grantClubTeamRole(
  organizationId: string,
  input: CreateClubTeamGrantInput,
  actorAccountId: string,
  now = new Date(),
) {
  if (!clubRoleIsAssignableByClub(input.role)) {
    throw new OrganizationOperationError("DIRECTOR_GRANT_ROLE_NOT_ALLOWED", "Only conference staff can assign directors and deputies.");
  }
  const prisma = getPrisma();
  const account = await prisma.attendeeAccount.findUnique({
    where: { email: input.email },
    select: { id: true, status: true, emailVerifiedAt: true, disabledAt: true },
  });
  const hasVerifiedAccount = Boolean(account && account.status === "ACTIVE" && account.emailVerifiedAt && !account.disabledAt);

  if (!hasVerifiedAccount) {
    const { messageId } = await createClubTeamInvite(organizationId, { email: input.email, role: input.role }, actorAccountId, now);
    return { team: await listClubTeam(organizationId, now), invited: true, messageId };
  }
  const accountId = account!.id;

  let messageId: string | null = null;
  await serializable(async (tx) => {
    const club = await requireClub(tx, organizationId, { mustBeActive: true });
    const existing = await tx.clubDirectorGrant.findMany({
      where: { organizationId, attendeeAccountId: accountId, revokedAt: null },
      select: { effectiveFrom: true, effectiveTo: true },
    });
    if (existing.some((grant) => directorGrantWindowsOverlap(grant, { effectiveFrom: now, effectiveTo: null }))) {
      throw new OrganizationOperationError(
        "DIRECTOR_GRANT_CONFLICT",
        "This person already has a role in this club. Remove it first to change it.",
      );
    }
    const grant = await tx.clubDirectorGrant.create({
      data: {
        organizationId,
        attendeeAccountId: accountId,
        role: input.role,
        effectiveFrom: now,
        reason: "Given by the club's director or deputy.",
        grantedByAccountId: actorAccountId,
      },
      select: { id: true },
    });
    await writeAuditLog({
      action: "CLUB_ROLE_GRANTED",
      entityType: "ClubDirectorGrant",
      entityId: grant.id,
      summary: `Club leader gave ${clubDirectorRoleLabels[input.role].toLocaleLowerCase("en-US")} access to ${club.name}.`,
      metadata: { organizationId, attendeeAccountId: accountId, role: input.role, actorAttendeeAccountId: actorAccountId },
    }, tx);

    // Best-effort: the grant stands even where account email isn't configured (local dev).
    if (isAccountEmailConfigured()) {
      const sender = getAccountEmailSender();
      const content = clubTeamRoleNotificationEmail({ role: input.role, clubName: club.name });
      const message = await tx.messageOutbox.create({
        data: {
          eventId: null,
          templateKey: "CLUB_TEAM_ROLE_NOTIFICATION",
          recipientKind: "ACCOUNT",
          recipientEmail: input.email,
          recipientName: null,
          accountAttendeeId: accountId,
          senderNameSnapshot: sender.name,
          senderEmailSnapshot: sender.address,
          replyToEmailSnapshot: sender.replyTo,
          subjectSnapshot: content.subject,
          bodyTextSnapshot: content.bodyText,
          metadata: { trigger: "CLUB_TEAM_ROLE_GRANTED", accountEmail: true, realDelivery: true, grantId: grant.id },
          idempotencyKey: `club-role-notice:${grant.id}:${randomUUID()}`,
          correlationId: randomUUID(),
          status: "PENDING",
        },
        select: { id: true },
      });
      messageId = message.id;
    }
  });
  return { team: await listClubTeam(organizationId, now), invited: false, messageId };
}

/** A club director or deputy removes a Registrar or Reporter. Directors and deputies are removed by staff only. */
export async function revokeClubTeamRole(
  organizationId: string,
  grantId: string,
  actorAccountId: string,
  now = new Date(),
) {
  await serializable(async (tx) => {
    const club = await requireClub(tx, organizationId, { mustBeActive: false });
    const grant = await tx.clubDirectorGrant.findFirst({
      where: { id: grantId, organizationId },
      select: { id: true, role: true, revokedAt: true, attendeeAccountId: true },
    });
    if (!grant) throw new OrganizationOperationError("DIRECTOR_GRANT_NOT_FOUND", "That role could not be found.");
    if (!clubRoleIsAssignableByClub(grant.role)) {
      throw new OrganizationOperationError("DIRECTOR_GRANT_ROLE_NOT_ALLOWED", "Only conference staff can remove directors and deputies.");
    }
    if (grant.revokedAt) throw new OrganizationOperationError("DIRECTOR_GRANT_ALREADY_REVOKED", "That role was already removed.");
    await tx.clubDirectorGrant.update({
      where: { id: grantId },
      data: { revokedAt: now, revokedByAccountId: actorAccountId, revokeReason: "Removed by the club's director or deputy." },
    });
    await writeAuditLog({
      action: "CLUB_ROLE_REVOKED",
      entityType: "ClubDirectorGrant",
      entityId: grantId,
      summary: `Club leader removed a ${clubDirectorRoleLabels[grant.role].toLocaleLowerCase("en-US")} from ${club.name}.`,
      metadata: { organizationId, attendeeAccountId: grant.attendeeAccountId, role: grant.role, actorAttendeeAccountId: actorAccountId },
    }, tx);
  });
  return listClubTeam(organizationId, now);
}
