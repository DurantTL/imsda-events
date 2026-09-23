import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rejectCrossOriginRequest: vi.fn(),
  requireSystemAdministrator: vi.fn(),
  createCalendarEntry: vi.fn(),
  updateCalendarEntry: vi.fn(),
  deleteCalendarEntry: vi.fn(),
  updateEventCalendarSettings: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/organizations/access", () => ({ requireSystemAdministrator: mocks.requireSystemAdministrator }));
vi.mock("@/modules/calendar/repository", async () => {
  const actual = await vi.importActual<typeof import("@/modules/calendar/repository")>("@/modules/calendar/repository");
  return {
    ...actual,
    createCalendarEntry: mocks.createCalendarEntry,
    updateCalendarEntry: mocks.updateCalendarEntry,
    deleteCalendarEntry: mocks.deleteCalendarEntry,
    updateEventCalendarSettings: mocks.updateEventCalendarSettings,
  };
});

import { POST } from "@/app/api/admin/calendar/entries/route";
import { DELETE, PATCH } from "@/app/api/admin/calendar/entries/[entryId]/route";
import { PATCH as PATCH_EVENT } from "@/app/api/admin/calendar/events/[eventId]/route";
import { AccessDeniedError } from "@/modules/access/authorization";
import { CalendarError } from "@/modules/calendar/repository";

const request = (method: string, body?: unknown) => new Request("https://events.imsda.test/api/admin/calendar", {
  method,
  headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const entryCtx = { params: Promise.resolve({ entryId: "entry-1" }) };
const eventCtx = { params: Promise.resolve({ eventId: "event-1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.requireSystemAdministrator.mockResolvedValue({ id: "admin-1" });
  mocks.createCalendarEntry.mockResolvedValue([]);
  mocks.updateCalendarEntry.mockResolvedValue([]);
  mocks.deleteCalendarEntry.mockResolvedValue([]);
  mocks.updateEventCalendarSettings.mockResolvedValue([]);
});

describe("calendar admin routes", () => {
  it("adds an entry as the signed-in administrator", async () => {
    const response = await POST(request("POST", { title: "Camporee", startsOn: "2026-10-09", endsOn: "2026-10-11", isPublished: true }));
    expect(response.status).toBe(201);
    expect(mocks.createCalendarEntry).toHaveBeenCalledWith(expect.objectContaining({ title: "Camporee", isPublished: true }), "admin-1");
  });

  it("rejects bad input before touching the database", async () => {
    const response = await POST(request("POST", { title: "", startsOn: "2026-10-09", endsOn: "2026-10-11" }));
    expect(response.status).toBe(400);
    expect(mocks.createCalendarEntry).not.toHaveBeenCalled();
  });

  it("is closed to anyone but a system administrator", async () => {
    mocks.requireSystemAdministrator.mockRejectedValue(new AccessDeniedError("No.", 403, "PERMISSION_DENIED"));
    expect((await POST(request("POST", { title: "x", startsOn: "2026-10-09", endsOn: "2026-10-09" }))).status).toBe(403);
    expect((await PATCH(request("PATCH", { isPublished: true }), entryCtx)).status).toBe(403);
    expect((await DELETE(request("DELETE"), entryCtx)).status).toBe(403);
    expect((await PATCH_EVENT(request("PATCH", { showOnCalendar: false }), eventCtx)).status).toBe(403);
    expect(mocks.updateEventCalendarSettings).not.toHaveBeenCalled();
  });

  it("refuses cross-origin writes", async () => {
    mocks.rejectCrossOriginRequest.mockReturnValue(Response.json({}, { status: 403 }));
    expect((await PATCH_EVENT(request("PATCH", { showOnCalendar: false }), eventCtx)).status).toBe(403);
    expect(mocks.requireSystemAdministrator).not.toHaveBeenCalled();
  });

  it("hides an event and reports a missing entry as not found", async () => {
    expect((await PATCH_EVENT(request("PATCH", { showOnCalendar: false }), eventCtx)).status).toBe(200);
    expect(mocks.updateEventCalendarSettings).toHaveBeenCalledWith("event-1", { showOnCalendar: false }, "admin-1");
    mocks.deleteCalendarEntry.mockRejectedValueOnce(new CalendarError("ENTRY_NOT_FOUND", "Gone."));
    expect((await DELETE(request("DELETE"), entryCtx)).status).toBe(404);
  });
});
