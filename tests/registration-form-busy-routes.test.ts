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
    getRegistrationForm: vi.fn(),
    updateRegistrationForm: vi.fn(),
    publishRegistrationForm: vi.fn(),
    unpublishRegistrationForm: vi.fn(),
  };
});

vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: dependencies.getCurrentSession }));
vi.mock("@/modules/events/repository", () => ({ findActiveMembership: dependencies.findActiveMembership }));
vi.mock("@/modules/forms/repository", () => ({
  FormOperationError: dependencies.FormOperationError,
  getRegistrationForm: dependencies.getRegistrationForm,
  updateRegistrationForm: dependencies.updateRegistrationForm,
  publishRegistrationForm: dependencies.publishRegistrationForm,
  unpublishRegistrationForm: dependencies.unpublishRegistrationForm,
}));

import { PATCH } from "@/app/api/events/[eventId]/forms/[formId]/route";
import { POST as publish } from "@/app/api/events/[eventId]/forms/[formId]/publish/route";
import { POST as unpublish } from "@/app/api/events/[eventId]/forms/[formId]/unpublish/route";
import { formTemplates } from "@/modules/forms/definition";

// Synthetic staff only.
const staff = { id: "usr_staff", email: "staff@example.test", displayName: "Synthetic Staff", globalRole: null };
const context = { params: Promise.resolve({ eventId: "event-1", formId: "form-1" }) };
const origin = "https://events.imsda.test";

function post(method: string, path: string, body?: unknown) {
  return new Request(`${origin}/api/events/event-1/forms/form-1${path}`, {
    method,
    headers: { "content-type": "application/json", origin },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.getCurrentSession.mockResolvedValue({ user: staff });
  dependencies.findActiveMembership.mockResolvedValue({ eventId: "event-1", userId: staff.id, role: "REGISTRATION_MANAGER", status: "ACTIVE", permissions: [] });
});

describe("a busy form (lock wait gave up) answers 409 on every writer route (#564)", () => {
  const busy = () => new dependencies.FormOperationError("FORM_BUSY", "This form is being changed by someone else right now.");

  it("save", async () => {
    dependencies.updateRegistrationForm.mockRejectedValue(busy());
    const response = await PATCH(post("PATCH", "", { definition: formTemplates[0].definition, expectedUpdatedAt: "2026-09-01T00:00:00.000Z" }), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "FORM_BUSY" });
  });

  it("publish", async () => {
    dependencies.publishRegistrationForm.mockRejectedValue(busy());
    const response = await publish(post("POST", "/publish"), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "FORM_BUSY" });
  });

  it("unpublish", async () => {
    dependencies.unpublishRegistrationForm.mockRejectedValue(busy());
    const response = await unpublish(post("POST", "/unpublish"), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "FORM_BUSY" });
  });
});
