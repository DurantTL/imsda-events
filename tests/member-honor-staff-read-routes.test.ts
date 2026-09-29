import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireSystemAdministrator: vi.fn(),
  findOrganization: vi.fn(),
  listClubHonorsPage: vi.fn(),
  listActiveHonorOptions: vi.fn(),
  listMemberHonorHistory: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => ({ organization: { findUnique: mocks.findOrganization } }) }));
vi.mock("@/modules/organizations/access", () => ({ requireSystemAdministrator: mocks.requireSystemAdministrator }));
vi.mock("@/modules/honors/member-honor-repository", async () => {
  const actual = await vi.importActual<typeof import("@/modules/honors/member-honor-repository")>("@/modules/honors/member-honor-repository");
  return {
    ...actual,
    listClubHonorsPage: mocks.listClubHonorsPage,
    listActiveHonorOptions: mocks.listActiveHonorOptions,
    listMemberHonorHistory: mocks.listMemberHonorHistory,
  };
});

import { GET as CLUB_HONORS_GET } from "@/app/api/admin/organizations/[organizationId]/honors/route";
import { GET as MEMBER_HISTORY_GET } from "@/app/api/admin/organizations/[organizationId]/roster/[memberId]/honors/route";
import { AccessDeniedError } from "@/modules/access/authorization";

const clubCtx = { params: Promise.resolve({ organizationId: "club-1" }) };
const memberCtx = { params: Promise.resolve({ organizationId: "club-1", memberId: "member-1" }) };
const request = () => new Request("https://events.imsda.test/api/admin/x");

const signedOut = () => new AccessDeniedError("Sign in.", 401, "AUTHENTICATION_REQUIRED");
const notAdmin = () => new AccessDeniedError("System administrator access is required.", 403, "PERMISSION_DENIED");

const routes = [
  ["club honors list", () => CLUB_HONORS_GET(request(), clubCtx)],
  ["member honor history", () => MEMBER_HISTORY_GET(request(), memberCtx)],
] as const;

function expectNothingRead() {
  expect(mocks.findOrganization).not.toHaveBeenCalled();
  expect(mocks.listClubHonorsPage).not.toHaveBeenCalled();
  expect(mocks.listActiveHonorOptions).not.toHaveBeenCalled();
  expect(mocks.listMemberHonorHistory).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireSystemAdministrator.mockResolvedValue({ id: "staff-1", globalRole: "SYSTEM_ADMIN" });
  mocks.findOrganization.mockResolvedValue({ type: "CLUB" });
  mocks.listClubHonorsPage.mockResolvedValue([]);
  mocks.listActiveHonorOptions.mockResolvedValue([]);
  mocks.listMemberHonorHistory.mockResolvedValue({ firstName: "Test", lastName: "Member", current: [], history: [] });
});

describe("staff honors read routes (#591)", () => {
  it.each(routes)("%s: 401 when signed out, reading nothing", async (_name, call) => {
    mocks.requireSystemAdministrator.mockRejectedValue(signedOut());
    const response = await call();
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "AUTHENTICATION_REQUIRED" });
    expectNothingRead();
  });

  it.each(routes)("%s: 403 for a non-admin, reading nothing", async (_name, call) => {
    mocks.requireSystemAdministrator.mockRejectedValue(notAdmin());
    const response = await call();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "PERMISSION_DENIED" });
    expectNothingRead();
  });

  it("the club list is read only for a system administrator", async () => {
    const response = await CLUB_HONORS_GET(request(), clubCtx);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ rows: [], honors: [], readOnly: true });
    expect(mocks.listClubHonorsPage).toHaveBeenCalledWith("club-1", expect.any(String));
  });

  it("the club list answers 404 for an organization that isn't a club, or doesn't exist, reading nothing", async () => {
    for (const found of [{ type: "CHURCH" }, null]) {
      mocks.findOrganization.mockResolvedValue(found);
      const response = await CLUB_HONORS_GET(request(), clubCtx);
      expect(response.status).toBe(404);
    }
    expect(mocks.listClubHonorsPage).not.toHaveBeenCalled();
    expect(mocks.listActiveHonorOptions).not.toHaveBeenCalled();
  });

  it("the club list still opens for an inactive club", async () => {
    mocks.findOrganization.mockResolvedValue({ type: "CLUB", isActive: false });
    expect((await CLUB_HONORS_GET(request(), clubCtx)).status).toBe(200);
  });

  it("the member history returns for a system administrator", async () => {
    const response = await MEMBER_HISTORY_GET(request(), memberCtx);
    expect(response.status).toBe(200);
    expect(mocks.listMemberHonorHistory).toHaveBeenCalledWith("club-1", "member-1");
  });
});
