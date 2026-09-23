import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rejectCrossOriginRequest: vi.fn(),
  requireSystemAdministrator: vi.fn(),
  requireHonorPermission: vi.fn(),
  createHonor: vi.fn(),
  createHonorOffering: vi.fn(),
  getEventHonorSetup: vi.fn(),
  listHonors: vi.fn(),
  previewHonorCopy: vi.fn(),
  applyHonorCopy: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/organizations/access", () => ({ requireSystemAdministrator: mocks.requireSystemAdministrator }));
vi.mock("@/modules/honors/access", () => ({ requireHonorPermission: mocks.requireHonorPermission }));
vi.mock("@/modules/honors/copy", () => ({
  previewHonorCopy: mocks.previewHonorCopy,
  applyHonorCopy: mocks.applyHonorCopy,
}));
vi.mock("@/modules/honors/repository", async () => {
  const actual = await vi.importActual<typeof import("@/modules/honors/repository")>("@/modules/honors/repository");
  return {
    ...actual,
    createHonor: mocks.createHonor,
    createHonorOffering: mocks.createHonorOffering,
    getEventHonorSetup: mocks.getEventHonorSetup,
    listHonors: mocks.listHonors,
  };
});

import { POST as POST_HONOR } from "@/app/api/admin/honors/route";
import { GET as GET_SETUP } from "@/app/api/events/[eventId]/honors/route";
import { POST as POST_OFFERING } from "@/app/api/events/[eventId]/honors/offerings/route";
import { POST as POST_COPY } from "@/app/api/events/[eventId]/honors/copy/route";
import { AccessDeniedError } from "@/modules/access/authorization";
import { HonorConfigurationError } from "@/modules/honors/repository";

const eventContext = { params: Promise.resolve({ eventId: "site-b" }) };
const setup = { sessions: [], offerings: [] };
const fingerprint = "a".repeat(64);

function request(body?: unknown) {
  return new Request("https://events.imsda.test/api/x", {
    method: body === undefined ? "GET" : "POST",
    headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.requireSystemAdministrator.mockResolvedValue({ id: "admin-1" });
  mocks.requireHonorPermission.mockResolvedValue({ user: { id: "staff-1" } });
  mocks.getEventHonorSetup.mockResolvedValue(setup);
  mocks.listHonors.mockResolvedValue([
    { id: "h1", code: "AR-011", name: "Knot Tying", isActive: true },
    { id: "h2", code: "XX-001", name: "Retired", isActive: false },
  ]);
  mocks.createHonor.mockResolvedValue([]);
  mocks.createHonorOffering.mockResolvedValue(setup);
  mocks.previewHonorCopy.mockResolvedValue({ fingerprint });
  mocks.applyHonorCopy.mockResolvedValue({ plan: {}, setup });
});

describe("honor catalog route", () => {
  it("needs a system administrator", async () => {
    mocks.requireSystemAdministrator.mockRejectedValue(new AccessDeniedError("No.", 403, "PERMISSION_DENIED"));
    const response = await POST_HONOR(request({ code: "AR-011", name: "Knot Tying" }));
    expect(response.status).toBe(403);
    expect(mocks.createHonor).not.toHaveBeenCalled();
  });

  it("rejects cross-origin writes before checking the account", async () => {
    mocks.rejectCrossOriginRequest.mockReturnValue(Response.json({}, { status: 403 }));
    expect((await POST_HONOR(request({}))).status).toBe(403);
    expect(mocks.requireSystemAdministrator).not.toHaveBeenCalled();
  });
});

describe("site honors routes", () => {
  it("requires event configuration permission for the site", async () => {
    mocks.requireHonorPermission.mockRejectedValue(new AccessDeniedError("No.", 403, "PERMISSION_DENIED"));
    expect((await GET_SETUP(request(), eventContext)).status).toBe(403);
    expect((await POST_OFFERING(request({}), eventContext)).status).toBe(403);
    expect(mocks.createHonorOffering).not.toHaveBeenCalled();
  });

  it("returns only active catalog honors with the setup", async () => {
    const body = await (await GET_SETUP(request(), eventContext)).json();
    expect(mocks.requireHonorPermission).toHaveBeenCalledWith("site-b");
    expect(body.catalog.map((honor: { id: string }) => honor.id)).toEqual(["h1"]);
  });

  it("validates, creates, and maps conflicts to 409", async () => {
    expect((await POST_OFFERING(request({ honorId: "h1", span: "SINGLE_SESSION", capacity: 5 }), eventContext)).status).toBe(400);
    const created = await POST_OFFERING(request({ honorId: "h1", span: "ALL_SESSIONS", capacity: 5 }), eventContext);
    expect(created.status).toBe(201);
    expect(mocks.createHonorOffering).toHaveBeenCalledWith("site-b", expect.objectContaining({ honorId: "h1" }), "staff-1");
    mocks.createHonorOffering.mockRejectedValue(new HonorConfigurationError("OFFERING_CONFLICT", "Already offered."));
    const conflict = await POST_OFFERING(request({ honorId: "h1", span: "ALL_SESSIONS", capacity: 5 }), eventContext);
    expect(conflict.status).toBe(409);
  });
});

describe("copy route", () => {
  it("previews without a fingerprint and checks access to the source site", async () => {
    const response = await POST_COPY(request({ sourceEventId: "site-a" }), eventContext);
    expect(response.status).toBe(200);
    expect(mocks.requireHonorPermission).toHaveBeenCalledWith("site-b");
    expect(mocks.requireHonorPermission).toHaveBeenCalledWith("site-a", "VIEW_EVENT");
    expect(mocks.previewHonorCopy).toHaveBeenCalledWith("site-b", "site-a");
    expect(mocks.applyHonorCopy).not.toHaveBeenCalled();
  });

  it("applies only with the reviewed fingerprint", async () => {
    await POST_COPY(request({ sourceEventId: "site-a", fingerprint }), eventContext);
    expect(mocks.applyHonorCopy).toHaveBeenCalledWith("site-b", "site-a", fingerprint, "staff-1");
    expect((await POST_COPY(request({ sourceEventId: "site-a", fingerprint: "bad" }), eventContext)).status).toBe(400);
  });

  it("refuses when the source site isn't visible to this person", async () => {
    mocks.requireHonorPermission.mockImplementation(async (eventId: string) => {
      if (eventId === "site-a") throw new AccessDeniedError("No.", 403, "EVENT_ACCESS_DENIED");
      return { user: { id: "staff-1" } };
    });
    expect((await POST_COPY(request({ sourceEventId: "site-a" }), eventContext)).status).toBe(403);
    expect(mocks.previewHonorCopy).not.toHaveBeenCalled();
  });

  it("returns a changed-source conflict as 409", async () => {
    mocks.applyHonorCopy.mockRejectedValue(new HonorConfigurationError("COPY_SOURCE_CHANGED", "Changed."));
    expect((await POST_COPY(request({ sourceEventId: "site-a", fingerprint }), eventContext)).status).toBe(409);
  });
});
