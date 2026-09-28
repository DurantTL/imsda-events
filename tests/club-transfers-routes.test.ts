import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireClubTransferAccess: vi.fn(),
  requireStaffTransferAccess: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
  checkClubTransferRequestRateLimit: vi.fn(),
  requestTransfer: vi.fn(),
  listClubTransfers: vi.fn(),
  acceptTransfer: vi.fn(),
  declineTransfer: vi.fn(),
  cancelTransferByClub: vi.fn(),
  staffFinishTransfer: vi.fn(),
  staffOverrideTransfer: vi.fn(),
  staffCancelTransfer: vi.fn(),
  listStaffTransferQueue: vi.fn(),
  listStaffTransferCandidates: vi.fn(),
  listRegistrationMoves: vi.fn(),
  approveRegistrationMove: vi.fn(),
  skipRegistrationMove: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/rate-limit/service", () => ({ checkClubTransferRequestRateLimit: mocks.checkClubTransferRequestRateLimit }));
vi.mock("@/modules/club-transfers/access", async () => {
  const actual = await vi.importActual<typeof import("@/modules/club-transfers/access")>("@/modules/club-transfers/access");
  return { ...actual, requireClubTransferAccess: mocks.requireClubTransferAccess, requireStaffTransferAccess: mocks.requireStaffTransferAccess };
});
vi.mock("@/modules/club-transfers/repository", async () => {
  const actual = await vi.importActual<typeof import("@/modules/club-transfers/repository")>("@/modules/club-transfers/repository");
  return {
    ...actual,
    requestTransfer: mocks.requestTransfer,
    listClubTransfers: mocks.listClubTransfers,
    acceptTransfer: mocks.acceptTransfer,
    declineTransfer: mocks.declineTransfer,
    cancelTransferByClub: mocks.cancelTransferByClub,
    staffFinishTransfer: mocks.staffFinishTransfer,
    staffOverrideTransfer: mocks.staffOverrideTransfer,
    staffCancelTransfer: mocks.staffCancelTransfer,
    listStaffTransferQueue: mocks.listStaffTransferQueue,
    listStaffTransferCandidates: mocks.listStaffTransferCandidates,
    listRegistrationMoves: mocks.listRegistrationMoves,
    approveRegistrationMove: mocks.approveRegistrationMove,
    skipRegistrationMove: mocks.skipRegistrationMove,
  };
});

import { Prisma } from "@prisma/client";
import { AccessDeniedError } from "@/modules/access/authorization";
import { RosterAccessError } from "@/modules/club-rosters/access";
import { MemberTransferError } from "@/modules/club-transfers/repository";
import { GET as clubList, POST as clubRequest } from "@/app/api/attendee/clubs/[organizationId]/transfers/route";
import { POST as clubAccept } from "@/app/api/attendee/clubs/[organizationId]/transfers/[transferId]/accept/route";
import { POST as clubDecline } from "@/app/api/attendee/clubs/[organizationId]/transfers/[transferId]/decline/route";
import { POST as clubCancel } from "@/app/api/attendee/clubs/[organizationId]/transfers/[transferId]/cancel/route";
import { GET as staffQueue } from "@/app/api/admin/club-transfers/route";
import { POST as staffFinish } from "@/app/api/admin/club-transfers/[transferId]/finish/route";
import { POST as staffOverride } from "@/app/api/admin/club-transfers/[transferId]/override/route";
import { POST as staffCancel } from "@/app/api/admin/club-transfers/[transferId]/cancel/route";
import { GET as staffCandidates } from "@/app/api/admin/club-transfers/[transferId]/candidates/route";
import { GET as movesList } from "@/app/api/admin/club-transfers/registration-moves/route";
import { POST as moveApprove } from "@/app/api/admin/club-transfers/registration-moves/[moveId]/approve/route";
import { POST as moveSkip } from "@/app/api/admin/club-transfers/registration-moves/[moveId]/skip/route";

