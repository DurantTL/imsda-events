import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireHonorPermission: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
  setHonorWaitlistOfferHours: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/honors/access", () => ({ requireHonorPermission: mocks.requireHonorPermission }));
vi.mock("@/modules/honors/waitlist-repository", () => ({
  setHonorWaitlistOfferHours: mocks.setHonorWaitlistOfferHours,
  ClassSelectionError: class extends Error { code = "SELECTION_INVALID"; },
}));

import { PUT } from "@/app/api/events/[eventId]/honors/waitlist/route";
import { AccessDeniedError } from "@/modules/access/authorization";
import { HonorConfigurationError } from "@/modules/honors/repository";

const ctx = { params: Promise.resolve({ eventId: "event-1" }) };
const request = (body: unknown) => new Request("https://events.imsda.test/api/x", {
  method: "PUT",
  headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.requireHonorPermission.mockResolvedValue({ user: { id: "staff-1" } });
  mocks.setHonorWaitlistOfferHours.mockResolvedValue({ offerHours: 36 });
});

describe("class waitlist window route (#831)", () => {
  it("saves the window for staff who can configure the event", async () => {
    const response = await PUT(request({ offerHours: 36 }), ctx);
    expect(response.status).toBe(200);
    expect(mocks.requireHonorPermission).toHaveBeenCalledWith("event-1");
    expect(mocks.setHonorWaitlistOfferHours).toHaveBeenCalledWith("event-1", 36, "staff-1");
  });

  it("refuses someone without the permission, before changing anything", async () => {
    mocks.requireHonorPermission.mockRejectedValueOnce(new AccessDeniedError("No.", 403, "PERMISSION_DENIED"));
    const response = await PUT(request({ offerHours: 36 }), ctx);
    expect(response.status).toBe(403);
    expect(mocks.setHonorWaitlistOfferHours).not.toHaveBeenCalled();
  });

  it("refuses a window outside 1 to 168 hours, a fraction, a string, and extra fields", async () => {
    for (const body of [{ offerHours: 0 }, { offerHours: 169 }, { offerHours: 1.5 }, { offerHours: "24" }, { offerHours: 24, extra: true }, {}]) {
      expect((await PUT(request(body), ctx)).status).toBe(400);
    }
    expect(mocks.setHonorWaitlistOfferHours).not.toHaveBeenCalled();
  });

  it("answers 404, not 422, for an unknown event", async () => {
    mocks.setHonorWaitlistOfferHours.mockRejectedValueOnce(new HonorConfigurationError("EVENT_NOT_FOUND", "That event could not be found."));
    const response = await PUT(request({ offerHours: 24 }), ctx);
    expect(response.status).toBe(404);
  });

  it("requires a same-origin request", async () => {
    mocks.rejectCrossOriginRequest.mockReturnValueOnce(Response.json({ error: "CROSS_ORIGIN" }, { status: 403 }));
    expect((await PUT(request({ offerHours: 24 }), ctx)).status).toBe(403);
    expect(mocks.requireHonorPermission).not.toHaveBeenCalled();
  });
});
