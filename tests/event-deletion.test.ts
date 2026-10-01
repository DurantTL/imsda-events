import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DeleteEventDialogView } from "@/components/delete-event-dialog";
import {
  decideEventDeletion,
  eventNameConfirmed,
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
  formSubmissions: 0,
  imports: 0,
  merchandiseOrders: 0,
  clubRegistrationDrafts: 0,
  communityPosts: 0,
  announcements: 0,
  realPayments: 0,
};

function facts(overrides: { isPublished?: boolean; counts?: Partial<EventDeletionCounts> } = {}): EventDeletionFacts {
  return { isPublished: overrides.isPublished ?? false, counts: { ...emptyCounts, ...overrides.counts } };
}

describe("event deletion rules (#620)", () => {
  const admin = { globalRole: "SYSTEM_ADMIN" as const, eventRole: null };

  it("lets a system administrator delete an event with nothing attached", () => {
    expect(decideEventDeletion(admin, facts())).toEqual({ allowed: true });
    // Setup-only records (locations, forms without submissions) do not block.
    expect(decideEventDeletion(admin, facts({ counts: { locations: 3, forms: 2 } }))).toEqual({ allowed: true });
  });

  it.each([
    ["registrations", { registrations: 1 }],
    ["attendees", { attendees: 2 }],
    ["payments", { payments: 1 }],
    ["invoices", { invoices: 1 }],
    ["honors enrollments", { honorEnrollments: 1 }],
    ["form submissions", { formSubmissions: 1 }],
    ["imports", { imports: 1 }],
    ["merchandise orders", { merchandiseOrders: 1 }],
    ["club registration drafts", { clubRegistrationDrafts: 1 }],
    ["community posts", { communityPosts: 1 }],
    ["announcements", { announcements: 1 }],
    ["messages", { messages: 1 }],
  ] as const)("refuses even a system administrator when the event has %s, and points to unpublishing", (_label, counts) => {
    const decision = decideEventDeletion(admin, facts({ isPublished: true, counts }));
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toMatch(/cannot be deleted because it has/);
    expect(decision.allowed === false && decision.reason).toMatch(/Unpublish it instead/);
  });

  it("names every kind of attached record in the refusal", () => {
    const decision = decideEventDeletion(admin, facts({ counts: { registrations: 2, payments: 1, imports: 1 } }));
    expect(decision.allowed === false && decision.reason).toContain("2 registrations, 1 payment, 1 import run");
  });

  it("never lets an Event Admin or other staff delete, even an empty event", () => {
    for (const eventRole of ["EVENT_ADMIN", "REGISTRATION_MANAGER", "FINANCE_MANAGER", "READ_ONLY_STAFF", null]) {
      expect(decideEventDeletion({ globalRole: null, eventRole }, facts()).allowed).toBe(false);
    }
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

  it("explains a refusal and hides the confirmation field when records are attached", () => {
    const blocked = {
      name: "Renamed Camporee 2028",
      counts: { ...emptyCounts, registrations: 4 },
      decision: { allowed: false, reason: "This event cannot be deleted because it has 4 registrations. Unpublish it instead." } as const,
    };
    const markup = renderToStaticMarkup(view(blocked as unknown as typeof preview, ""));
    expect(markup).toContain("cannot be deleted because it has 4 registrations");
    expect(markup).not.toContain("Type the event name to confirm");
    expect(markup).toMatch(/lifecycle-danger-button"[^>]*disabled/);
  });
});
