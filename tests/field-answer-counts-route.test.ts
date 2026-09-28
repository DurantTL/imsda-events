import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  findActiveMembership: vi.fn(),
  countFieldAnswers: vi.fn(),
  formBelongsToEvent: vi.fn(),
}));

vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: dependencies.getCurrentSession }));
vi.mock("@/modules/events/repository", () => ({ findActiveMembership: dependencies.findActiveMembership }));
vi.mock("@/modules/forms/repository", () => ({
  countFieldAnswers: dependencies.countFieldAnswers,
  formBelongsToEvent: dependencies.formBelongsToEvent,
}));

import { POST } from "@/app/api/events/[eventId]/forms/[formId]/field-answer-counts/route";

/**
 * The registration builder's "review before removing" dialog (#471) loads
 * real submitted-answer counts through this route.
 */
describe("POST /api/events/[eventId]/forms/[formId]/field-answer-counts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dependencies.getCurrentSession.mockResolvedValue({
      user: { id: "usr_system", email: "system@example.test", displayName: "System Admin", globalRole: "SYSTEM_ADMIN" },
    });
    dependencies.formBelongsToEvent.mockImplementation(async (eventId: string, formId: string) => eventId === "event-1" && formId === "form-1");
  });

  function request(body: unknown, origin = "https://events.imsda.test") {
    return new Request("https://events.imsda.test/api/events/event-1/forms/form-1/field-answer-counts", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify(body),
    });
  }

  it("returns real counts for the requested field keys", async () => {
    dependencies.countFieldAnswers.mockResolvedValue({ shirt_size: 42, dietary_notes: 0 });

    const response = await POST(
      request({ fieldKeys: ["shirt_size", "dietary_notes"] }),
      { params: Promise.resolve({ eventId: "event-1", formId: "form-1" }) },
    );

    expect(response.status).toBe(200);
    expect(dependencies.formBelongsToEvent).toHaveBeenCalledWith("event-1", "form-1");
    expect(dependencies.countFieldAnswers).toHaveBeenCalledWith("event-1", ["shirt_size", "dietary_notes"]);
    expect(await response.json()).toEqual({ counts: { shirt_size: 42, dietary_notes: 0 } });
  });

  it("rejects an empty field key list without counting", async () => {
    const response = await POST(
      request({ fieldKeys: [] }),
      { params: Promise.resolve({ eventId: "event-1", formId: "form-1" }) },
    );

    expect(response.status).toBe(400);
    expect(dependencies.countFieldAnswers).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin request before counting", async () => {
    const response = await POST(
      request({ fieldKeys: ["shirt_size"] }, "https://untrusted.example"),
      { params: Promise.resolve({ eventId: "event-1", formId: "form-1" }) },
    );

    expect(response.status).toBe(403);
    expect(dependencies.countFieldAnswers).not.toHaveBeenCalled();
  });

  it("requires MANAGE_FORMS permission", async () => {
    dependencies.getCurrentSession.mockResolvedValue({
      user: { id: "usr_staff", email: "staff@example.test", displayName: "Staff", globalRole: null },
    });
    dependencies.findActiveMembership.mockResolvedValue(null);

    const response = await POST(
      request({ fieldKeys: ["shirt_size"] }),
      { params: Promise.resolve({ eventId: "event-1", formId: "form-1" }) },
    );

    expect(response.status).toBe(403);
    expect(dependencies.countFieldAnswers).not.toHaveBeenCalled();
  });

  it("returns 404 for another event's form, without counting", async () => {
    const response = await POST(
      request({ fieldKeys: ["shirt_size"] }),
      { params: Promise.resolve({ eventId: "event-1", formId: "form-of-event-2" }) },
    );

    expect(response.status).toBe(404);
    expect(dependencies.formBelongsToEvent).toHaveBeenCalledWith("event-1", "form-of-event-2");
    expect(dependencies.countFieldAnswers).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ error: "FORM_NOT_FOUND" });
  });

  it("returns 400, not 500, for a malformed JSON body", async () => {
    const response = await POST(
      new Request("https://events.imsda.test/api/events/event-1/forms/form-1/field-answer-counts", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://events.imsda.test" },
        body: "{not json",
      }),
      { params: Promise.resolve({ eventId: "event-1", formId: "form-1" }) },
    );

    expect(response.status).toBe(400);
    expect(dependencies.countFieldAnswers).not.toHaveBeenCalled();
  });

  it("passes keys through exactly as stored, without trimming", async () => {
    dependencies.countFieldAnswers.mockResolvedValue({ " padded ": 0 });

    const response = await POST(
      request({ fieldKeys: [" padded "] }),
      { params: Promise.resolve({ eventId: "event-1", formId: "form-1" }) },
    );

    expect(response.status).toBe(200);
    expect(dependencies.countFieldAnswers).toHaveBeenCalledWith("event-1", [" padded "]);
  });

  it("rejects more keys than one batch", async () => {
    const response = await POST(
      request({ fieldKeys: Array.from({ length: 21 }, (_, index) => `field_${index}`) }),
      { params: Promise.resolve({ eventId: "event-1", formId: "form-1" }) },
    );

    expect(response.status).toBe(400);
    expect(dependencies.countFieldAnswers).not.toHaveBeenCalled();
  });
});
