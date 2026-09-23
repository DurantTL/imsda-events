import "server-only";

import { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import {
  directorGrantStatus,
  directorGrantWindowsOverlap,
} from "@/modules/organizations/director-grants-domain";
import type { CreateDirectorGrantInput } from "@/modules/organizations/director-grants-schemas";
import { OrganizationOperationError } from "@/modules/organizations/repository";

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
        "This person already has a director grant for this club during those dates. Revoke or end it first.",
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
      summary: `Granted ${input.role === "DEPUTY" ? "deputy director" : "director"} access to ${club.name}.`,
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
        ? new OrganizationOperationError("DIRECTOR_GRANT_ALREADY_REVOKED", "That director grant was already revoked.")
        : new OrganizationOperationError("DIRECTOR_GRANT_NOT_FOUND", "That director grant could not be found.");
    }
    await writeAuditLog({
      actorUserId,
      action: "CLUB_DIRECTOR_REVOKED",
      entityType: "ClubDirectorGrant",
      entityId: grantId,
      summary: `Revoked a director grant for ${club.name}.`,
      metadata: { organizationId, reason },
    }, tx);
  });

  return listDirectorGrants(organizationId, now);
}
