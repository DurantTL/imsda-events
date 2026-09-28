import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireGlobalDriverReviewAccess: vi.fn(),
  listDriverExceptions: vi.fn(),
  recordDriverClearance: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/driver-verification/access", async () => {
  const actual = await vi.importActual<typeof import("@/modules/driver-verification/access")>("@/modules/driver-verification/access");
  return { ...actual, requireGlobalDriverReviewAccess: mocks.requireGlobalDriverReviewAccess };
});
vi.mock("@/modules/driver-verification/repository", async () => {
  const actual = await vi.importActual<typeof import("@/modules/driver-verification/repository")>("@/modules/driver-verification/repository");
  return { ...actual, listDriverExceptions: mocks.listDriverExceptions, recordDriverClearance: mocks.recordDriverClearance };
});

import { AccessDeniedError } from "@/modules/access/authorization";
import { DriverVerificationError } from "@/modules/driver-verification/repository";
import { GET as adminList } from "@/app/api/admin/driver-verification/route";
import { POST as adminOverride } from "@/app/api/admin/driver-verification/[personId]/route";

const jsonRequest = (url: string, body: unknown) => new Request(url, {
  method: "POST",
  headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
  body: JSON.stringify(body),
});

const validOverride = { clearedToTransport: true, note: "Confirmed by phone." };
const overrideUrl = "https://events.imsda.test/api/admin/driver-verification/person-1";
const personContext = { params: Promise.resolve({ personId: "person-1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.listDriverExceptions.mockResolvedValue([]);
});

describe("the conference-wide driver exceptions (system admin only)", () => {
  const adminListRequest = () => new Request("https://events.imsda.test/api/admin/driver-verification");

  it("refuses anyone who isn't a system administrator", async () => {
    mocks.requireGlobalDriverReviewAccess.mockRejectedValue(new AccessDeniedError("nope", 403, "PERMISSION_DENIED"));
    const response = await adminList(adminListRequest());
    expect(response.status).toBe(403);
    expect(mocks.listDriverExceptions).not.toHaveBeenCalled();
  });

  it("lists the exceptions for a system administrator", async () => {
    mocks.requireGlobalDriverReviewAccess.mockResolvedValue({ userId: "admin-1" });
    mocks.listDriverExceptions.mockResolvedValue([{ personId: "person-1" }]);
    const response = await adminList(adminListRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ entries: [{ personId: "person-1" }] });
  });

  it("requires a note on an override, before recording anything", async () => {
    mocks.requireGlobalDriverReviewAccess.mockResolvedValue({ userId: "admin-1" });
    for (const body of [{ clearedToTransport: true }, { clearedToTransport: true, note: "  " }]) {
      const response = await adminOverride(jsonRequest(overrideUrl, body), personContext);
      expect(response.status).toBe(400);
    }
    expect(mocks.recordDriverClearance).not.toHaveBeenCalled();
  });

  it("refuses a license or insurance field", async () => {
    mocks.requireGlobalDriverReviewAccess.mockResolvedValue({ userId: "admin-1" });
    const response = await adminOverride(jsonRequest(overrideUrl, { ...validOverride, licenseNumber: "D1234567" }), personContext);
    expect(response.status).toBe(400);
    expect(mocks.recordDriverClearance).not.toHaveBeenCalled();
  });

  it("records a system administrator's override", async () => {
    mocks.requireGlobalDriverReviewAccess.mockResolvedValue({ userId: "admin-1" });
    mocks.recordDriverClearance.mockResolvedValue(undefined);
    const response = await adminOverride(jsonRequest(overrideUrl, validOverride), personContext);
    expect(response.status).toBe(200);
    expect(mocks.recordDriverClearance).toHaveBeenCalledWith(
      "person-1", { clearedToTransport: true, note: "Confirmed by phone." }, { userId: "admin-1" },
    );
  });

  it("turns self-nomination into a 403, never a silent clear", async () => {
    mocks.requireGlobalDriverReviewAccess.mockResolvedValue({ userId: "admin-1" });
    mocks.recordDriverClearance.mockRejectedValue(new DriverVerificationError("SELF_REVIEW", "You can't clear yourself."));
    const response = await adminOverride(jsonRequest(overrideUrl, validOverride), personContext);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "SELF_REVIEW" });
  });

  it("refuses an override from anyone who isn't a system administrator", async () => {
    mocks.requireGlobalDriverReviewAccess.mockRejectedValue(new AccessDeniedError("nope", 403, "PERMISSION_DENIED"));
    const response = await adminOverride(jsonRequest(overrideUrl, validOverride), personContext);
    expect(response.status).toBe(403);
    expect(mocks.recordDriverClearance).not.toHaveBeenCalled();
  });
});