const base = "https://events.imsda.test";
const jsonRequest = (url: string, body: unknown) => new Request(`${base}${url}`, {
  method: "POST",
  headers: { origin: base, "content-type": "application/json" },
  body: JSON.stringify(body),
});
const clubActor = { kind: "ATTENDEE" as const, accountId: "director-1", sessionId: "session-1" };
const openAccess = { state: "OPEN", club: {}, capabilities: {}, actor: clubActor };
const clubCtx = { params: Promise.resolve({ organizationId: "club-b" }) };
const transferCtx = { params: Promise.resolve({ organizationId: "club-a", transferId: "transfer-1" }) };
const staffCtx = { params: Promise.resolve({ transferId: "transfer-1" }) };
const moveCtx = { params: Promise.resolve({ moveId: "move-1" }) };
const requestBody = { fromOrganizationId: "club-a", firstName: "Ada", lastName: "Testperson", reason: "Family moved." };
const allowed = { allowed: true, decisions: [] };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.checkClubTransferRequestRateLimit.mockResolvedValue(allowed);
});

describe("club portal transfer routes: only a director or deputy of that club", () => {
  const denials = [
    ["a registrar (no manageTeam)", new RosterAccessError("ROLE_NOT_ALLOWED", 403, "Your club role doesn't include this."), 403],
    ["someone signed out", new RosterAccessError("SIGN_IN_REQUIRED", 401, "Sign in."), 401],
    ["a director of another club", new RosterAccessError("NOT_FOUND", 404, "That club could not be found."), 404],
    ["a director who hasn't unlocked the roster", new RosterAccessError("MFA_UNLOCK_REQUIRED", 403, "Confirm it's you."), 403],
  ] as const;

  for (const [who, error, status] of denials) {
    it(`refuses ${who} on every club transfer endpoint`, async () => {
      mocks.requireClubTransferAccess.mockRejectedValue(error);
      const responses = await Promise.all([
        clubList(new Request(`${base}/api/attendee/clubs/club-b/transfers`), clubCtx),
        clubRequest(jsonRequest("/api/attendee/clubs/club-b/transfers", requestBody), clubCtx),
        clubAccept(jsonRequest("/x", { confirm: true }), transferCtx),
        clubDecline(jsonRequest("/x", { confirm: true }), transferCtx),
        clubCancel(jsonRequest("/x", { confirm: true }), transferCtx),
      ]);
      expect(responses.map((response) => response.status)).toEqual([status, status, status, status, status]);
      expect(mocks.requestTransfer).not.toHaveBeenCalled();
      expect(mocks.acceptTransfer).not.toHaveBeenCalled();
      expect(mocks.declineTransfer).not.toHaveBeenCalled();
      expect(mocks.cancelTransferByClub).not.toHaveBeenCalled();
      expect(mocks.listClubTransfers).not.toHaveBeenCalled();
    });
  }

  it("gates on the manageTeam roster capability for the club in the URL", async () => {
    mocks.requireClubTransferAccess.mockResolvedValue(openAccess);
    mocks.listClubTransfers.mockResolvedValue({ incoming: [], outgoing: [] });
    await clubList(new Request(`${base}/api/attendee/clubs/club-b/transfers`), clubCtx);
    expect(mocks.requireClubTransferAccess).toHaveBeenCalledWith("club-b");
    expect(mocks.listClubTransfers).toHaveBeenCalledWith("club-b", clubActor);
  });

  it("refuses a cross-origin request before checking access", async () => {
    mocks.rejectCrossOriginRequest.mockReturnValue(Response.json({ error: "CROSS_ORIGIN" }, { status: 403 }));
    const response = await clubRequest(jsonRequest("/api/attendee/clubs/club-b/transfers", requestBody), clubCtx);
    expect(response.status).toBe(403);
    expect(mocks.requireClubTransferAccess).not.toHaveBeenCalled();
  });
});

