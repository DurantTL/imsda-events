import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F-9 (#571): announcement draft Edit and Discard. Both are audited and
 * neither sends, publishes, or touches attendees. Synthetic data only.
 */

const mocks = vi.hoisted(() => {
  class MockAccessDeniedError extends Error {
    constructor(message: string, public readonly status = 403, public readonly code = "PERMISSION_DENIED") {
      super(message);
    }
  }
  return {
    AccessDeniedError: MockAccessDeniedError,
    requirePermission: vi.fn(),
    getCurrentSession: vi.fn(),
    rejectCrossOriginRequest: vi.fn(),
    findActiveMembership: vi.fn(),
    getPrisma: vi.fn(),
  };
});

vi.mock("@/modules/access/authorization", () => ({
  AccessDeniedError: mocks.AccessDeniedError,
  requirePermission: mocks.requirePermission,
}));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/events/repository", () => ({ findActiveMembership: mocks.findActiveMembership }));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));

import { DELETE, PUT } from "@/app/api/events/[eventId]/announcements/[announcementId]/route";

const context = { params: Promise.resolve({ eventId: "event-1", announcementId: "announcement-1" }) };

function fakePrisma(row: { id: string; title: string; status: "DRAFT" | "PUBLISHED" } | null) {
  const tx = {
    announcement: {
      findFirst: vi.fn(async ({ where }: { where: { status?: string } }) => (row && (!where.status || where.status === row.status) ? row : null)),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...row, ...data })),
      deleteMany: vi.fn(async () => ({ count: row ? 1 : 0 })),
    },
    auditLog: { create: vi.fn<(args: unknown) => Promise<object>>(async () => ({})) },
  };
  return { tx, client: { $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } };
}

function request(method: string, body?: unknown) {
  return new Request("https://events.imsda.test/api/events/event-1/announcements/announcement-1", {
    method,
    headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const validBody = { title: "Friday arrival information", body: "Check-in opens at noon.", priority: "IMPORTANT" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.getCurrentSession.mockResolvedValue({ user: { id: "staff-1" } });
  mocks.requirePermission.mockResolvedValue({ user: { id: "staff-1" } });
});

describe("editing an announcement draft (PUT)", () => {
  it("updates the draft text and writes an audit entry, without publishing", async () => {
    const db = fakePrisma({ id: "announcement-1", title: "Old title", status: "DRAFT" });
    mocks.getPrisma.mockReturnValue(db.client);
    const response = await PUT(request("PUT", validBody), context);
    expect(response.status).toBe(200);
    expect(mocks.requirePermission).toHaveBeenCalledWith(expect.anything(), "event-1", "MANAGE_COMMUNICATIONS", expect.anything());
    const update = db.tx.announcement.update.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(update.data).toEqual({ title: validBody.title, body: validBody.body, priority: "IMPORTANT" });
    expect(update.data).not.toHaveProperty("status");
    expect(update.data).not.toHaveProperty("publishedAt");
    expect(db.tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(db.tx.auditLog.create.mock.calls[0][0]).toMatchObject({
      data: { action: "ANNOUNCEMENT_DRAFT_EDITED", entityType: "Announcement", entityId: "announcement-1", actorUserId: "staff-1" },
    });
  });

  it("refuses to edit a published announcement", async () => {
    const db = fakePrisma({ id: "announcement-1", title: "Sent", status: "PUBLISHED" });
    mocks.getPrisma.mockReturnValue(db.client);
    const response = await PUT(request("PUT", validBody), context);
    expect(response.status).toBe(404);
    expect(db.tx.announcement.update).not.toHaveBeenCalled();
    expect(db.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("rejects invalid text and cross-origin requests", async () => {
    const db = fakePrisma({ id: "announcement-1", title: "Old", status: "DRAFT" });
    mocks.getPrisma.mockReturnValue(db.client);
    expect((await PUT(request("PUT", { ...validBody, title: "x" }), context)).status).toBe(400);
    mocks.rejectCrossOriginRequest.mockReturnValue(Response.json({ error: "CROSS_ORIGIN" }, { status: 403 }));
    expect((await PUT(request("PUT", validBody), context)).status).toBe(403);
    expect(db.tx.announcement.update).not.toHaveBeenCalled();
  });

  it("requires the communications permission", async () => {
    mocks.requirePermission.mockRejectedValue(new mocks.AccessDeniedError("No access."));
    const response = await PUT(request("PUT", validBody), context);
    expect(response.status).toBe(403);
  });
});

describe("discarding an announcement draft (DELETE)", () => {
  it("deletes only a draft and writes an audit entry", async () => {
    const db = fakePrisma({ id: "announcement-1", title: "Old title", status: "DRAFT" });
    mocks.getPrisma.mockReturnValue(db.client);
    const response = await DELETE(request("DELETE"), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ discarded: true });
    expect(db.tx.announcement.deleteMany).toHaveBeenCalledWith({ where: { id: "announcement-1", eventId: "event-1", status: "DRAFT" } });
    expect(db.tx.auditLog.create.mock.calls[0][0]).toMatchObject({
      data: { action: "ANNOUNCEMENT_DRAFT_DISCARDED", entityId: "announcement-1", actorUserId: "staff-1" },
    });
  });

  it("never deletes a published announcement", async () => {
    const db = fakePrisma({ id: "announcement-1", title: "Sent", status: "PUBLISHED" });
    mocks.getPrisma.mockReturnValue(db.client);
    const response = await DELETE(request("DELETE"), context);
    expect(response.status).toBe(404);
    expect(db.tx.announcement.deleteMany).not.toHaveBeenCalled();
    expect(db.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("requires the communications permission", async () => {
    mocks.requirePermission.mockRejectedValue(new mocks.AccessDeniedError("No access."));
    expect((await DELETE(request("DELETE"), context)).status).toBe(403);
  });
});

describe("draft card controls", () => {
  const source = readFileSync("components/communications-workspace.tsx", "utf8");

  it("offers Edit and a confirmed Discard on draft cards only", () => {
    expect(source).toContain("Edit draft");
    expect(source).toContain("Discard draft");
    expect(source).toContain('title="Discard this draft?"');
    expect(source).toContain("does not send anything");
    const draftBlock = source.slice(source.indexOf('announcement.status === "DRAFT" && ('), source.indexOf('announcement.status === "PUBLISHED" && ('));
    expect(draftBlock).toContain("startDraftEdit(announcement)");
    expect(draftBlock).toContain("setDiscardTarget(announcement)");
  });

  it("edit and discard never call the publish or broadcast routes", () => {
    const edit = source.slice(source.indexOf("function startDraftEdit"), source.indexOf("function cancelDiscard"));
    expect(edit).not.toMatch(/broadcast|PATCH|fetch\(/);
    const discard = source.slice(source.indexOf("async function confirmDiscard"), source.indexOf("async function publishAnnouncement"));
    expect(discard).toContain('method: "DELETE"');
    expect(discard).not.toMatch(/broadcast|PATCH/);
  });
});
