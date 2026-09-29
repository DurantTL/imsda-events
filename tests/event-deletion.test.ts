import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DeleteEventDialogView } from "@/components/delete-event-dialog";
import {
  decideEventDeletion,
  eventDeletionHasRealMoney,
  eventNameConfirmed,
  isDraftForDeletion,
  type EventDeletionCounts,
  type EventDeletionFacts,
} from "@/modules/events/deletion";

const emptyCounts: EventDeletionCounts = {
  registrations: 0,
  attendees: 0,
  payments: 0,
  invoices: 0,
  honorEnrollments: 0,
  locations: 0,
  forms: 0,
  messages: 0,
  queuedMessages: 0,
  realPayments: 0,
};

function facts(overrides: { isPublished?: boolean; counts?: Partial<EventDeletionCounts> } = {}): EventDeletionFacts {
  return { isPublished: overrides.isPublished ?? false, counts: { ...emptyCounts, ...overrides.counts } };
}

describe("event deletion rules (#620)", () => {
  it("lets a system administrator delete an event in any state", () => {
    const admin = { globalRole: "SYSTEM_ADMIN" as const, eventRole: null };
    expect(decideEventDeletion(admin, facts())).toEqual({ allowed: true });
    expect(decideEventDeletion(admin, facts({ isPublished: true, counts: { registrations: 40, payments: 12, realPayments: 3 } }))).toEqual({ allowed: true });
  });

  it("lets an Event Admin delete only a draft", () => {
    const eventAdmin = { globalRole: null, eventRole: "EVENT_ADMIN" };
    expect(decideEventDeletion(eventAdmin, facts())).toEqual({ allowed: true });
    expect(decideEventDeletion(eventAdmin, facts({ isPublished: true })).allowed).toBe(false);
    expect(decideEventDeletion(eventAdmin, facts({ counts: { registrations: 1 } })).allowed).toBe(false);
    expect(decideEventDeletion(eventAdmin, facts({ counts: { payments: 1 } })).allowed).toBe(false);
  });

  it("never lets other staff or non-members delete", () => {
    for (const eventRole of ["REGISTRATION_MANAGER", "FINANCE_MANAGER", "READ_ONLY_STAFF", null]) {
      expect(decideEventDeletion({ globalRole: null, eventRole }, facts()).allowed).toBe(false);
    }
  });

  it("treats an unpublished event with registrations as not a draft", () => {
    expect(isDraftForDeletion(facts())).toBe(true);
    expect(isDraftForDeletion(facts({ counts: { registrations: 2 } }))).toBe(false);
  });

  it("warns about real money for non-test payments or issued invoices only", () => {
    expect(eventDeletionHasRealMoney(emptyCounts)).toBe(false);
    expect(eventDeletionHasRealMoney({ realPayments: 1, invoices: 0 })).toBe(true);
    expect(eventDeletionHasRealMoney({ realPayments: 0, invoices: 2 })).toBe(true);
  });

  it("requires the exact event name, forgiving only surrounding spaces", () => {
    expect(eventNameConfirmed("Camporee 2028", " Camporee 2028 ")).toBe(true);
    expect(eventNameConfirmed("Camporee 2028", "camporee 2028")).toBe(false);
    expect(eventNameConfirmed("Camporee 2028", "")).toBe(false);
    expect(eventNameConfirmed("  ", "  ")).toBe(false);
  });
});

const deps = vi.hoisted(() => {
  class MockEventDeletionError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    MockEventDeletionError,
    deleteEvent: vi.fn(),
    getEventDeletionPreview: vi.fn(),
    findActiveMembership: vi.fn(),
    getCurrentSession: vi.fn(),
  };
});

vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: deps.getCurrentSession }));
vi.mock("@/modules/events/deletion-repository", () => ({
  EventDeletionError: deps.MockEventDeletionError,
  deleteEvent: deps.deleteEvent,
  getEventDeletionPreview: deps.getEventDeletionPreview,
}));
vi.mock("@/modules/events/repository", () => ({
  EventOperationError: class extends Error {},
  findActiveMembership: deps.findActiveMembership,
  getEventSettings: vi.fn(),
  updateEventSettings: vi.fn(),
}));

import { DELETE } from "@/app/api/events/[eventId]/route";
import { GET as PREVIEW } from "@/app/api/events/[eventId]/deletion/route";

const context = { params: Promise.resolve({ eventId: "evt_1" }) };

function deleteRequest(body: unknown) {
  return new Request("http://localhost/api/events/evt_1", {
    method: "DELETE",
    headers: { "content-type": "application/json", origin: "http://localhost", host: "localhost" },
    body: JSON.stringify(body),
  });
}

