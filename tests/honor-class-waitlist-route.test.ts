import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireRosterAccess: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
  joinClassWaitlist: vi.fn(),
  acceptClassWaitlistOffer: vi.fn(),
  leaveClassWaitlist: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/club-rosters/access", async () => {
  const actual = await vi.importActual<typeof import("@/modules/club-rosters/access")>("@/modules/club-rosters/access");
  return { ...actual, requireRosterAccess: mocks.requireRosterAccess };
});
vi.mock("@/modules/honors/waitlist-repository", () => ({
  joinClassWaitlist: mocks.joinClassWaitlist,
  acceptClassWaitlistOffer: mocks.acceptClassWaitlistOffer,
  leaveClassWaitlist: mocks.leaveClassWaitlist,
}));

import { POST as join } from "@/app/api/attendee/clubs/[organizationId]/events/[eventId]/classes/waitlist/route";
import { DELETE as leave } from "@/app/api/attendee/clubs/[organizationId]/events/[eventId]/classes/waitlist/[entryId]/route";
import { POST as accept } from "@/app/api/attendee/clubs/[organizationId]/events/[eventId]/classes/waitlist/[entryId]/accept/route";
import { ClassSelectionError } from "@/modules/honors/enrollment-repository";

const ctx = { params: Promise.resolve({ organizationId: "club-a", eventId: "event-1" }) };
const entryCtx = { params: Promise.resolve({ organizationId: "club-a", eventId: "event-1", entryId: "entry-1" }) };
const request = (method: string, body?: unknown) => new Request("https://events.imsda.test/api/x", {
  method,
  headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.requireRosterAccess.mockResolvedValue({ actor: { kind: "ATTENDEE", accountId: "director-1", sessionId: "session-1" } });
  mocks.joinClassWaitlist.mockResolvedValue({ selections: {} });
  mocks.acceptClassWaitlistOffer.mockResolvedValue({ selections: {} });
  mocks.leaveClassWaitlist.mockResolvedValue({ selections: {} });
});

describe("class waitlist routes (#831)", () => {
  it("joins for the director's own club with the director as the actor", async () => {
    const response = await join(request("POST", { attendeeId: "a1", offeringId: "c1", confirmed: true }), ctx);
    expect(response.status).toBe(201);
    expect(mocks.joinClassWaitlist).toHaveBeenCalledWith("club-a", "event-1", { accountId: "director-1" }, { attendeeId: "a1", offeringId: "c1", confirmed: true });
  });

  it("refuses unknown fields and a too-short override reason before doing anything", async () => {
    expect((await join(request("POST", { attendeeId: "a1", offeringId: "c1", seats: 3 }), ctx)).status).toBe(400);
    expect((await join(request("POST", { attendeeId: "a1", offeringId: "c1", overrideReason: "no" }), ctx)).status).toBe(400);
    expect((await join(request("POST", { offeringId: "c1" }), ctx)).status).toBe(400);
    expect(mocks.joinClassWaitlist).not.toHaveBeenCalled();
  });

  it("accepts and leaves by the entry id, scoped to the club in the path", async () => {
    expect((await accept(request("POST"), entryCtx)).status).toBe(200);
    expect(mocks.acceptClassWaitlistOffer).toHaveBeenCalledWith("club-a", "event-1", { accountId: "director-1" }, "entry-1");
    expect((await leave(request("DELETE"), entryCtx)).status).toBe(200);
    expect(mocks.leaveClassWaitlist).toHaveBeenCalledWith("club-a", "event-1", { accountId: "director-1" }, "entry-1");
  });

  it("maps the waitlist's refusals to clear statuses", async () => {
    const cases: Array<[ClassSelectionError["code"], number]> = [
      ["WAITLIST_NOT_NEEDED", 409], ["ALREADY_WAITING", 409], ["OFFER_NOT_FOUND", 404], ["OFFER_EXPIRED", 409], ["DEADLINE_PASSED", 410], ["SELECTION_INVALID", 422],
    ];
    for (const [code, status] of cases) {
      mocks.acceptClassWaitlistOffer.mockRejectedValueOnce(new ClassSelectionError(code, "No."));
      const response = await accept(request("POST"), entryCtx);
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toMatchObject({ error: code });
    }
  });

  it("requires a same-origin request", async () => {
    mocks.rejectCrossOriginRequest.mockReturnValueOnce(Response.json({ error: "CROSS_ORIGIN" }, { status: 403 }));
    expect((await join(request("POST", { attendeeId: "a1", offeringId: "c1" }), ctx)).status).toBe(403);
    expect(mocks.requireRosterAccess).not.toHaveBeenCalled();
  });
});
