import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireClubTransferAccess: vi.fn(),
  requireStaffTransferAccess: vi.fn(),
  initiateTransfer: vi.fn(),
  acknowledgeTransfer: vi.fn(),
  staffFinishTransfer: vi.fn(),
  staffOverrideTransfer: vi.fn(),
  listClubTransfers: vi.fn(),
  listStaffTransferQueue: vi.fn(),
  searchTransferCandidates: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/club-transfers/access", async () => {
  const actual = await vi.importActual<typeof import("@/modules/club-transfers/access")>("@/modules/club-transfers/access");
  return {
    ...actual,
    requireClubTransferAccess: mocks.requireClubTransferAccess,
    requireStaffTransferAccess: mocks.requireStaffTransferAccess,
  };
});
vi.mock("@/modules/club-transfers/repository", async () => {
  const actual = await vi.importActual<typeof import("@/modules/club-transfers/repository")>("@/modules/club-transfers/repository");
  return {
    ...actual,
    initiateTransfer: mocks.initiateTransfer,
    acknowledgeTransfer: mocks.acknowledgeTransfer,
    staffFinishTransfer: mocks.staffFinishTransfer,
    staffOverrideTransfer: mocks.staffOverrideTransfer,
    listClubTransfers: mocks.listClubTransfers,
    listStaffTransferQueue: mocks.listStaffTransferQueue,
    searchTransferCandidates: mocks.searchTransferCandidates,
  };
});

import { AccessDeniedError } from "@/modules/access/authorization";
import { RosterAccessError } from "@/modules/club-rosters/access";
import { MemberTransferError } from "@/modules/club-transfers/repository";
import { GET as clubList, POST as clubInitiate } from "@/app/api/attendee/clubs/[organizationId]/transfers/route";
import { GET as clubSearch } from "@/app/api/attendee/clubs/[organizationId]/transfers/search/route";
import { POST as clubAcknowledge } from "@/app/api/attendee/clubs/[organizationId]/transfers/[transferId]/acknowledge/route";
import { GET as staffQueue } from "@/app/api/admin/club-transfers/route";
import { POST as staffFinish } from "@/app/api/admin/club-transfers/[transferId]/finish/route";
import { POST as staffOverride } from "@/app/api/admin/club-transfers/[transferId]/override/route";

const jsonRequest = (url: string, body: unknown) => new Request(url, {
  method: "POST",
  headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
  body: JSON.stringify(body),
});

const clubActor = { kind: "ATTENDEE" as const, accountId: "director-1", sessionId: "session-1" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
});

describe("a club's own transfer endpoints (director or deputy only)", () => {
  const ctx = { params: Promise.resolve({ organizationId: "club-1" }) };

  it("refuses a registrar (no manageTeam capability) on the roster", async () => {
    mocks.requireClubTransferAccess.mockRejectedValue(new RosterAccessError("ROLE_NOT_ALLOWED", 403, "Your club role doesn't include this."));
    const response = await clubList(new Request("https://events.imsda.test/api/attendee/clubs/club-1/transfers"), ctx);
    expect(response.status).toBe(403);
    expect(mocks.listClubTransfers).not.toHaveBeenCalled();
  });

  it("lists this club's transfer history in both directions", async () => {
    mocks.requireClubTransferAccess.mockResolvedValue({ state: "OPEN", club: {}, capabilities: {}, actor: clubActor });
    mocks.listClubTransfers.mockResolvedValue([{ id: "transfer-1" }]);
    const response = await clubList(new Request("https://events.imsda.test/api/attendee/clubs/club-1/transfers"), ctx);
    expect(response.status).toBe(200);
    expect(mocks.listClubTransfers).toHaveBeenCalledWith("club-1");
    await expect(response.json()).resolves.toEqual({ transfers: [{ id: "transfer-1" }] });
  });

  it("starts a transfer for the receiving club's director", async () => {
    mocks.requireClubTransferAccess.mockResolvedValue({ state: "OPEN", club: {}, capabilities: {}, actor: clubActor });
    mocks.initiateTransfer.mockResolvedValue({ transferId: "transfer-1", rosterMemberId: "roster-2" });
    const body = { fromOrganizationId: "club-2", fromRosterMemberId: "roster-1", reason: "Family moved closer to this club." };
    const response = await clubInitiate(jsonRequest("https://events.imsda.test/api/attendee/clubs/club-1/transfers", body), ctx);
    expect(response.status).toBe(201);
    expect(mocks.initiateTransfer).toHaveBeenCalledWith("club-1", body, clubActor);
  });

  it("refuses a cross-origin request to start a transfer", async () => {
    mocks.rejectCrossOriginRequest.mockReturnValue(Response.json({ error: "CROSS_ORIGIN" }, { status: 403 }));
    const response = await clubInitiate(jsonRequest("https://events.imsda.test/api/attendee/clubs/club-1/transfers", {}), ctx);
    expect(response.status).toBe(403);
    expect(mocks.requireClubTransferAccess).not.toHaveBeenCalled();
  });

  it("rejects an invalid initiate request before touching the repository", async () => {
    mocks.requireClubTransferAccess.mockResolvedValue({ state: "OPEN", club: {}, capabilities: {}, actor: clubActor });
    const response = await clubInitiate(jsonRequest("https://events.imsda.test/api/attendee/clubs/club-1/transfers", { reason: "" }), ctx);
    expect(response.status).toBe(400);
    expect(mocks.initiateTransfer).not.toHaveBeenCalled();
  });

  it("surfaces a same-club transfer attempt as a 400", async () => {
    mocks.requireClubTransferAccess.mockResolvedValue({ state: "OPEN", club: {}, capabilities: {}, actor: clubActor });
    mocks.initiateTransfer.mockRejectedValue(new MemberTransferError("SAME_CLUB", "The member is already on this club's roster."));
    const body = { fromOrganizationId: "club-1", fromRosterMemberId: "roster-1", reason: "reason" };
    const response = await clubInitiate(jsonRequest("https://events.imsda.test/api/attendee/clubs/club-1/transfers", body), ctx);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "SAME_CLUB" });
  });

  it("searches other clubs' rosters", async () => {
    mocks.requireClubTransferAccess.mockResolvedValue({ state: "OPEN", club: {}, capabilities: {}, actor: clubActor });
    mocks.searchTransferCandidates.mockResolvedValue([{ rosterMemberId: "roster-1" }]);
    const response = await clubSearch(new Request("https://events.imsda.test/api/attendee/clubs/club-1/transfers/search?q=pat"), ctx);
    expect(response.status).toBe(200);
    expect(mocks.searchTransferCandidates).toHaveBeenCalledWith("pat", "club-1");
  });

  it("acknowledges a pending transfer for the sending club", async () => {
    mocks.requireClubTransferAccess.mockResolvedValue({ state: "OPEN", club: {}, capabilities: {}, actor: clubActor });
    mocks.acknowledgeTransfer.mockResolvedValue({ transferId: "transfer-1" });
    const response = await clubAcknowledge(
      jsonRequest("https://events.imsda.test/api/attendee/clubs/club-1/transfers/transfer-1/acknowledge", { confirm: true }),
      { params: Promise.resolve({ organizationId: "club-1", transferId: "transfer-1" }) },
    );
    expect(response.status).toBe(200);
    expect(mocks.acknowledgeTransfer).toHaveBeenCalledWith("club-1", "transfer-1", clubActor);
  });

  it("turns an already-resolved transfer into a 400, never a silent success", async () => {
    mocks.requireClubTransferAccess.mockResolvedValue({ state: "OPEN", club: {}, capabilities: {}, actor: clubActor });
    mocks.acknowledgeTransfer.mockRejectedValue(new MemberTransferError("ALREADY_RESOLVED", "This transfer was already resolved."));
    const response = await clubAcknowledge(
      jsonRequest("https://events.imsda.test/api/attendee/clubs/club-1/transfers/transfer-1/acknowledge", { confirm: true }),
      { params: Promise.resolve({ organizationId: "club-1", transferId: "transfer-1" }) },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "ALREADY_RESOLVED" });
  });
});

