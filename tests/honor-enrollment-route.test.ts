import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireRosterAccess: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
  setClassSelections: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/club-rosters/access", async () => {
  const actual = await vi.importActual<typeof import("@/modules/club-rosters/access")>("@/modules/club-rosters/access");
  return { ...actual, requireRosterAccess: mocks.requireRosterAccess };
});
vi.mock("@/modules/honors/enrollment-repository", async () => {
  const actual = await vi.importActual<typeof import("@/modules/honors/enrollment-repository")>("@/modules/honors/enrollment-repository");
  return { ...actual, setClassSelections: mocks.setClassSelections };
});

import { PUT } from "@/app/api/attendee/clubs/[organizationId]/events/[eventId]/classes/route";
import { RosterAccessError } from "@/modules/club-rosters/access";
import { ClassSelectionError } from "@/modules/honors/enrollment-repository";

const ctx = { params: Promise.resolve({ organizationId: "club-a", eventId: "event-1" }) };
const request = (body: unknown) => new Request("https://events.imsda.test/api/x", {
  method: "PUT",
  headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.requireRosterAccess.mockResolvedValue({ accountId: "director-1" });
  mocks.setClassSelections.mockResolvedValue({ selections: {} });
});

describe("class selection route", () => {
  it("saves for the director's own club", async () => {
    const response = await PUT(request({ selections: { "attendee-1": ["knots"] } }), ctx);
    expect(response.status).toBe(200);
    expect(mocks.setClassSelections).toHaveBeenCalledWith("club-a", "event-1", "director-1", { "attendee-1": ["knots"] });
  });

  it("maps full classes, club limits, bad picks, and the deadline to clear statuses", async () => {
    const cases: Array<[ClassSelectionError["code"], number]> = [
      ["CLASS_FULL", 409], ["CLUB_LIMIT_REACHED", 409], ["SELECTION_INVALID", 422], ["DEADLINE_PASSED", 410], ["NOT_REGISTERED", 404],
    ];
    for (const [code, status] of cases) {
      mocks.setClassSelections.mockRejectedValueOnce(new ClassSelectionError(code, "No."));
      const response = await PUT(request({ selections: {} }), ctx);
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toMatchObject({ error: code });
    }
  });

  it("requires roster access and a same-origin request", async () => {
    mocks.requireRosterAccess.mockRejectedValueOnce(new RosterAccessError("NOT_FOUND", 404, "Not found."));
    expect((await PUT(request({ selections: {} }), ctx)).status).toBe(404);
    mocks.rejectCrossOriginRequest.mockReturnValueOnce(Response.json({}, { status: 403 }));
    expect((await PUT(request({ selections: {} }), ctx)).status).toBe(403);
    expect((await PUT(request({ selections: { a: ["1", "2", "3", "4", "5", "6", "7"] } }), ctx)).status).toBe(400);
    expect(mocks.setClassSelections).not.toHaveBeenCalled();
  });
});
