import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rejectCrossOriginRequest: vi.fn(),
  requireSystemAdministrator: vi.fn(),
  listDirectorGrants: vi.fn(),
  createDirectorGrant: vi.fn(),
  revokeDirectorGrant: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/request-security", () => ({
  rejectCrossOriginRequest: mocks.rejectCrossOriginRequest,
}));
vi.mock("@/modules/organizations/access", () => ({
  requireSystemAdministrator: mocks.requireSystemAdministrator,
}));
vi.mock("@/modules/organizations/director-grants-repository", () => ({
  listDirectorGrants: mocks.listDirectorGrants,
  createDirectorGrant: mocks.createDirectorGrant,
  revokeDirectorGrant: mocks.revokeDirectorGrant,
}));

import { GET, POST } from "@/app/api/admin/organizations/[organizationId]/director-grants/route";
import { PATCH } from "@/app/api/admin/organizations/[organizationId]/director-grants/[grantId]/route";
import { AccessDeniedError } from "@/modules/access/authorization";
import { OrganizationOperationError } from "@/modules/organizations/repository";

const result = { club: { id: "club-1", name: "Test Pathfinders", isActive: true }, grants: [] };
const clubContext = { params: Promise.resolve({ organizationId: "club-1" }) };
const grantContext = { params: Promise.resolve({ organizationId: "club-1", grantId: "grant-1" }) };

function request(method: string, body?: unknown) {
  return new Request("https://events.imsda.test/api/admin/organizations/club-1/director-grants", {
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
  mocks.requireSystemAdministrator.mockResolvedValue({ id: "admin-1", globalRole: "SYSTEM_ADMIN" });
  mocks.listDirectorGrants.mockResolvedValue(result);
  mocks.createDirectorGrant.mockResolvedValue(result);
  mocks.revokeDirectorGrant.mockResolvedValue(result);
});

describe("club director routes", () => {
  it("lists grants for a system administrator", async () => {
    const response = await GET(request("GET"), clubContext);
    expect(response.status).toBe(200);
    expect(mocks.listDirectorGrants).toHaveBeenCalledWith("club-1");
  });

  it("refuses anyone who is not a system administrator", async () => {
    mocks.requireSystemAdministrator.mockRejectedValue(
      new AccessDeniedError("System administrator access is required.", 403, "PERMISSION_DENIED"),
    );
    expect((await GET(request("GET"), clubContext)).status).toBe(403);
    expect((await POST(request("POST", { email: "a@example.test", reason: "Board" }), clubContext)).status).toBe(403);
    expect(mocks.listDirectorGrants).not.toHaveBeenCalled();
    expect(mocks.createDirectorGrant).not.toHaveBeenCalled();
  });

  it("creates a grant with the parsed input and the acting admin", async () => {
    const response = await POST(request("POST", {
      email: "Director@Example.test",
      role: "DEPUTY",
      reason: "Church board vote",
    }), clubContext);
    expect(response.status).toBe(201);
    expect(mocks.createDirectorGrant).toHaveBeenCalledWith(
      "club-1",
      expect.objectContaining({ email: "director@example.test", role: "DEPUTY" }),
      "admin-1",
    );
  });

  it("rejects cross-origin writes before checking the account", async () => {
    mocks.rejectCrossOriginRequest.mockReturnValue(
      Response.json({ error: "INVALID_REQUEST_ORIGIN" }, { status: 403 }),
    );
    expect((await POST(request("POST", {}), clubContext)).status).toBe(403);
    expect((await PATCH(request("PATCH", {}), grantContext)).status).toBe(403);
    expect(mocks.requireSystemAdministrator).not.toHaveBeenCalled();
  });

  it("revokes with a reason and maps repository errors", async () => {
    expect((await PATCH(request("PATCH", { reason: "Stepped down" }), grantContext)).status).toBe(200);
    expect(mocks.revokeDirectorGrant).toHaveBeenCalledWith("club-1", "grant-1", "Stepped down", "admin-1");

    expect((await PATCH(request("PATCH", {}), grantContext)).status).toBe(400);

    mocks.revokeDirectorGrant.mockRejectedValueOnce(
      new OrganizationOperationError("DIRECTOR_GRANT_NOT_FOUND", "That director grant could not be found."),
    );
    expect((await PATCH(request("PATCH", { reason: "Again" }), grantContext)).status).toBe(404);

    mocks.createDirectorGrant.mockRejectedValueOnce(
      new OrganizationOperationError("DIRECTOR_GRANT_CONFLICT", "Overlaps."),
    );
    const conflict = await POST(request("POST", { email: "a@example.test", reason: "Board" }), clubContext);
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ error: "DIRECTOR_GRANT_CONFLICT" });
  });
});
