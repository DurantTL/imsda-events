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
    createTestSubmission: vi.fn(),
  };
});

vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: dependencies.getCurrentSession }));
vi.mock("@/modules/events/repository", () => ({ findActiveMembership: dependencies.findActiveMembership }));
vi.mock("@/modules/forms/repository", () => ({
  FormOperationError: dependencies.FormOperationError,
  createTestSubmission: dependencies.createTestSubmission,
}));

import { POST } from "@/app/api/events/[eventId]/forms/[formId]/test-submissions/route";

// Synthetic staff only.
const staff = { id: "usr_staff", email: "staff@example.test", displayName: "Synthetic Staff", globalRole: null };

function request() {
  return new Request("https://events.imsda.test/api/events/event-1/forms/form-1/test-submissions", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://events.imsda.test" },
    body: JSON.stringify({ versionId: "version-1", responses: {} }),
  });
}
const context = { params: Promise.resolve({ eventId: "event-1", formId: "form-1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.getCurrentSession.mockResolvedValue({ user: staff });
  dependencies.findActiveMembership.mockResolvedValue({ eventId: "event-1", userId: staff.id, role: "REGISTRATION_MANAGER", status: "ACTIVE", permissions: [] });
});

describe("POST /api/events/[eventId]/forms/[formId]/test-submissions (#564)", () => {
  it.each(["EDIT_CONFLICT", "FORM_BUSY"])("answers %s with 409 so the builder shows the reload message", async (code) => {
    dependencies.createTestSubmission.mockRejectedValue(new dependencies.FormOperationError(code, "changed"));
    const response = await POST(request(), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: code });
  });

  it("still answers a missing version with 404", async () => {
    dependencies.createTestSubmission.mockRejectedValue(new dependencies.FormOperationError("VERSION_NOT_FOUND", "missing"));
    expect((await POST(request(), context)).status).toBe(404);
  });
});
