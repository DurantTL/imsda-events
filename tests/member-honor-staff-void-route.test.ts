import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireSystemAdministrator: vi.fn(),
  voidMemberHonorEntryAsStaff: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/organizations/access", () => ({ requireSystemAdministrator: mocks.requireSystemAdministrator }));
vi.mock("@/modules/honors/member-honor-repository", async () => {
  const actual = await vi.importActual<typeof import("@/modules/honors/member-honor-repository")>("@/modules/honors/member-honor-repository");
  return { ...actual, voidMemberHonorEntryAsStaff: mocks.voidMemberHonorEntryAsStaff };
});

import { POST } from "@/app/api/admin/honor-entries/[entryId]/void/route";
import { AccessDeniedError } from "@/modules/access/authorization";
import { MemberHonorError } from "@/modules/honors/member-honor-repository";

const ctx = { params: Promise.resolve({ entryId: "entry-1" }) };
const post = (body: unknown) => new Request("https://events.imsda.test/api/admin/honor-entries/entry-1/void", {
  method: "POST",
  headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.requireSystemAdministrator.mockResolvedValue({ id: "staff-1", globalRole: "SYSTEM_ADMIN" });
  mocks.voidMemberHonorEntryAsStaff.mockResolvedValue(undefined);
});

describe("staff void route (#591)", () => {
  it("lets a system administrator void by entry id, attributed to them", async () => {
    const response = await POST(post({ reason: "  Wrong person  " }), ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ voided: true });
    expect(mocks.voidMemberHonorEntryAsStaff).toHaveBeenCalledWith("entry-1", "Wrong person", "staff-1");
  });

  it("refuses staff without the permission, touching nothing", async () => {
    mocks.requireSystemAdministrator.mockRejectedValue(new AccessDeniedError("System administrator access is required.", 403, "PERMISSION_DENIED"));
    const response = await POST(post({ reason: "Wrong person" }), ctx);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "PERMISSION_DENIED" });
    expect(mocks.voidMemberHonorEntryAsStaff).not.toHaveBeenCalled();
  });

  it("refuses a signed-out caller", async () => {
    mocks.requireSystemAdministrator.mockRejectedValue(new AccessDeniedError("Sign in.", 401, "AUTHENTICATION_REQUIRED"));
    const response = await POST(post({ reason: "Wrong person" }), ctx);
    expect(response.status).toBe(401);
    expect(mocks.voidMemberHonorEntryAsStaff).not.toHaveBeenCalled();
  });

  it("requires a 3 to 500 character reason", async () => {
    for (const reason of ["", " ab ", "x".repeat(501)]) {
      const response = await POST(post({ reason }), ctx);
      expect(response.status).toBe(400);
    }
    expect(mocks.voidMemberHonorEntryAsStaff).not.toHaveBeenCalled();
  });

  it("answers 409 for a double void and 404 for a missing entry", async () => {
    mocks.voidMemberHonorEntryAsStaff.mockRejectedValueOnce(new MemberHonorError("ENTRY_ALREADY_VOIDED", "This entry has already been voided."));
    const twice = await POST(post({ reason: "Wrong person" }), ctx);
    expect(twice.status).toBe(409);
    expect(await twice.json()).toMatchObject({ error: "ENTRY_ALREADY_VOIDED" });
    mocks.voidMemberHonorEntryAsStaff.mockRejectedValueOnce(new MemberHonorError("ENTRY_NOT_FOUND", "That honor entry could not be found."));
    expect((await POST(post({ reason: "Wrong person" }), ctx)).status).toBe(404);
  });
});
