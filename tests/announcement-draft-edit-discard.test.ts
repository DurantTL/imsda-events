import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/communications",
}));

import { CommunicationsWorkspace } from "@/components/communications-workspace";
import { DELETE, PATCH, PUT } from "@/app/api/events/[eventId]/announcements/[announcementId]/route";

const context = { params: Promise.resolve({ eventId: "event-1", announcementId: "announcement-1" }) };

type Row = { id: string; eventId: string; title: string; body: string; status: "DRAFT" | "PUBLISHED"; publishedAt: Date | null };

/** A stateful fake that honors `where` (id, eventId, status), like the real table. */
function fakePrisma(initial: Partial<Row> | null) {
  let row: Row | null = initial
    ? { id: "announcement-1", eventId: "event-1", title: "Old title", body: "Old body", status: "DRAFT", publishedAt: null, ...initial }
    : null;
  const matches = (where: Partial<Row>) => Boolean(row) && Object.entries(where).every(([k, v]) => (row as Record<string, unknown>)[k] === v);
  const full = () => ({ ...row, priority: "NORMAL", placement: "HOME_BANNER", audience: {}, pinnedAt: null, createdByUserId: "u-1", updatedAt: new Date("2026-09-29T12:00:00Z") });
  const tx = {
    announcement: {
      findFirst: vi.fn(async ({ where }: { where: Partial<Row> }) => (matches(where) ? full() : null)),
      updateMany: vi.fn(async ({ where, data }: { where: Partial<Row>; data: Partial<Row> }) => {
        if (!matches(where)) return { count: 0 };
        row = { ...row!, ...data };
        return { count: 1 };
      }),
      deleteMany: vi.fn(async ({ where }: { where: Partial<Row> }) => {
        if (!matches(where)) return { count: 0 };
        row = null;
        return { count: 1 };
      }),
    },
    auditLog: { create: vi.fn<(args: unknown) => Promise<object>>(async () => ({})) },
  };
  return { tx, current: () => row, client: { $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } };
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
    const db = fakePrisma({});
    mocks.getPrisma.mockReturnValue(db.client);
    const response = await PUT(request("PUT", validBody), context);
    expect(response.status).toBe(200);
    expect(mocks.requirePermission).toHaveBeenCalledWith(expect.anything(), "event-1", "MANAGE_COMMUNICATIONS", expect.anything());
    const update = db.tx.announcement.updateMany.mock.calls[0][0] as { where: Record<string, unknown>; data: Record<string, unknown> };
    expect(update.where).toEqual({ id: "announcement-1", eventId: "event-1", status: "DRAFT" });
    expect(update.data).toEqual({ title: validBody.title, body: validBody.body, priority: "IMPORTANT" });
    expect(update.data).not.toHaveProperty("status");
    expect(update.data).not.toHaveProperty("publishedAt");
    const json = await response.json() as { announcement: Record<string, unknown> };
    expect(json.announcement).toMatchObject({ id: "announcement-1", title: validBody.title, status: "DRAFT" });
    expect(json.announcement).not.toHaveProperty("createdByUserId");
    expect(db.tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(db.tx.auditLog.create.mock.calls[0][0]).toMatchObject({
      data: { action: "ANNOUNCEMENT_DRAFT_EDITED", entityType: "Announcement", entityId: "announcement-1", actorUserId: "staff-1" },
    });
  });

  it("refuses to edit a published announcement", async () => {
    const db = fakePrisma({ status: "PUBLISHED", title: "Sent" });
    mocks.getPrisma.mockReturnValue(db.client);
    const response = await PUT(request("PUT", validBody), context);
    expect(response.status).toBe(404);
    expect(db.current()?.title).toBe("Sent");
    expect(db.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("rejects invalid text and cross-origin requests", async () => {
    const db = fakePrisma({});
    mocks.getPrisma.mockReturnValue(db.client);
    expect((await PUT(request("PUT", { ...validBody, title: "x" }), context)).status).toBe(400);
    mocks.rejectCrossOriginRequest.mockReturnValue(Response.json({ error: "CROSS_ORIGIN" }, { status: 403 }));
    expect((await PUT(request("PUT", validBody), context)).status).toBe(403);
    expect(db.current()?.title).toBe("Old title");
  });

  it("requires the communications permission", async () => {
    mocks.requirePermission.mockRejectedValue(new mocks.AccessDeniedError("No access."));
    const response = await PUT(request("PUT", validBody), context);
    expect(response.status).toBe(403);
  });
});

describe("discarding an announcement draft (DELETE)", () => {
  it("deletes only a draft and writes an audit entry", async () => {
    const db = fakePrisma({});
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
    const db = fakePrisma({ status: "PUBLISHED", title: "Sent" });
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

describe("other events and publish races", () => {
  const otherEvent = { params: Promise.resolve({ eventId: "event-2", announcementId: "announcement-1" }) };

  it("PUT and DELETE for another event's announcement return 404 and change nothing", async () => {
    const db = fakePrisma({});
    mocks.getPrisma.mockReturnValue(db.client);
    expect((await PUT(request("PUT", validBody), otherEvent)).status).toBe(404);
    expect((await DELETE(request("DELETE"), otherEvent)).status).toBe(404);
    expect(db.current()?.title).toBe("Old title");
    expect(db.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("a concurrent publish cannot be overwritten by an edit (guard is in the write itself)", async () => {
    const db = fakePrisma({});
    // The draft is visible when read, then published before the write lands.
    db.tx.announcement.findFirst.mockImplementationOnce(async () => ({ id: "announcement-1", title: "Old title" }) as never);
    const publishedAt = new Date("2026-09-29T13:00:00Z");
    const realUpdateMany = db.tx.announcement.updateMany.getMockImplementation()!;
    await realUpdateMany({ where: { id: "announcement-1" }, data: { status: "PUBLISHED", publishedAt } });
    mocks.getPrisma.mockReturnValue(db.client);
    const response = await PUT(request("PUT", validBody), context);
    expect(response.status).toBe(404);
    expect(db.current()).toMatchObject({ title: "Old title", status: "PUBLISHED", publishedAt });
    expect(db.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("publishes a draft once", async () => {
    const db = fakePrisma({});
    mocks.getPrisma.mockReturnValue(db.client);
    const response = await PATCH(request("PATCH"), context);
    expect(response.status).toBe(200);
    expect(db.current()?.status).toBe("PUBLISHED");
    expect(db.tx.announcement.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: "announcement-1", eventId: "event-1", status: "DRAFT" } });
    expect(db.tx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("does not republish an already-published announcement or reset publishedAt", async () => {
    const publishedAt = new Date("2026-09-01T10:00:00Z");
    const db = fakePrisma({ status: "PUBLISHED", publishedAt });
    mocks.getPrisma.mockReturnValue(db.client);
    const response = await PATCH(request("PATCH"), context);
    expect(response.status).toBe(404);
    expect(db.current()?.publishedAt).toEqual(publishedAt);
    expect(db.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("publish for a discarded draft is a clean 404, not a 500", async () => {
    const db = fakePrisma(null);
    mocks.getPrisma.mockReturnValue(db.client);
    expect((await PATCH(request("PATCH"), context)).status).toBe(404);
  });
});

describe("draft card controls", () => {
  const announcement = (id: string, status: "DRAFT" | "PUBLISHED") => ({
    id, title: `Title ${id}`, body: "Synthetic body text.", status, priority: "NORMAL", placement: "HOME_BANNER",
    audience: { type: "ALL_ATTENDEES" }, publishedAt: status === "PUBLISHED" ? "2026-09-01T10:00:00.000Z" : null, pinnedAt: null, updatedAt: "2026-09-01T10:00:00.000Z",
  });
  const render = (canManage: boolean) => renderToStaticMarkup(createElement(CommunicationsWorkspace, {
    eventId: "event-1",
    eventName: "Synthetic Retreat",
    initialAnnouncements: [announcement("d1", "DRAFT"), announcement("p1", "PUBLISHED")] as never,
    initialMessaging: null,
    canManage,
    initialView: "announcements",
  }));

  it("shows Edit and Discard on the draft card only", () => {
    const html = render(true);
    const draftCard = html.slice(html.indexOf("Title d1"), html.indexOf("Title p1"));
    expect(draftCard).toContain("Edit draft");
    expect(draftCard).toContain("Discard draft");
    expect(draftCard).toContain("Publish to event feed");
    const publishedCard = html.slice(html.indexOf("Title p1"));
    expect(publishedCard).not.toContain("Edit draft");
    expect(publishedCard).not.toContain("Discard draft");
  });

  it("hides Edit and Discard from people who cannot manage communications", () => {
    const html = render(false);
    expect(html).not.toContain("Edit draft");
    expect(html).not.toContain("Discard draft");
  });
});
