import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rejectCrossOriginRequest: vi.fn(),
  requireSystemAdministrator: vi.fn(),
  listOrganizations: vi.fn(),
  createOrganization: vi.fn(),
  updateOrganization: vi.fn(),
  addOrganizationExternalIdentity: vi.fn(),
  updateOrganizationExternalIdentity: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/request-security", () => ({
  rejectCrossOriginRequest: mocks.rejectCrossOriginRequest,
}));
vi.mock("@/modules/organizations/access", () => ({
  requireSystemAdministrator: mocks.requireSystemAdministrator,
}));
vi.mock("@/modules/organizations/repository", async () => {
  const actual = await vi.importActual<
    typeof import("@/modules/organizations/repository")
  >("@/modules/organizations/repository");
  return {
    ...actual,
    listOrganizations: mocks.listOrganizations,
    createOrganization: mocks.createOrganization,
    updateOrganization: mocks.updateOrganization,
    addOrganizationExternalIdentity: mocks.addOrganizationExternalIdentity,
    updateOrganizationExternalIdentity: mocks.updateOrganizationExternalIdentity,
  };
});

import {
  GET,
  POST,
} from "@/app/api/admin/organizations/route";
import { PATCH } from "@/app/api/admin/organizations/[organizationId]/route";
import { POST as POST_IDENTITY } from "@/app/api/admin/organizations/[organizationId]/external-identities/route";
import { PATCH as PATCH_IDENTITY } from "@/app/api/admin/organizations/[organizationId]/external-identities/[identityId]/route";
import { OrganizationOperationError } from "@/modules/organizations/repository";

const organizations = [{ id: "church-1", name: "North Church" }];

function request(method: string, path: string, body?: unknown) {
  return new Request(`https://events.imsda.test${path}`, {
    method,
    headers: {
      origin: "https://events.imsda.test",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.requireSystemAdministrator.mockResolvedValue({
    id: "admin-1",
    globalRole: "SYSTEM_ADMIN",
  });
  mocks.listOrganizations.mockResolvedValue(organizations);
  mocks.createOrganization.mockResolvedValue(organizations);
  mocks.updateOrganization.mockResolvedValue(organizations);
  mocks.addOrganizationExternalIdentity.mockResolvedValue(organizations);
  mocks.updateOrganizationExternalIdentity.mockResolvedValue(organizations);
});

describe("system organization routes", () => {
  it("lists the shared directory for a system administrator", async () => {
    const response = await GET(request("GET", "/api/admin/organizations"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ organizations });
  });

  it("creates a normalized church record", async () => {
    const response = await POST(request("POST", "/api/admin/organizations", {
      type: "CHURCH",
      name: "  North Church  ",
      parentOrganizationId: "",
      isActive: true,
    }));

    expect(response.status).toBe(201);
    expect(mocks.createOrganization).toHaveBeenCalledWith({
      type: "CHURCH",
      name: "North Church",
      parentOrganizationId: null,
      isActive: true,
    }, "admin-1");
  });

  it("requires the edit timestamp before updating a record", async () => {
    const response = await PATCH(request(
      "PATCH",
      "/api/admin/organizations/church-1",
      {
        name: "North Church",
        parentOrganizationId: null,
        isActive: true,
      },
    ), { params: Promise.resolve({ organizationId: "church-1" }) });

    expect(response.status).toBe(400);
    expect(mocks.updateOrganization).not.toHaveBeenCalled();
  });

  it("links a normalized provider identity to the route organization", async () => {
    const response = await POST_IDENTITY(request(
      "POST",
      "/api/admin/organizations/church-1/external-identities",
      {
        provider: "EADVENTIST",
        providerScope: "  IMSDA Main ",
        externalId: "  org-42 ",
        displayLabel: "",
      },
    ), { params: Promise.resolve({ organizationId: "church-1" }) });

    expect(response.status).toBe(201);
    expect(mocks.addOrganizationExternalIdentity).toHaveBeenCalledWith(
      "church-1",
      {
        provider: "EADVENTIST",
        providerScope: "imsda main",
        externalId: "org-42",
        displayLabel: null,
      },
      "admin-1",
    );
  });

  it("uses optimistic concurrency when correcting a provider identifier", async () => {
    const response = await PATCH_IDENTITY(request(
      "PATCH",
      "/api/admin/organizations/church-1/external-identities/identity-1",
      {
        provider: "EADVENTIST",
        providerScope: "imsda",
        externalId: "org-42",
        displayLabel: null,
        expectedUpdatedAt: "2026-07-27T12:00:00.000Z",
      },
    ), {
      params: Promise.resolve({
        organizationId: "church-1",
        identityId: "identity-1",
      }),
    });

    expect(response.status).toBe(200);
    expect(mocks.updateOrganizationExternalIdentity).toHaveBeenCalledWith(
      "church-1",
      "identity-1",
      {
        provider: "EADVENTIST",
        providerScope: "imsda",
        externalId: "org-42",
        displayLabel: null,
        expectedUpdatedAt: "2026-07-27T12:00:00.000Z",
      },
      "admin-1",
    );
  });

  it("rejects a cross-origin mutation before checking the account", async () => {
    mocks.rejectCrossOriginRequest.mockReturnValue(
      Response.json({ error: "INVALID_REQUEST_ORIGIN" }, { status: 403 }),
    );
    const response = await POST(request("POST", "/api/admin/organizations", {
      type: "CHURCH",
      name: "North Church",
    }));

    expect(response.status).toBe(403);
    expect(mocks.requireSystemAdministrator).not.toHaveBeenCalled();
  });

  it("returns repository conflicts without hiding the actionable message", async () => {
    mocks.createOrganization.mockRejectedValue(
      new OrganizationOperationError(
        "ORGANIZATION_PARENT_INVALID",
        "Choose an active church.",
      ),
    );
    const response = await POST(request("POST", "/api/admin/organizations", {
      type: "CLUB",
      name: "North Pathfinders",
      parentOrganizationId: "club-1",
      isActive: true,
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "ORGANIZATION_PARENT_INVALID",
      message: "Choose an active church.",
    });
  });
});
