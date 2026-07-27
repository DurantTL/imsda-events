import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  writeAuditLog: vi.fn(),
  transaction: vi.fn(),
  findMany: vi.fn(),
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  updateMany: vi.fn(),
  createIdentity: vi.fn(),
  findIdentity: vi.fn(),
  updateIdentity: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/modules/audit/audit-service", () => ({
  writeAuditLog: mocks.writeAuditLog,
}));

import { Prisma } from "@prisma/client";
import {
  addOrganizationExternalIdentity,
  createOrganization,
  OrganizationOperationError,
  updateOrganization,
  updateOrganizationExternalIdentity,
} from "@/modules/organizations/repository";

const tx = {
  organization: {
    findUnique: mocks.findUnique,
    findFirst: mocks.findFirst,
    create: mocks.create,
    updateMany: mocks.updateMany,
  },
  externalIdentity: {
    create: mocks.createIdentity,
    findFirst: mocks.findIdentity,
    updateMany: mocks.updateIdentity,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation(
    async (callback: (client: typeof tx) => unknown) => callback(tx),
  );
  mocks.getPrisma.mockReturnValue({
    $transaction: mocks.transaction,
    organization: { findMany: mocks.findMany },
  });
  mocks.findMany.mockResolvedValue([]);
  mocks.writeAuditLog.mockResolvedValue({});
});

describe("organization repository invariants", () => {
  it("never permits a church to be nested under another organization", async () => {
    await expect(createOrganization({
      type: "CHURCH",
      name: "North Church",
      parentOrganizationId: "another-church",
      isActive: true,
    }, "actor-1")).rejects.toMatchObject({
      code: "ORGANIZATION_PARENT_NOT_ALLOWED",
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("only accepts an active church as a club sponsor", async () => {
    mocks.findUnique.mockResolvedValue({ type: "CLUB", isActive: true });

    await expect(createOrganization({
      type: "CLUB",
      name: "North Pathfinders",
      parentOrganizationId: "not-a-church",
      isActive: true,
    }, "actor-1")).rejects.toMatchObject({
      code: "ORGANIZATION_PARENT_INVALID",
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("creates a club and records an audit entry without changing event data", async () => {
    mocks.findUnique.mockResolvedValue({ type: "CHURCH", isActive: true });
    mocks.create.mockResolvedValue({
      id: "club-1",
      type: "CLUB",
      name: "North Pathfinders",
      parentOrganizationId: "church-1",
    });

    await expect(createOrganization({
      type: "CLUB",
      name: "North Pathfinders",
      parentOrganizationId: "church-1",
      isActive: true,
    }, "actor-1")).resolves.toEqual([]);

    expect(mocks.create).toHaveBeenCalledWith({
      data: {
        type: "CLUB",
        name: "North Pathfinders",
        normalizedName: "north pathfinders",
        parentOrganizationId: "church-1",
        isActive: true,
      },
    });
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: "actor-1",
        action: "ORGANIZATION_CREATED",
        entityType: "Organization",
        entityId: "club-1",
      }),
      tx,
    );
  });

  it("refuses to deactivate a church while an active club depends on it", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "church-1",
      type: "CHURCH",
      name: "North Church",
      isActive: true,
    });
    mocks.findFirst.mockResolvedValue({ id: "club-1" });

    await expect(updateOrganization("church-1", {
      name: "North Church",
      parentOrganizationId: null,
      isActive: false,
      expectedUpdatedAt: "2026-07-27T12:00:00.000Z",
    }, "actor-1")).rejects.toMatchObject({
      code: "ORGANIZATION_HAS_ACTIVE_CLUBS",
    });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("detects a stale organization edit instead of overwriting it", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "club-1",
      type: "CLUB",
      name: "North Pathfinders",
      isActive: true,
    });
    mocks.updateMany.mockResolvedValue({ count: 0 });

    await expect(updateOrganization("club-1", {
      name: "North Pathfinder Club",
      parentOrganizationId: null,
      isActive: true,
      expectedUpdatedAt: "2026-07-27T12:00:00.000Z",
    }, "actor-1")).rejects.toMatchObject({
      code: "ORGANIZATION_CONFLICT",
    });
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("turns provider uniqueness failures into a reviewable conflict", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "church-1",
      name: "North Church",
    });
    mocks.createIdentity.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("duplicate", {
        code: "P2002",
        clientVersion: "6.19.3",
      }),
    );

    await expect(addOrganizationExternalIdentity("church-1", {
      provider: "EADVENTIST",
      providerScope: "imsda",
      externalId: "org-42",
      displayLabel: null,
    }, "actor-1")).rejects.toBeInstanceOf(OrganizationOperationError);
    await expect(addOrganizationExternalIdentity("church-1", {
      provider: "EADVENTIST",
      providerScope: "imsda",
      externalId: "org-42",
      displayLabel: null,
    }, "actor-1")).rejects.toMatchObject({
      code: "EXTERNAL_IDENTITY_CONFLICT",
    });
  });

  it("does not overwrite a provider identifier changed by another administrator", async () => {
    mocks.findIdentity.mockResolvedValue({
      id: "identity-1",
      provider: "EADVENTIST",
      providerScope: "imsda",
      externalId: "org-41",
    });
    mocks.updateIdentity.mockResolvedValue({ count: 0 });

    await expect(updateOrganizationExternalIdentity(
      "church-1",
      "identity-1",
      {
        provider: "EADVENTIST",
        providerScope: "imsda",
        externalId: "org-42",
        displayLabel: null,
        expectedUpdatedAt: "2026-07-27T12:00:00.000Z",
      },
      "actor-1",
    )).rejects.toMatchObject({
      code: "EXTERNAL_IDENTITY_CONFLICT",
    });
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });
});
