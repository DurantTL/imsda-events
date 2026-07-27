import "server-only";

import {
  Prisma,
  type OrganizationType,
} from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { normalizeOrganizationName } from "@/modules/organizations/domain";
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
  | "ORGANIZATION_HAS_ACTIVE_CLUBS"
  | "EXTERNAL_IDENTITY_NOT_FOUND"
  | "EXTERNAL_IDENTITY_CONFLICT";

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
  if (type === "CHURCH") {
    if (parentOrganizationId !== null) {
      throw new OrganizationOperationError(
        "ORGANIZATION_PARENT_NOT_ALLOWED",
        "A church cannot be placed under another church or club.",
      );
    }
    return;
  }

  if (parentOrganizationId === null) return;
  if (parentOrganizationId === organizationId) {
    throw new OrganizationOperationError(
      "ORGANIZATION_PARENT_INVALID",
      "A club cannot be its own sponsoring church.",
    );
  }
  const parent = await tx.organization.findUnique({
    where: { id: parentOrganizationId },
    select: { type: true, isActive: true },
  });
  if (!parent || parent.type !== "CHURCH" || !parent.isActive) {
    throw new OrganizationOperationError(
      "ORGANIZATION_PARENT_INVALID",
      "Choose an active church as the club's sponsoring organization.",
    );
  }
}

export async function listOrganizations() {
  const organizations = await getPrisma().organization.findMany({
    include: organizationInclude,
    orderBy: [
      { isActive: "desc" },
      { type: "asc" },
      { name: "asc" },
    ],
  });
  return organizations.map(serializeOrganization);
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

    if (existing.type === "CHURCH" && existing.isActive && !input.isActive) {
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
          "Move or deactivate this church's active clubs before deactivating the church.",
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