describe("the conference staff transfer queue (system admin only)", () => {
  it("refuses anyone who isn't a system administrator", async () => {
    mocks.requireStaffTransferAccess.mockRejectedValue(new AccessDeniedError("nope", 403, "PERMISSION_DENIED"));
    const response = await staffQueue(new Request("https://events.imsda.test/api/admin/club-transfers"));
    expect(response.status).toBe(403);
    expect(mocks.listStaffTransferQueue).not.toHaveBeenCalled();
  });

  it("lists the overdue queue for a system administrator", async () => {
    mocks.requireStaffTransferAccess.mockResolvedValue({ userId: "staff-1" });
    mocks.listStaffTransferQueue.mockResolvedValue([{ id: "transfer-1" }]);
    const response = await staffQueue(new Request("https://events.imsda.test/api/admin/club-transfers"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ transfers: [{ id: "transfer-1" }] });
  });

  it("finishes a transfer as a system administrator", async () => {
    mocks.requireStaffTransferAccess.mockResolvedValue({ userId: "staff-1" });
    mocks.staffFinishTransfer.mockResolvedValue({ transferId: "transfer-1" });
    const response = await staffFinish(
      jsonRequest("https://events.imsda.test/api/admin/club-transfers/transfer-1/finish", { note: "Sending club unresponsive." }),
      { params: Promise.resolve({ transferId: "transfer-1" }) },
    );
    expect(response.status).toBe(200);
    expect(mocks.staffFinishTransfer).toHaveBeenCalledWith("transfer-1", "Sending club unresponsive.", { userId: "staff-1" });
  });

  it("overrides a transfer as a system administrator", async () => {
    mocks.requireStaffTransferAccess.mockResolvedValue({ userId: "staff-1" });
    mocks.staffOverrideTransfer.mockResolvedValue({ transferId: "transfer-1" });
    const response = await staffOverride(
      jsonRequest("https://events.imsda.test/api/admin/club-transfers/transfer-1/override", { note: "Staff decided the move stands." }),
      { params: Promise.resolve({ transferId: "transfer-1" }) },
    );
    expect(response.status).toBe(200);
    expect(mocks.staffOverrideTransfer).toHaveBeenCalledWith("transfer-1", "Staff decided the move stands.", { userId: "staff-1" });
  });

  it("refuses a non-administrator trying to finish a transfer", async () => {
    mocks.requireStaffTransferAccess.mockRejectedValue(new AccessDeniedError("nope", 403, "PERMISSION_DENIED"));
    const response = await staffFinish(
      jsonRequest("https://events.imsda.test/api/admin/club-transfers/transfer-1/finish", {}),
      { params: Promise.resolve({ transferId: "transfer-1" }) },
    );
    expect(response.status).toBe(403);
    expect(mocks.staffFinishTransfer).not.toHaveBeenCalled();
  });
});