describe("requesting a transfer", () => {
  beforeEach(() => mocks.requireClubTransferAccess.mockResolvedValue(openAccess));

  it("answers 'request sent' the same way whether or not the name matched, with no transfer details", async () => {
    mocks.requestTransfer.mockResolvedValueOnce({ transferId: "matched" }).mockResolvedValueOnce({ transferId: "unmatched" });
    const first = await clubRequest(jsonRequest("/api/attendee/clubs/club-b/transfers", requestBody), clubCtx);
    const second = await clubRequest(jsonRequest("/api/attendee/clubs/club-b/transfers", { ...requestBody, firstName: "Nobody" }), clubCtx);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const [a, b] = await Promise.all([first.json(), second.json()]);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).not.toMatch(/matched|transferId|personId/);
    expect(mocks.requestTransfer).toHaveBeenCalledWith("club-b", requestBody, clubActor);
  });

  it("is rate-limited per director and club, and says so without doing anything", async () => {
    mocks.checkClubTransferRequestRateLimit.mockResolvedValue({ allowed: false, decisions: [] });
    const response = await clubRequest(jsonRequest("/api/attendee/clubs/club-b/transfers", requestBody), clubCtx);
    expect(response.status).toBe(429);
    expect(mocks.checkClubTransferRequestRateLimit).toHaveBeenCalledWith(expect.any(Request), "account:director-1", "club-b");
    expect(mocks.requestTransfer).not.toHaveBeenCalled();
  });

  it("rejects extra fields, such as a roster id or a birth date, and a missing reason", async () => {
    for (const body of [
      { ...requestBody, fromRosterMemberId: "row-1" },
      { ...requestBody, birthDate: "2014-01-01" },
      { ...requestBody, reason: "   " },
      { fromOrganizationId: "club-a", firstName: "Ada", reason: "x" },
    ]) {
      const response = await clubRequest(jsonRequest("/api/attendee/clubs/club-b/transfers", body), clubCtx);
      expect(response.status).toBe(400);
    }
    expect(mocks.requestTransfer).not.toHaveBeenCalled();
  });

  it("returns a typed 409 for a duplicate request and for any unique-index collision, never a 500", async () => {
    mocks.requestTransfer.mockRejectedValueOnce(new MemberTransferError("DUPLICATE_REQUEST", "Already open."));
    const duplicate = await clubRequest(jsonRequest("/api/attendee/clubs/club-b/transfers", requestBody), clubCtx);
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toMatchObject({ error: "DUPLICATE_REQUEST" });
    mocks.requestTransfer.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" }));
    const collision = await clubRequest(jsonRequest("/api/attendee/clubs/club-b/transfers", requestBody), clubCtx);
    expect(collision.status).toBe(409);
    await expect(collision.json()).resolves.toMatchObject({ error: "TRANSFER_CONFLICT" });
  });
});

describe("accepting, declining, cancelling", () => {
  beforeEach(() => mocks.requireClubTransferAccess.mockResolvedValue(openAccess));

  it("accept needs an explicit confirmation and is scoped to the sending club in the URL", async () => {
    const refused = await clubAccept(jsonRequest("/x", {}), transferCtx);
    expect(refused.status).toBe(400);
    mocks.acceptTransfer.mockResolvedValue({ transferId: "transfer-1", rosterMemberId: "row-9", registrationMovesQueued: 2 });
    const ok = await clubAccept(jsonRequest("/x", { confirm: true }), transferCtx);
    expect(ok.status).toBe(200);
    expect(mocks.acceptTransfer).toHaveBeenCalledWith("club-a", "transfer-1", clubActor);
    await expect(ok.json()).resolves.toEqual({ transferId: "transfer-1", registrationMovesQueued: 2 });
  });

  it("maps another club's transfer to 404 and self-acknowledgment to 403", async () => {
    mocks.acceptTransfer.mockRejectedValueOnce(new MemberTransferError("TRANSFER_NOT_FOUND", "Not found."));
    expect((await clubAccept(jsonRequest("/x", { confirm: true }), transferCtx)).status).toBe(404);
    mocks.acceptTransfer.mockRejectedValueOnce(new MemberTransferError("SELF_ACKNOWLEDGE_NOT_ALLOWED", "Staff will complete it."));
    expect((await clubAccept(jsonRequest("/x", { confirm: true }), transferCtx)).status).toBe(403);
    mocks.acceptTransfer.mockRejectedValueOnce(new MemberTransferError("MEMBER_NO_LONGER_ACTIVE", "No longer active."));
    expect((await clubAccept(jsonRequest("/x", { confirm: true }), transferCtx)).status).toBe(409);
  });

  it("decline and cancel pass the optional note through", async () => {
    mocks.declineTransfer.mockResolvedValue({ transferId: "transfer-1" });
    mocks.cancelTransferByClub.mockResolvedValue({ transferId: "transfer-1" });
    expect((await clubDecline(jsonRequest("/x", { confirm: true, note: "Not ours to give." }), transferCtx)).status).toBe(200);
    expect(mocks.declineTransfer).toHaveBeenCalledWith("club-a", "transfer-1", "Not ours to give.", clubActor);
    expect((await clubCancel(jsonRequest("/x", { confirm: true }), transferCtx)).status).toBe(200);
    expect(mocks.cancelTransferByClub).toHaveBeenCalledWith("club-a", "transfer-1", "", clubActor);
  });
});

