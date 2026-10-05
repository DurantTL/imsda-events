import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown> & { id: string };

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown> & { id: string }>,
  audits: [] as Array<Record<string, unknown>>,
  locks: 0,
}));
const mocks = vi.hoisted(() => ({
  rejectCrossOriginRequest: vi.fn(),
  requireSystemAdministrator: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/organizations/access", () => ({ requireSystemAdministrator: mocks.requireSystemAdministrator }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: async (entry: Record<string, unknown>) => { state.audits.push(entry); } }));
vi.mock("@/lib/prisma", () => {
  const tx = {
    $executeRaw: async () => { state.locks += 1; },
    calendarEntry: {
      findMany: async (args: { where?: { id?: { in: string[] } } } = {}) => {
        const ids = args.where?.id?.in;
        return state.rows.filter((row) => !ids || ids.includes(row.id)).map((row) => ({
          repeatRule: null, updatedAt: new Date("2026-10-01T00:00:00Z"), sourceFeed: null, sourceRemovedAt: null, ...row,
        }));
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        Object.assign(state.rows.find((row) => row.id === where.id)!, data);
      },
    },
  };
  return { getPrisma: () => ({ ...tx, $transaction: async (run: (client: typeof tx) => unknown) => run(tx) }) };
});

import { POST } from "@/app/api/admin/calendar/entries/bulk/route";
import { AccessDeniedError } from "@/modules/access/authorization";
import { maxBulkEntries } from "@/modules/calendar/admin-list";

const request = (body: unknown) => new Request("https://events.imsda.test/api/admin/calendar/entries/bulk", {
  method: "POST",
  headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
  body: JSON.stringify(body),
});

const row = (id: string, patch: Record<string, unknown> = {}): Row => ({
  id, title: `Entry ${id}`, description: "", startsOn: "2026-11-01", endsOn: "2026-11-01", timeLabel: "", location: "",
  category: "", linkUrl: null, status: "SCHEDULED", entryType: "STANDARD", repeatExceptions: [], isPublished: false,
  sourceFeedId: null, sourceUid: null, isHiddenLocally: false, locallyEditedFields: [], ...patch,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.requireSystemAdministrator.mockResolvedValue({ id: "admin-1" });
  state.audits = [];
  state.locks = 0;
  state.rows = [
    row("staff-1"),
    row("imp-1", { sourceFeedId: "feed-1", sourceUid: "uid-1", isPublished: true, locallyEditedFields: ["title"] }),
    row("imp-2", { sourceFeedId: "feed-2", sourceUid: "uid-2" }),
  ];
});

describe("POST /api/admin/calendar/entries/bulk", () => {
  it("is closed to anyone but a system administrator, and to cross-origin requests", async () => {
    mocks.requireSystemAdministrator.mockRejectedValue(new AccessDeniedError("No.", 403, "PERMISSION_DENIED"));
    expect((await POST(request({ ids: ["staff-1"], change: { action: "publish" } }))).status).toBe(403);
    expect(state.rows[0].isPublished).toBe(false);
    expect(state.audits).toHaveLength(0);

    mocks.requireSystemAdministrator.mockClear();
    mocks.rejectCrossOriginRequest.mockReturnValue(Response.json({}, { status: 403 }));
    expect((await POST(request({ ids: ["staff-1"], change: { action: "publish" } }))).status).toBe(403);
    expect(mocks.requireSystemAdministrator).not.toHaveBeenCalled();
  });

  it("caps the batch size", async () => {
    const atCap = Array.from({ length: maxBulkEntries }, (_, index) => `id-${index}`);
    expect((await POST(request({ ids: atCap, change: { action: "publish" } }))).status).toBe(200);
    const over = [...atCap, "one-more"];
    const response = await POST(request({ ids: over, change: { action: "publish" } }));
    expect(response.status).toBe(400);
    expect((await response.json()).message).toContain(String(maxBulkEntries));
  });

  it("validates each action's input", async () => {
    const bad = [
      { ids: [], change: { action: "publish" } },
      { ids: ["a", "a"], change: { action: "publish" } },
      { ids: ["a"], change: { action: "delete" } },
      { ids: ["a"], change: { action: "setCategory" } },
      { ids: ["a"], change: { action: "setCategory", category: "x".repeat(41) } },
      { ids: ["a"], change: { action: "publish", category: "Youth" } },
      { ids: ["a"], change: { action: "publish" }, extra: true },
    ];
    for (const body of bad) expect((await POST(request(body))).status).toBe(400);
    expect(state.audits).toHaveLength(0);
  });

  it("sets a category, recording it as a local edit on imported entries only, with one audit row", async () => {
    const response = await POST(request({ ids: ["staff-1", "imp-1", "imp-2"], change: { action: "setCategory", category: "  Youth " } }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result).toMatchObject({ action: "setCategory", changed: 3, skipped: [] });
    expect(state.rows.map((item) => item.category)).toEqual(["Youth", "Youth", "Youth"]);
    expect(state.rows[0].locallyEditedFields).toEqual([]);
    expect(state.rows[1].locallyEditedFields).toEqual(["title", "category"]);
    expect(state.rows[2].locallyEditedFields).toEqual(["category"]);
    expect(state.rows.every((item) => item.updatedByUserId === "admin-1")).toBe(true);
    expect(state.locks).toBe(2 + 0); // one lock per feed, taken before the entries are read again
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0]).toMatchObject({
      action: "CALENDAR_ENTRIES_BULK_UPDATED",
      actorUserId: "admin-1",
      metadata: { entryIds: ["staff-1", "imp-1", "imp-2"] },
    });
  });

  it("clears a category", async () => {
    state.rows[0].category = "Youth";
    const body = await (await POST(request({ ids: ["staff-1"], change: { action: "setCategory", category: "" } }))).json();
    expect(body.result.changed).toBe(1);
    expect(state.rows[0].category).toBe("");
  });

  it("publishes, reporting skipped entries with reasons", async () => {
    const body = await (await POST(request({ ids: ["staff-1", "imp-1", "missing"], change: { action: "publish" } }))).json();
    expect(state.rows[0].isPublished).toBe(true);
    expect(body.result.changed).toBe(1);
    expect(body.result.skipped).toEqual([
      { id: "imp-1", title: "Entry imp-1", reason: "Already published." },
      { id: "missing", title: "", reason: "No longer exists." },
    ]);
  });

  it("hides imported entries only and unhides them again", async () => {
    const hide = await (await POST(request({ ids: ["staff-1", "imp-1"], change: { action: "hide" } }))).json();
    expect(hide.result.changed).toBe(1);
    expect(hide.result.skipped[0].reason).toBe("Only imported entries can be hidden or unhidden.");
    expect(state.rows[1].isHiddenLocally).toBe(true);
    const unhide = await (await POST(request({ ids: ["imp-1"], change: { action: "unhide" } }))).json();
    expect(unhide.result.changed).toBe(1);
    expect(state.rows[1].isHiddenLocally).toBe(false);
  });

  it("writes no audit row when nothing changed", async () => {
    const body = await (await POST(request({ ids: ["imp-1"], change: { action: "publish" } }))).json();
    expect(body.result.changed).toBe(0);
    expect(state.audits).toHaveLength(0);
  });
});
