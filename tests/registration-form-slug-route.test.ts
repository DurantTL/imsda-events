import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => {
  class MockFormOperationError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
      this.name = "FormOperationError";
    }
  }
  return {
    FormOperationError: MockFormOperationError,
    findActiveMembership: vi.fn(),
    getCurrentSession: vi.fn(),
    suggestRegistrationFormSlug: vi.fn(),
    updateRegistrationFormSlug: vi.fn(),
  };
});

vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: dependencies.getCurrentSession }));
vi.mock("@/modules/events/repository", () => ({ findActiveMembership: dependencies.findActiveMembership }));
vi.mock("@/modules/forms/repository", () => ({
  FormOperationError: dependencies.FormOperationError,
  suggestRegistrationFormSlug: dependencies.suggestRegistrationFormSlug,
  updateRegistrationFormSlug: dependencies.updateRegistrationFormSlug,
}));

import { GET, PATCH } from "@/app/api/events/[eventId]/forms/[formId]/slug/route";

// Synthetic staff only.
const staff = { id: "usr_staff", email: "staff@example.test", displayName: "Synthetic Staff", globalRole: null };

function membership(role: string) {
  return { eventId: "event-1", userId: staff.id, role, status: "ACTIVE", permissions: [] };
}

function context(eventId = "event-1", formId = "form-1") {
  return { params: Promise.resolve({ eventId, formId }) };
}

function patchRequest(body: unknown, origin = "https://events.imsda.test", eventId = "event-1") {
  return new Request(`https://events.imsda.test/api/events/${eventId}/forms/form-1/slug`, {
    method: "PATCH",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.getCurrentSession.mockResolvedValue({ user: staff });
  dependencies.findActiveMembership.mockResolvedValue(membership("REGISTRATION_MANAGER"));
});

describe("PATCH /api/events/[eventId]/forms/[formId]/slug", () => {
  it("updates the slug for staff who can manage forms", async () => {
    dependencies.updateRegistrationFormSlug.mockResolvedValue({ id: "form-1", slug: "honors-weekend-registration" });

    const response = await PATCH(patchRequest({ slug: "honors-weekend-registration" }), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ form: { slug: "honors-weekend-registration" } });
    expect(dependencies.updateRegistrationFormSlug).toHaveBeenCalledWith("event-1", "form-1", staff.id, "honors-weekend-registration");
  });

  it("returns 403 without MANAGE_FORMS", async () => {
    dependencies.findActiveMembership.mockResolvedValue(membership("COMMUNICATIONS_MANAGER"));

    const response = await PATCH(patchRequest({ slug: "honors-weekend-registration" }), context());

    expect(response.status).toBe(403);
    expect(dependencies.updateRegistrationFormSlug).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin request before any lookup", async () => {
    const response = await PATCH(patchRequest({ slug: "honors-weekend-registration" }, "https://attacker.example"), context());

    expect(response.status).toBe(403);
    expect(dependencies.getCurrentSession).not.toHaveBeenCalled();
    expect(dependencies.updateRegistrationFormSlug).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed web address", async () => {
    const response = await PATCH(patchRequest({ slug: "Not a slug!" }), context());

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "INVALID_FORM" });
    expect(dependencies.updateRegistrationFormSlug).not.toHaveBeenCalled();
  });

  it("returns 404 for a form that belongs to another event", async () => {
    dependencies.updateRegistrationFormSlug.mockRejectedValue(
      new dependencies.FormOperationError("FORM_NOT_FOUND", "That registration form was not found."),
    );

    const response = await PATCH(patchRequest({ slug: "honors-weekend-registration" }, undefined, "event-2"), context("event-2", "form-1"));

    expect(response.status).toBe(404);
    expect(dependencies.updateRegistrationFormSlug).toHaveBeenCalledWith("event-2", "form-1", staff.id, "honors-weekend-registration");
  });

  it("returns 409 SLUG_LOCKED once the form has been published", async () => {
    dependencies.updateRegistrationFormSlug.mockRejectedValue(
      new dependencies.FormOperationError("SLUG_LOCKED", "This form has already been published, so its web address can no longer change automatically."),
    );

    const response = await PATCH(patchRequest({ slug: "honors-weekend-registration" }), context());

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "SLUG_LOCKED" });
  });
});

describe("GET /api/events/[eventId]/forms/[formId]/slug", () => {
  it("returns the offered address for staff who can manage forms", async () => {
    dependencies.suggestRegistrationFormSlug.mockResolvedValue({ currentSlug: "a", offeredSlug: "b", needsSync: true, locked: false });

    const response = await GET(new Request("https://events.imsda.test/api/events/event-1/forms/form-1/slug"), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ suggestion: { offeredSlug: "b", needsSync: true } });
  });

  it("returns 403 without MANAGE_FORMS", async () => {
    dependencies.findActiveMembership.mockResolvedValue(membership("READ_ONLY_STAFF"));

    const response = await GET(new Request("https://events.imsda.test/api/events/event-1/forms/form-1/slug"), context());

    expect(response.status).toBe(403);
    expect(dependencies.suggestRegistrationFormSlug).not.toHaveBeenCalled();
  });
});
