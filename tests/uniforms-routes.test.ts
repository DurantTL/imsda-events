import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The uniform routes (#497) behind the real roster gate, same as the order
 * routes (#487) and club supplies (#531): only the lookups underneath and the
 * uniform storage are stubbed.
 */
const mocks = vi.hoisted(() => ({
  getCurrentAttendee: vi.fn(),
  listDirectedClubs: vi.fn(),
  findEnrollment: vi.fn(),
  findSession: vi.fn(),
  countPasskeys: vi.fn(),
  findSettings: vi.fn(),
  findAreaGrant: vi.fn(),
  findOrganization: vi.fn(),
  loadUniformWorkspace: vi.fn(),
  recordUniformNeeds: vi.fn(),
  removeUniformNeeds: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/attendee-accounts/sign-in-gate", () => ({ accountNeedsSecondStep: async () => "OK" }));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    attendeeMfaEnrollment: { findUnique: mocks.findEnrollment },
    attendeeSession: { findUnique: mocks.findSession },
    attendeePasskey: { count: mocks.countPasskeys },
    platformSettings: { findUnique: mocks.findSettings },
    areaCoordinatorGrant: { findUnique: mocks.findAreaGrant },
    organization: { findUnique: mocks.findOrganization },
  }),
}));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: mocks.getCurrentAttendee }));
vi.mock("@/modules/organizations/director-access", () => ({ listDirectedClubs: mocks.listDirectedClubs }));
vi.mock("@/modules/organizations/staff-act-as", () => ({ currentStaffActingContext: async () => null }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: () => null }));
vi.mock("@/modules/uniforms/order-source", () => ({
  loadUniformWorkspace: mocks.loadUniformWorkspace,
  recordUniformNeeds: mocks.recordUniformNeeds,
  removeUniformNeeds: mocks.removeUniformNeeds,
}));

import { GET, POST } from "@/app/api/attendee/clubs/[organizationId]/uniforms/route";
import { POST as POST_REMOVE } from "@/app/api/attendee/clubs/[organizationId]/uniforms/remove/route";
import { ClubOrderError } from "@/modules/club-orders/repository";

const clubFor = (organizationId: string, role: string) => ({ organizationId, name: "Test Pathfinders", role, sponsoringChurch: null });
const account = { id: "director-1", verifiedEmail: "director@example.test", displayName: "Test Director" };
const ctx = (organizationId = "club-1") => ({ params: Promise.resolve({ organizationId }) });
const getRequest = () => new Request("https://events.imsda.test/api/attendee/x");
const postRequest = (body: unknown) => new Request("https://events.imsda.test/api/attendee/x", {
  method: "POST",
  headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
  body: JSON.stringify(body),
});
const entry = { personIds: ["p1", "p2"], itemIds: ["scarf", "slide"] };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getCurrentAttendee.mockResolvedValue({ account, via: "attendee", sessionId: "session-1" });
  mocks.listDirectedClubs.mockResolvedValue([clubFor("club-1", "DIRECTOR")]);
  mocks.findEnrollment.mockResolvedValue({ status: "ACTIVE" });
  mocks.findSession.mockResolvedValue({ secondFactorVerifiedAt: new Date(Date.now() - 60_000) });
  mocks.countPasskeys.mockResolvedValue(0);
  mocks.findSettings.mockResolvedValue({ passkeyRpId: null });
  mocks.findAreaGrant.mockResolvedValue(null);
  mocks.findOrganization.mockResolvedValue({ type: "CLUB", isActive: true });
  mocks.loadUniformWorkspace.mockResolvedValue({ catalog: [], members: [], needs: [], issuedCount: 0 });
  mocks.recordUniformNeeds.mockResolvedValue({ created: 4, skipped: 0, alreadyHadOne: 0 });
  mocks.removeUniformNeeds.mockResolvedValue({ removed: 1 });
});