describe("staff transfer routes: system administrators only", () => {
  it("refuses anyone who isn't a system administrator on every staff endpoint", async () => {
    mocks.requireStaffTransferAccess.mockRejectedValue(new AccessDeniedError("nope", 403, "PERMISSION_DENIED"));
    const responses = await Promise.all([
      staffQueue(new Request(`${base}/api/admin/club-transfers`)),
      staffFinish(jsonRequest("/x", {}), staffCtx),
      staffOverride(jsonRequest("/x", { note: "n" }), staffCtx),
      staffCancel(jsonRequest("/x", { note: "n" }), staffCtx),
      staffCandidates(new Request(`${base}/x`), staffCtx),
      movesList(new Request(`${base}/api/admin/club-transfers/registration-moves`)),
      moveApprove(jsonRequest("/x", { confirm: true }), moveCtx),
      moveSkip(jsonRequest("/x", {}), moveCtx),
    ]);
    expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403, 403, 403, 403, 403]);
    for (const fn of [mocks.staffFinishTransfer, mocks.staffOverrideTransfer, mocks.staffCancelTransfer, mocks.approveRegistrationMove, mocks.skipRegistrationMove, mocks.listStaffTransferQueue]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it("filters the queue and rejects an unknown filter", async () => {
    mocks.requireStaffTransferAccess.mockResolvedValue({ userId: "staff-1" });
    mocks.listStaffTransferQueue.mockResolvedValue([]);
    expect((await staffQueue(new Request(`${base}/api/admin/club-transfers?filter=overdue`))).status).toBe(200);
    expect(mocks.listStaffTransferQueue).toHaveBeenCalledWith("overdue");
    expect((await staffQueue(new Request(`${base}/api/admin/club-transfers?filter=everything`))).status).toBe(400);
  });

  it("override needs a note; finish before 14 days is a 409", async () => {
    mocks.requireStaffTransferAccess.mockResolvedValue({ userId: "staff-1" });
    expect((await staffOverride(jsonRequest("/x", { note: "  " }), staffCtx)).status).toBe(400);
    expect(mocks.staffOverrideTransfer).not.toHaveBeenCalled();
    mocks.staffOverrideTransfer.mockResolvedValue({ transferId: "transfer-1", registrationMovesQueued: 0 });
    expect((await staffOverride(jsonRequest("/x", { note: "Confirmed by phone.", fromRosterMemberId: "row-1" }), staffCtx)).status).toBe(200);
    expect(mocks.staffOverrideTransfer).toHaveBeenCalledWith("transfer-1", { note: "Confirmed by phone.", fromRosterMemberId: "row-1" }, { userId: "staff-1" });
    mocks.staffFinishTransfer.mockRejectedValue(new MemberTransferError("NOT_OVERDUE", "Not overdue yet."));
    expect((await staffFinish(jsonRequest("/x", {}), staffCtx)).status).toBe(409);
    expect((await staffCancel(jsonRequest("/x", {}), staffCtx)).status).toBe(400);
  });

  it("approve needs a confirmation; a blocked move is a 409 naming the blocker", async () => {
    mocks.requireStaffTransferAccess.mockResolvedValue({ userId: "staff-1" });
    expect((await moveApprove(jsonRequest("/x", {}), moveCtx)).status).toBe(400);
    mocks.approveRegistrationMove.mockRejectedValue(new MemberTransferError("MOVE_BLOCKED", "Draft.", "DESTINATION_DRAFT"));
    const blocked = await moveApprove(jsonRequest("/x", { confirm: true }), moveCtx);
    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toMatchObject({ error: "MOVE_BLOCKED", blocker: "DESTINATION_DRAFT" });
    mocks.skipRegistrationMove.mockResolvedValue({ moveId: "move-1" });
    expect((await moveSkip(jsonRequest("/x", { note: "Stays." }), moveCtx)).status).toBe(200);
    expect(mocks.skipRegistrationMove).toHaveBeenCalledWith("move-1", "Stays.", { userId: "staff-1" });
  });
});
