import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The club stock routes behind the real roster gate (#531): neither
 * `modules/club-supplies/access` nor `modules/club-rosters/access` is mocked.
 * Only the lookups underneath them (the attendee session, club grants, MFA
 * enrollment, passkeys, the Area Coordinator grant, the staff act-as) and the
 * stock storage are stubbed.
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
  listClubStock: vi.fn(),
  setClubStockQuantity: vi.fn(),
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
vi.mock("@/modules/club-supplies/repository", async () => {
  const actual = await vi.importActual<typeof import("@/modules/club-supplies/repository")>("@/modules/club-supplies/repository");
  return { ...actual, listClubStock: mocks.listClubStock, setClubStockQuantity: mocks.setClubStockQuantity };
});

import { GET } from "@/app/api/attendee/clubs/[organizationId]/supplies/route";
import { PUT } from "@/app/api/attendee/clubs/[organizationId]/supplies/[itemId]/route";
import { ClubSupplyError } from "@/modules/club-supplies/repository";

const clubFor = (organizationId: string, role: string) => ({ organizationId, name: "Test Pathfinders", role, sponsoringChurch: null });
const account = { id: "director-1", verifiedEmail: "director@example.test", displayName: "Test Director" };
const ctx = (organizationId = "club-1") => ({ params: Promise.resolve({ organizationId }) });
const itemCtx = (organizationId = "club-1") => ({ params: Promise.resolve({ organizationId, itemId: "item-1" }) });
const getRequest = () => new Request("https://events.imsda.test/api/attendee/x");
const putRequest = (body: unknown) => new Request("https://events.imsda.test/api/attendee/x", {
  method: "PUT",
  headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
  body: JSON.stringify(body),
});

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
  mocks.listClubStock.mockResolvedValue([]);
  mocks.setClubStockQuantity.mockResolvedValue({ id: "stock-1", itemId: "item-1", quantityOnHand: 4 });
});

describe("club stock routes (#531): permissioned like the roster", () => {
  it.each(["DIRECTOR", "DEPUTY"])("a %s can view and edit their own club's stock", async (role) => {
    mocks.listDirectedClubs.mockResolvedValue([clubFor("club-1", role)]);
    const read = await GET(getRequest(), ctx());
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ canEdit: true });
    const write = await PUT(putRequest({ quantityOnHand: 4 }), itemCtx());
    expect(write.status).toBe(200);
    expect(mocks.setClubStockQuantity).toHaveBeenCalledWith("club-1", "item-1", 4, { accountId: "director-1" });
  });

  it("another club's director gets 404 on PUT, and nothing is saved", async () => {
    const write = await PUT(putRequest({ quantityOnHand: 4 }), itemCtx("club-2"));
    expect(write.status).toBe(404);
    expect(await write.json()).toMatchObject({ error: "NOT_FOUND" });
    expect((await GET(getRequest(), ctx("club-2"))).status).toBe(404);
    expect(mocks.setClubStockQuantity).not.toHaveBeenCalled();
    expect(mocks.listClubStock).not.toHaveBeenCalled();
  });

  it("a registrar views read-only and is refused the edit", async () => {
    mocks.listDirectedClubs.mockResolvedValue([clubFor("club-1", "REGISTRAR")]);
    const read = await GET(getRequest(), ctx());
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ canEdit: false });
    const write = await PUT(putRequest({ quantityOnHand: 4 }), itemCtx());
    expect(write.status).toBe(403);
    expect(await write.json()).toMatchObject({ error: "ROLE_NOT_ALLOWED" });
    expect(mocks.setClubStockQuantity).not.toHaveBeenCalled();
  });

  it("a reporter, who has no roster, is refused both", async () => {
    mocks.listDirectedClubs.mockResolvedValue([clubFor("club-1", "REPORTER")]);
    expect((await GET(getRequest(), ctx())).status).toBe(403);
    expect((await PUT(putRequest({ quantityOnHand: 4 }), itemCtx())).status).toBe(403);
    expect(mocks.listClubStock).not.toHaveBeenCalled();
  });

  it("a registrar's read-only view stays MFA-gated", async () => {
    mocks.listDirectedClubs.mockResolvedValue([clubFor("club-1", "REGISTRAR")]);
    mocks.findSession.mockResolvedValue({ secondFactorVerifiedAt: null });
    const read = await GET(getRequest(), ctx());
    expect(read.status).toBe(403);
    expect(await read.json()).toMatchObject({ error: "MFA_UNLOCK_REQUIRED" });
    expect(mocks.listClubStock).not.toHaveBeenCalled();
  });

  it("a director must unlock first; MFA_SETUP_REQUIRED without an authenticator", async () => {
    mocks.findSession.mockResolvedValue({ secondFactorVerifiedAt: null });
    expect(await (await PUT(putRequest({ quantityOnHand: 4 }), itemCtx())).json()).toMatchObject({ error: "MFA_UNLOCK_REQUIRED" });
    mocks.findEnrollment.mockResolvedValue(null);
    expect(await (await GET(getRequest(), ctx())).json()).toMatchObject({ error: "MFA_SETUP_REQUIRED" });
    expect(mocks.setClubStockQuantity).not.toHaveBeenCalled();
  });

  it("an Area Coordinator views read-only, can't edit, and gets 404 for a non-club organization", async () => {
    mocks.listDirectedClubs.mockResolvedValue([]);
    mocks.findAreaGrant.mockResolvedValue({ revokedAt: null, expiresAt: null });
    const read = await GET(getRequest(), ctx());
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ canEdit: false });
    expect((await PUT(putRequest({ quantityOnHand: 4 }), itemCtx())).status).toBe(404);
    expect(mocks.setClubStockQuantity).not.toHaveBeenCalled();
    mocks.findOrganization.mockResolvedValue({ type: "CHURCH", isActive: true });
    expect((await GET(getRequest(), ctx())).status).toBe(404);
  });

  it("rejects a negative or fractional quantity, and 404s an unknown item", async () => {
    expect((await PUT(putRequest({ quantityOnHand: -1 }), itemCtx())).status).toBe(400);
    expect((await PUT(putRequest({ quantityOnHand: 1.5 }), itemCtx())).status).toBe(400);
    mocks.setClubStockQuantity.mockRejectedValue(new ClubSupplyError("ITEM_NOT_FOUND", "That catalog item could not be found."));
    expect((await PUT(putRequest({ quantityOnHand: 1 }), itemCtx())).status).toBe(404);
  });

  it("a racing save conflict is 409 CATALOG_CONFLICT, not 404", async () => {
    mocks.setClubStockQuantity.mockRejectedValue(new ClubSupplyError("CATALOG_CONFLICT", "Try again."));
    const response = await PUT(putRequest({ quantityOnHand: 1 }), itemCtx());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "CATALOG_CONFLICT" });
  });
});
