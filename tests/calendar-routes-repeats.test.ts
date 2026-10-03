import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rejectCrossOriginRequest: vi.fn(),
  requireSystemAdministrator: vi.fn(),
  createCalendarEntry: vi.fn(),
  updateCalendarEntry: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/organizations/access", () => ({ requireSystemAdministrator: mocks.requireSystemAdministrator }));
vi.mock("@/modules/calendar/repository", async () => {
  const actual = await vi.importActual<typeof import("@/modules/calendar/repository")>("@/modules/calendar/repository");
  return { ...actual, createCalendarEntry: mocks.createCalendarEntry, updateCalendarEntry: mocks.updateCalendarEntry };
});

import { POST } from "@/app/api/admin/calendar/entries/route";
import { PATCH } from "@/app/api/admin/calendar/entries/[entryId]/route";
import { AccessDeniedError } from "@/modules/access/authorization";
import { CalendarError } from "@/modules/calendar/repository";

const request = (method: string, body?: unknown) => new Request("https://events.imsda.test/api/admin/calendar", {
  method,
  headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const entryCtx = { params: Promise.resolve({ entryId: "entry-1" }) };
// 2026-10-06 is a Tuesday (2).
const repeating = {
  title: "Closed",
  startsOn: "2026-10-06",
  endsOn: "2026-10-06",
  entryType: "CLOSURE",
  repeat: { frequency: "WEEKLY", weekdays: [2] },
  repeatExceptions: ["2026-10-13"],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.requireSystemAdministrator.mockResolvedValue({ id: "admin-1" });
  mocks.createCalendarEntry.mockResolvedValue([]);
  mocks.updateCalendarEntry.mockResolvedValue([]);
});

describe("calendar admin routes: repeats and closures", () => {
  it("passes the repeat, skipped dates and type to the repository", async () => {
    expect((await POST(request("POST", repeating))).status).toBe(201);
    expect(mocks.createCalendarEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        entryType: "CLOSURE",
        repeat: expect.objectContaining({ frequency: "WEEKLY", weekStart: 0 }),
        repeatExceptions: ["2026-10-13"],
      }),
      "admin-1",
    );
  });

  it("answers an invalid repeat with 400", async () => {
    mocks.updateCalendarEntry.mockRejectedValue(new CalendarError("INVALID_REPEAT", "A repeat can't end before the first date."));
    const response = await PATCH(request("PATCH", { startsOn: "2027-01-05", endsOn: "2027-01-05" }), entryCtx);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "INVALID_REPEAT" });
  });

  it("refuses a weekly repeat that skips the start weekday before reaching the repository", async () => {
    const response = await POST(request("POST", { ...repeating, repeat: { frequency: "WEEKLY", weekdays: [1] } }));
    expect(response.status).toBe(400);
    expect(mocks.createCalendarEntry).not.toHaveBeenCalled();
  });

  it("denies a non-administrator the new fields too", async () => {
    mocks.requireSystemAdministrator.mockRejectedValue(new AccessDeniedError("No.", 403, "PERMISSION_DENIED"));
    expect((await POST(request("POST", repeating))).status).toBe(403);
    expect((await PATCH(request("PATCH", { repeat: null, repeatExceptions: [], entryType: "STANDARD" }), entryCtx)).status).toBe(403);
    expect(mocks.createCalendarEntry).not.toHaveBeenCalled();
    expect(mocks.updateCalendarEntry).not.toHaveBeenCalled();
  });
});
