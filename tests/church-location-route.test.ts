import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccessDeniedError } from "@/modules/access/authorization";

const mocks = vi.hoisted(() => ({
  rejectCrossOriginRequest: vi.fn(),
  requireSystemAdministrator: vi.fn(),
  updateChurchLocation: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/request-security", () => ({
  rejectCrossOriginRequest: mocks.rejectCrossOriginRequest,
}));
vi.mock("@/modules/organizations/access", () => ({
  requireSystemAdministrator: mocks.requireSystemAdministrator,
}));
vi.mock("@/modules/organizations/church-location-repository", () => ({
  updateChurchLocation: mocks.updateChurchLocation,
}));

import { PATCH } from "@/app/api/admin/organizations/[organizationId]/location/route";

function request(body: unknown) {
  return new Request("https://events.imsda.test/api/admin/organizations/church-1/location", {
    method: "PATCH",
    headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const validBody = { city: "Ames", state: "IA", zip: "50010", latitude: 42.03, longitude: -93.62 };
const params = { params: Promise.resolve({ organizationId: "church-1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
});

describe("church location route (#437) — same gate as editing an organization", () => {
  it("requires system administrator access; a non-admin is refused", async () => {
    mocks.requireSystemAdministrator.mockRejectedValueOnce(
      new AccessDeniedError("System administrator access is required to manage churches and clubs.", 403, "PERMISSION_DENIED"),
    );
    const response = await PATCH(request(validBody), params);
    expect(response.status).toBe(403);
    expect(mocks.updateChurchLocation).not.toHaveBeenCalled();
  });

  it("saves a valid location for a system administrator", async () => {
    mocks.requireSystemAdministrator.mockResolvedValue({ id: "admin-1", globalRole: "SYSTEM_ADMIN" });
    mocks.updateChurchLocation.mockResolvedValue({ id: "church-1", name: "First Church", ...validBody, updatedAt: "2026-09-25T00:00:00.000Z" });
    const response = await PATCH(request(validBody), params);
    expect(response.status).toBe(200);
    expect(mocks.updateChurchLocation).toHaveBeenCalledWith("church-1", validBody, "admin-1");
  });

  it("rejects an out-of-range latitude before it ever reaches the repository", async () => {
    mocks.requireSystemAdministrator.mockResolvedValue({ id: "admin-1", globalRole: "SYSTEM_ADMIN" });
    const response = await PATCH(request({ ...validBody, latitude: 200 }), params);
    expect(response.status).toBe(400);
    expect(mocks.updateChurchLocation).not.toHaveBeenCalled();
  });
});