describe("uniform routes (#497)", () => {
  it.each(["DIRECTOR", "DEPUTY"])("a %s can load the picker and record needs in bulk", async (role) => {
    mocks.listDirectedClubs.mockResolvedValue([clubFor("club-1", role)]);
    const read = await GET(getRequest(), ctx());
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ canEdit: true });
    expect(mocks.loadUniformWorkspace).toHaveBeenCalledWith("club-1", { forEditing: true });
    const write = await POST(postRequest(entry), ctx());
    expect(write.status).toBe(200);
    expect(mocks.recordUniformNeeds).toHaveBeenCalledWith(
      "club-1", { ...entry, alreadyHasOne: false }, { accountId: "director-1" },
    );
    const remove = await POST_REMOVE(postRequest({ needIds: ["n1"] }), ctx());
    expect(remove.status).toBe(200);
    expect(mocks.removeUniformNeeds).toHaveBeenCalledWith("club-1", ["n1"], { accountId: "director-1" });
  });

  it("passes 'already has one' through", async () => {
    await POST(postRequest({ ...entry, alreadyHasOne: true }), ctx());
    expect(mocks.recordUniformNeeds).toHaveBeenCalledWith("club-1", { ...entry, alreadyHasOne: true }, { accountId: "director-1" });
  });

  it("a registrar views read-only and never writes", async () => {
    mocks.listDirectedClubs.mockResolvedValue([clubFor("club-1", "REGISTRAR")]);
    const read = await GET(getRequest(), ctx());
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ canEdit: false });
    expect(mocks.loadUniformWorkspace).toHaveBeenCalledWith("club-1", { forEditing: false });
    expect((await POST(postRequest(entry), ctx())).status).toBe(403);
    expect((await POST_REMOVE(postRequest({ needIds: ["n1"] }), ctx())).status).toBe(403);
    expect(mocks.recordUniformNeeds).not.toHaveBeenCalled();
    expect(mocks.removeUniformNeeds).not.toHaveBeenCalled();
  });

  it("an Area Coordinator views read-only and can't record or remove", async () => {
    mocks.listDirectedClubs.mockResolvedValue([]);
    mocks.findAreaGrant.mockResolvedValue({ revokedAt: null, expiresAt: null });
    const read = await GET(getRequest(), ctx());
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ canEdit: false });
    expect(mocks.loadUniformWorkspace).toHaveBeenCalledWith("club-1", { forEditing: false });
    expect((await POST(postRequest(entry), ctx())).status).toBe(404);
    expect((await POST_REMOVE(postRequest({ needIds: ["n1"] }), ctx())).status).toBe(404);
    expect(mocks.recordUniformNeeds).not.toHaveBeenCalled();
    expect(mocks.removeUniformNeeds).not.toHaveBeenCalled();
  });

  it("another club's director gets 404 and nothing runs", async () => {
    expect((await GET(getRequest(), ctx("club-2"))).status).toBe(404);
    expect((await POST(postRequest(entry), ctx("club-2"))).status).toBe(404);
    expect(mocks.loadUniformWorkspace).not.toHaveBeenCalled();
    expect(mocks.recordUniformNeeds).not.toHaveBeenCalled();
  });

  it("refuses a malformed entry with 400 before touching storage", async () => {
    expect((await POST(postRequest({ personIds: [], itemIds: ["scarf"] }), ctx())).status).toBe(400);
    expect((await POST(postRequest({ ...entry, organizationId: "club-2" }), ctx())).status).toBe(400);
    expect((await POST_REMOVE(postRequest({ needIds: [] }), ctx())).status).toBe(400);
    expect(mocks.recordUniformNeeds).not.toHaveBeenCalled();
    expect(mocks.removeUniformNeeds).not.toHaveBeenCalled();
  });

  it("maps an ineligible item or a member off the roster to 409", async () => {
    mocks.recordUniformNeeds.mockRejectedValueOnce(new ClubOrderError("ITEM_NOT_ORDERABLE", "Not a uniform item."));
    expect((await POST(postRequest(entry), ctx())).status).toBe(409);
    mocks.recordUniformNeeds.mockRejectedValueOnce(new ClubOrderError("MEMBER_NOT_ON_ROSTER", "Not on the roster."));
    expect((await POST(postRequest(entry), ctx())).status).toBe(409);
  });
});