describe("event deletion routes (#620)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("rejects an unauthenticated delete", async () => {
    deps.getCurrentSession.mockResolvedValue({ user: null });
    const response = await DELETE(deleteRequest({ confirmName: "x" }), context);
    expect(response.status).toBe(401);
    expect(deps.deleteEvent).not.toHaveBeenCalled();
  });

  it("rejects staff without the configure permission", async () => {
    deps.getCurrentSession.mockResolvedValue({ user: { id: "u1", email: "a@example.test", displayName: "A", globalRole: null } });
    deps.findActiveMembership.mockResolvedValue({ eventId: "evt_1", userId: "u1", role: "READ_ONLY_STAFF", status: "ACTIVE", permissions: [] });
    const response = await DELETE(deleteRequest({ confirmName: "x" }), context);
    expect(response.status).toBe(403);
    expect(deps.deleteEvent).not.toHaveBeenCalled();
  });

  it("passes the actor and typed name to the deleting service", async () => {
    deps.getCurrentSession.mockResolvedValue({ user: { id: "admin", email: "s@example.test", displayName: "S", globalRole: "SYSTEM_ADMIN" } });
    deps.deleteEvent.mockResolvedValue({ eventId: "evt_1", name: "Camporee", counts: emptyCounts });
    const response = await DELETE(deleteRequest({ confirmName: "Camporee" }), context);
    expect(response.status).toBe(200);
    expect(deps.deleteEvent).toHaveBeenCalledWith({
      eventId: "evt_1",
      actor: { userId: "admin", globalRole: "SYSTEM_ADMIN" },
      confirmName: "Camporee",
    });
  });

  it("maps the service's refusals to 403 and 400", async () => {
    deps.getCurrentSession.mockResolvedValue({ user: { id: "u1", email: "a@example.test", displayName: "A", globalRole: null } });
    deps.findActiveMembership.mockResolvedValue({ eventId: "evt_1", userId: "u1", role: "EVENT_ADMIN", status: "ACTIVE", permissions: [] });
    deps.deleteEvent.mockRejectedValueOnce(new deps.MockEventDeletionError("EVENT_DELETE_FORBIDDEN", "no"));
    expect((await DELETE(deleteRequest({ confirmName: "x" }), context)).status).toBe(403);
    deps.deleteEvent.mockRejectedValueOnce(new deps.MockEventDeletionError("EVENT_NAME_MISMATCH", "name"));
    expect((await DELETE(deleteRequest({ confirmName: "x" }), context)).status).toBe(400);
    deps.deleteEvent.mockRejectedValueOnce(new deps.MockEventDeletionError("EVENT_NOT_FOUND", "gone"));
    expect((await DELETE(deleteRequest({ confirmName: "x" }), context)).status).toBe(404);
  });

  it("reports an unexpected failure with a deletion message and maps a busy event to 409", async () => {
    deps.getCurrentSession.mockResolvedValue({ user: { id: "admin", email: "s@example.test", displayName: "S", globalRole: "SYSTEM_ADMIN" } });
    deps.deleteEvent.mockRejectedValueOnce(new Error("boom"));
    const failed = await DELETE(deleteRequest({ confirmName: "x" }), context);
    expect(failed.status).toBe(500);
    expect((await failed.json()).message).toMatch(/could not be deleted/);
    deps.deleteEvent.mockRejectedValueOnce(new deps.MockEventDeletionError("EVENT_BUSY", "busy"));
    expect((await DELETE(deleteRequest({ confirmName: "x" }), context)).status).toBe(409);
  });

  it("serves the preview to an authorized user", async () => {
    deps.getCurrentSession.mockResolvedValue({ user: { id: "admin", email: "s@example.test", displayName: "S", globalRole: "SYSTEM_ADMIN" } });
    deps.getEventDeletionPreview.mockResolvedValue({ eventId: "evt_1", name: "Camporee", counts: emptyCounts, decision: { allowed: true } });
    const response = await PREVIEW(new Request("http://localhost/api/events/evt_1/deletion"), context);
    expect(response.status).toBe(200);
    expect((await response.json()).preview.name).toBe("Camporee");
  });
});

describe("delete event dialog (#620)", () => {
  const noop = () => undefined;
  const view = (value: typeof preview, typed: string) => createElement(DeleteEventDialogView, {
    busy: false, error: "", loadFailed: false, onCancel: noop, onConfirm: noop, onTyped: noop, open: true, preview: value, typed,
  });
  const preview = { name: "Renamed Camporee 2028", counts: emptyCounts, decision: { allowed: true } as const };

  it("names the event from the server's preview, so a rename in the same page is not stale", () => {
    const markup = renderToStaticMarkup(view(preview, ""));
    expect(markup).toContain("Delete Renamed Camporee 2028?");
    expect(markup).toContain('placeholder="Renamed Camporee 2028"');
    expect(markup).not.toContain("Old Camporee");
  });

  it("disables confirm until the previewed name is typed", () => {
    const render = (typed: string) => renderToStaticMarkup(view(preview, typed));
    expect(render("Old Camporee 2028")).toMatch(/lifecycle-danger-button"[^>]*disabled/);
    expect(render("Renamed Camporee 2028")).not.toMatch(/lifecycle-danger-button"[^>]*disabled/);
  });

  it("shows the real-money warning only when payments are not test-mode", () => {
    const withMoney = { ...preview, counts: { ...emptyCounts, realPayments: 1 } };
    const render = (value: typeof preview) => renderToStaticMarkup(view(value, ""));
    expect(render(withMoney)).toContain("payment history will be removed");
    expect(render(preview)).not.toContain("payment history will be removed");
  });
});
