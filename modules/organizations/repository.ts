import "server-only";

import {
  Prisma,
  type OrganizationType,
} from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { clampPage } from "@/lib/pagination";
import {
  SPONSOR_ORGANIZATION_TYPES,
  canSponsorClub,
  isSponsorOrganizationType,
  normalizeOrganizationName,
} from "@/modules/organizations/domain";
import { organizationSearchWhere } from "@/modules/organizations/search";
import type {
  CreateOrganizationInput,
  ExternalIdentityInput,
  UpdateExternalIdentityInput,
  UpdateOrganizationInput,
} from "@/modules/organizations/schemas";

const organizationInclude = {
  parentOrganization: {
    select: { id: true, name: true, type: true, isActive: true },
  },
  externalIdentities: {
    orderBy: [{ provider: "asc" as const }, { providerScope: "asc" as const }],
    select: {
      id: true,
      provider: true,
      providerScope: true,
      externalId: true,
      displayLabel: true,
      lastVerifiedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  },
} satisfies Prisma.OrganizationInclude;

type StoredOrganization = Prisma.OrganizationGetPayload<{
  include: typeof organizationInclude;
}>;

export type OrganizationOperationErrorCode =
  | "ORGANIZATION_NOT_FOUND"
  | "ORGANIZATION_CONFLICT"
  | "ORGANIZATION_PARENT_NOT_ALLOWED"
  | "ORGANIZATION_PARENT_INVALID"
  | "ORGANIZATION_PARENT_REQUIRED"
  | "ORGANIZATION_HAS_ACTIVE_CLUBS"
  | "ORGANIZATION_DELETE_BLOCKED"
  | "ORGANIZATION_DELETE_NAME_MISMATCH"
  | "EXTERNAL_IDENTITY_NOT_FOUND"
  | "EXTERNAL_IDENTITY_CONFLICT"
  | "CLUB_REQUIRED"
  | "CLUB_INACTIVE"
  | "ATTENDEE_ACCOUNT_NOT_FOUND"
  | "DIRECTOR_GRANT_WINDOW_INVALID"
  | "DIRECTOR_GRANT_CONFLICT"
  | "DIRECTOR_GRANT_NOT_FOUND"
  | "DIRECTOR_GRANT_ALREADY_REVOKED"
  | "DIRECTOR_GRANT_ROLE_NOT_ALLOWED"
  | "ACT_AS_OWN_ACCOUNT_NOT_ALLOWED"
  | "GEOCODING_DISABLED"
  | "GEOCODING_UNAVAILABLE"
  | "GEOCODE_RESULT_NOT_FOUND"
  | "GEOCODE_ADDRESS_CHANGED"
  | "GEOCODING_TIMEOUT"
  | "LOCATION_CHANGED"
  | "GEOCODING_ALREADY_RUNNING"
  | "LOCATION_SET_BY_HAND";

export class OrganizationOperationError extends Error {
  constructor(
    public readonly code: OrganizationOperationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OrganizationOperationError";
  }
}

function serializeOrganization(organization: StoredOrganization) {
  return {
    ...organization,
    createdAt: organization.createdAt.toISOString(),
    updatedAt: organization.updatedAt.toISOString(),
    externalIdentities: organization.externalIdentities.map((identity) => ({
      ...identity,
      lastVerifiedAt: identity.lastVerifiedAt?.toISOString() ?? null,
      createdAt: identity.createdAt.toISOString(),
      updatedAt: identity.updatedAt.toISOString(),
    })),
  };
}

export type OrganizationRecord = ReturnType<typeof serializeOrganization>;

function isUniqueConstraint(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && error.code === "P2002";
}

async function validateParentOrganization(
  tx: Prisma.TransactionClient,
  type: OrganizationType,
  parentOrganizationId: string | null,
  organizationId?: string,
) {
  // Only a club has a sponsor (#822); a church, company or group stands alone.
  if (type !== "CLUB") {
    if (parentOrganizationId !== null) {
      throw new OrganizationOperationError(
        "ORGANIZATION_PARENT_NOT_ALLOWED",
        "This organization cannot be placed under another organization.",
      );
    }
    return;
  }

  if (parentOrganizationId === null) {
    // Every club has a sponsoring church or company; church-billed events invoice it.
    throw new OrganizationOperationError(
      "ORGANIZATION_PARENT_REQUIRED",
      "Choose the club's sponsoring church or company. Every club needs one.",
    );
  }
  if (parentOrganizationId === organizationId) {
    throw new OrganizationOperationError(
      "ORGANIZATION_PARENT_INVALID",
      "A club cannot be its own sponsoring church or company.",
    );
  }
  const parent = await tx.organization.findUnique({
    where: { id: parentOrganizationId },
    select: { type: true, isActive: true },
  });
  if (!canSponsorClub(parent)) {
    throw new OrganizationOperationError(
      "ORGANIZATION_PARENT_INVALID",
      "Choose an active church or company as the club's sponsoring organization.",
    );
  }
}

export async function listOrganizations() {
  const organizations = await getPrisma().organization.findMany({
    // Clubs and churches only: the other kinds from the eAdventist import
    // (#649) have their own list at /admin/organizations/directory.
    where: { type: { in: ["CHURCH", "CLUB"] } },
    include: organizationInclude,
    orderBy: [
      { isActive: "desc" },
      { type: "asc" },
      { name: "asc" },
    ],
  });
  return organizations.map(serializeOrganization);
}

/** Rows per page on the Clubs and churches page (#723). */
export const ORGANIZATION_PAGE_SIZE = 24;

export type OrganizationListFilters = {
  query: string;
  kind: "CHURCH" | "CLUB" | null;
  status: "ALL" | "ACTIVE" | "INACTIVE";
  page?: number;
};

/**
 * One page of the Clubs and churches list for a search and the Kind and Status
 * filters (#723). Matching runs in the database; the same ordering as the full
 * list is kept. A club row carries its sponsoring church (`parentOrganization`),
 * so a hit on a club always shows the church it belongs to.
 */
export async function listOrganizationsPage(filters: OrganizationListFilters) {
  const where: Prisma.OrganizationWhereInput = {
    type: filters.kind ?? { in: ["CHURCH", "CLUB"] },
    ...(filters.status === "ACTIVE" ? { isActive: true } : {}),
    ...(filters.status === "INACTIVE" ? { isActive: false } : {}),
    ...(organizationSearchWhere(filters.query) ?? {}),
  };
  const prisma = getPrisma();
  const total = await prisma.organization.count({ where });
  const page = clampPage(filters.page ?? 1, total, ORGANIZATION_PAGE_SIZE);
  const organizations = await prisma.organization.findMany({
    where,
    include: organizationInclude,
    orderBy: [{ isActive: "desc" }, { type: "asc" }, { name: "asc" }, { id: "asc" }],
    skip: (page - 1) * ORGANIZATION_PAGE_SIZE,
    take: ORGANIZATION_PAGE_SIZE,
  });
  return {
    total,
    page,
    pageSize: ORGANIZATION_PAGE_SIZE,
    organizations: organizations.map(serializeOrganization),
  };
}

/** Whole-directory counts for the summary tiles, independent of any search. */
export async function getOrganizationSummary() {
  const prisma = getPrisma();
  const inScope = { type: { in: ["CHURCH", "CLUB"] } } satisfies Prisma.OrganizationWhereInput;
  const [churches, clubs, identities, unlinked] = await Promise.all([
    prisma.organization.count({ where: { type: "CHURCH", isActive: true } }),
    prisma.organization.count({ where: { type: "CLUB", isActive: true } }),
    prisma.externalIdentity.count({ where: { organization: inScope } }),
    prisma.organization.count({ where: { ...inScope, isActive: true, externalIdentities: { none: {} } } }),
  ]);
  return { churches, clubs, identities, unlinked };
}

/** Every church, company and group, for the sponsoring church or company picker (#822). Small and not searched. */
export async function listSponsorOptions() {
  return getPrisma().organization.findMany({
    where: { type: { in: [...SPONSOR_ORGANIZATION_TYPES] } },
    select: { id: true, name: true, type: true, isActive: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
}

export async function createOrganization(
  input: CreateOrganizationInput,
  actorUserId: string,
) {
  const prisma = getPrisma();
  await prisma.$transaction(async (tx) => {
    await validateParentOrganization(
      tx,
      input.type,
      input.parentOrganizationId,
    );
    const organization = await tx.organization.create({
      data: {
        type: input.type,
        name: input.name,
        normalizedName: normalizeOrganizationName(input.name),
        parentOrganizationId: input.parentOrganizationId,
        isActive: input.isActive,
      },
    });
    await writeAuditLog({
      actorUserId,
      action: "ORGANIZATION_CREATED",
      entityType: "Organization",
      entityId: organization.id,
      summary: `Created ${organization.type.toLocaleLowerCase("en-US")} ${organization.name}.`,
      metadata: {
        type: organization.type,
        parentOrganizationId: organization.parentOrganizationId,
      },
    }, tx);
  });
  return listOrganizations();
}

export async function updateOrganization(
  organizationId: string,
  input: UpdateOrganizationInput,
  actorUserId: string,
) {
  const prisma = getPrisma();
  await prisma.$transaction(async (tx) => {
    const existing = await tx.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, type: true, name: true, isActive: true },
    });
    if (!existing) {
      throw new OrganizationOperationError(
        "ORGANIZATION_NOT_FOUND",
        "That church or club could not be found.",
      );
    }
    await validateParentOrganization(
      tx,
      existing.type,
      input.parentOrganizationId,
      organizationId,
    );

    if (isSponsorOrganizationType(existing.type) && existing.isActive && !input.isActive) {
      const activeClub = await tx.organization.findFirst({
        where: {
          parentOrganizationId: organizationId,
          type: "CLUB",
          isActive: true,
        },
        select: { id: true },
      });
      if (activeClub) {
        throw new OrganizationOperationError(
          "ORGANIZATION_HAS_ACTIVE_CLUBS",
          "Move or deactivate its active clubs before deactivating it.",
        );
      }
    }

    const changed = await tx.organization.updateMany({
      where: {
        id: organizationId,
        updatedAt: new Date(input.expectedUpdatedAt),
      },
      data: {
        name: input.name,
        normalizedName: normalizeOrganizationName(input.name),
        parentOrganizationId: input.parentOrganizationId,
        isActive: input.isActive,
      },
    });
    if (changed.count !== 1) {
      throw new OrganizationOperationError(
        "ORGANIZATION_CONFLICT",
        "This church or club changed after you opened it. Refresh before saving again.",
      );
    }
    await writeAuditLog({
      actorUserId,
      action: "ORGANIZATION_UPDATED",
      entityType: "Organization",
      entityId: organizationId,
      summary: `Updated ${input.name}.`,
      metadata: {
        previousName: existing.name,
        parentOrganizationId: input.parentOrganizationId,
        isActive: input.isActive,
      },
    }, tx);
  });
  return listOrganizations();
}

export async function addOrganizationExternalIdentity(
  organizationId: string,
  input: ExternalIdentityInput,
  actorUserId: string,
) {
  const prisma = getPrisma();
  try {
    await prisma.$transaction(async (tx) => {
      const organization = await tx.organization.findUnique({
        where: { id: organizationId },
        select: { id: true, name: true },
      });
      if (!organization) {
        throw new OrganizationOperationError(
          "ORGANIZATION_NOT_FOUND",
          "That church or club could not be found.",
        );
      }
      const identity = await tx.externalIdentity.create({
        data: {
          organizationId,
          provider: input.provider,
          providerScope: input.providerScope,
          externalId: input.externalId,
          displayLabel: input.displayLabel,
          lastVerifiedAt: new Date(),
        },
      });
      await writeAuditLog({
        actorUserId,
        action: "EXTERNAL_IDENTITY_LINKED",
        entityType: "ExternalIdentity",
        entityId: identity.id,
        summary: `Linked ${organization.name} to ${identity.provider}.`,
        metadata: {
          organizationId,
          provider: identity.provider,
          providerScope: identity.providerScope,
        },
      }, tx);
    });
  } catch (error) {
    if (isUniqueConstraint(error)) {
      throw new OrganizationOperationError(
        "EXTERNAL_IDENTITY_CONFLICT",
        "That provider identifier is already assigned, or this organization already has an identifier in that provider scope.",
      );
    }
    throw error;
  }
  return listOrganizations();
}

export async function updateOrganizationExternalIdentity(
  organizationId: string,
  identityId: string,
  input: UpdateExternalIdentityInput,
  actorUserId: string,
) {
  const prisma = getPrisma();
  try {
    await prisma.$transaction(async (tx) => {
      const existing = await tx.externalIdentity.findFirst({
        where: { id: identityId, organizationId },
        select: {
          id: true,
          provider: true,
          providerScope: true,
          externalId: true,
        },
      });
      if (!existing) {
        throw new OrganizationOperationError(
          "EXTERNAL_IDENTITY_NOT_FOUND",
          "That provider identifier could not be found for this organization.",
        );
      }
      const changed = await tx.externalIdentity.updateMany({
        where: {
          id: identityId,
          organizationId,
          updatedAt: new Date(input.expectedUpdatedAt),
        },
        data: {
          provider: input.provider,
          providerScope: input.providerScope,
          externalId: input.externalId,
          displayLabel: input.displayLabel,
          lastVerifiedAt: new Date(),
        },
      });
      if (changed.count !== 1) {
        throw new OrganizationOperationError(
          "EXTERNAL_IDENTITY_CONFLICT",
          "This provider identifier changed after you opened it. Refresh before saving again.",
        );
      }
      await writeAuditLog({
        actorUserId,
        action: "EXTERNAL_IDENTITY_UPDATED",
        entityType: "ExternalIdentity",
        entityId: identityId,
        summary: `Corrected the ${input.provider} identifier for an organization.`,
        metadata: {
          organizationId,
          previousProvider: existing.provider,
          previousProviderScope: existing.providerScope,
          provider: input.provider,
          providerScope: input.providerScope,
          externalIdChanged: existing.externalId !== input.externalId,
        },
      }, tx);
    });
  } catch (error) {
    if (isUniqueConstraint(error)) {
      throw new OrganizationOperationError(
        "EXTERNAL_IDENTITY_CONFLICT",
        "That provider identifier is already assigned, or this organization already has an identifier in that provider scope.",
      );
    }
    throw error;
  }
  return listOrganizations();
}

/**
 * What deleting a church or club would take with it, and what stops it (#386).
 *
 * A church with clubs under it is kept: move or delete the clubs first. A club
 * that has registered for an event, or has honor enrollments, is part of that
 * event's record and payments, so it is kept too — deactivate it instead.
 * Everything else a club owns (roster, club admins, invites, monthly reports,
 * profile) is deleted with it.
 */
export async function getOrganizationDeletionCheck(
  organizationId: string,
  client: Prisma.TransactionClient = getPrisma(),
) {
  const organization = await client.organization.findUnique({
    where: { id: organizationId },
    select: {
      id: true,
      type: true,
      name: true,
      _count: {
        select: {
          childOrganizations: true,
          eventRegistrations: true,
          honorEnrollments: true,
          rosterMembers: true,
          directorGrants: true,
          clubInvites: true,
          monthlyReports: true,
          externalIdentities: true,
          sponsoredPromoCodes: true,
          clubFormSubmissions: true,
          clubFormLinks: true,
          billingContacts: true,
          billingResponsibilities: true,
        },
      },
    },
  });
  if (!organization) {
    throw new OrganizationOperationError(
      "ORGANIZATION_NOT_FOUND",
      "That church or club could not be found.",
    );
  }
  const counts = organization._count;
  const blockers: string[] = [];
  if (counts.childOrganizations > 0) {
    blockers.push(`${counts.childOrganizations} club${counts.childOrganizations === 1 ? " is" : "s are"} listed under this church. Move or delete ${counts.childOrganizations === 1 ? "it" : "them"} first.`);
  }
  if (counts.eventRegistrations > 0) {
    blockers.push(`This club has registered for ${counts.eventRegistrations} event${counts.eventRegistrations === 1 ? "" : "s"}. Those registrations and payments are kept, so deactivate the club instead.`);
  }
  if (counts.sponsoredPromoCodes > 0) {
    blockers.push(`This church sponsors ${counts.sponsoredPromoCodes} promo code${counts.sponsoredPromoCodes === 1 ? "" : "s"}, and what it owes for them is kept. Deactivate the church instead, or unlink it from unused codes first.`);
  }
  const clubForms = (counts.clubFormSubmissions ?? 0) + (counts.clubFormLinks ?? 0);
  if (clubForms > 0) {
    blockers.push(`This club has ${counts.clubFormSubmissions ?? 0} filled club form${(counts.clubFormSubmissions ?? 0) === 1 ? "" : "s"} and ${counts.clubFormLinks ?? 0} private link${(counts.clubFormLinks ?? 0) === 1 ? "" : "s"}. Those are the club's files and may hold health and contact details, so they are kept. Deactivate the club instead.`);
  }
  if ((counts.billingContacts ?? 0) > 0 || (counts.billingResponsibilities ?? 0) > 0) {
    blockers.push(`This organization has ${counts.billingContacts ?? 0} billing contact${(counts.billingContacts ?? 0) === 1 ? "" : "s"} on record and is the responsible party for ${counts.billingResponsibilities ?? 0} registration${(counts.billingResponsibilities ?? 0) === 1 ? "" : "s"}. Billing records are kept, so deactivate it instead.`);
  }
  if (counts.honorEnrollments > 0) {
    blockers.push(`This club has ${counts.honorEnrollments} honor enrollment${counts.honorEnrollments === 1 ? "" : "s"}. Deactivate the club instead.`);
  }
  return {
    id: organization.id,
    type: organization.type,
    name: organization.name,
    blockers,
    removes: {
      rosterMembers: counts.rosterMembers,
      clubRoles: counts.directorGrants,
      invites: counts.clubInvites,
      monthlyReports: counts.monthlyReports,
      providerIdentifiers: counts.externalIdentities,
    },
  };
}

export type OrganizationDeletionCheck = Awaited<ReturnType<typeof getOrganizationDeletionCheck>>;

/** Deletes a church or club for good, after the name is typed to confirm it (#386). */
export async function deleteOrganization(
  organizationId: string,
  confirmName: string,
  actorUserId: string,
) {
  await getPrisma().$transaction(async (tx) => {
    const check = await getOrganizationDeletionCheck(organizationId, tx);
    if (confirmName.trim() !== check.name.trim()) {
      throw new OrganizationOperationError(
        "ORGANIZATION_DELETE_NAME_MISMATCH",
        `Type the name exactly as shown (${check.name}) to delete it.`,
      );
    }
    if (check.blockers.length > 0) {
      throw new OrganizationOperationError("ORGANIZATION_DELETE_BLOCKED", check.blockers[0]!);
    }
    // Restrict relations first; the rest cascade with the organization.
    await tx.clubRosterMember.deleteMany({ where: { organizationId } });
    await tx.clubDirectorGrant.deleteMany({ where: { organizationId } });
    const deleted = await tx.organization.deleteMany({ where: { id: organizationId } });
    if (deleted.count !== 1) {
      throw new OrganizationOperationError(
        "ORGANIZATION_NOT_FOUND",
        "That church or club could not be found.",
      );
    }
    await writeAuditLog({
      actorUserId,
      action: "ORGANIZATION_DELETED",
      entityType: "Organization",
      entityId: organizationId,
      summary: `Deleted a ${check.type.toLocaleLowerCase("en-US")}.`,
      metadata: { type: check.type, ...check.removes },
    }, tx);
  });
  return listOrganizations();
}
