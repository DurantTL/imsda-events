import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rejectCrossOriginRequest: vi.fn(),
  requireHonorPermission: vi.fn(),
  writeBackHonorsWeekendCompletions: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/honors/access", () => ({ requireHonorPermission: mocks.requireHonorPermission }));
vi.mock("@/modules/honors/weekend-completion-repository", async () => {
  const actual = await vi.importActual<typeof import("@/modules/honors/weekend-completion-repository")>("@/modules/honors/weekend-completion-repository");
  return { ...actual, writeBackHonorsWeekendCompletions: mocks.writeBackHonorsWeekendCompletions };
});

import { POST } from "@/app/api/events/[eventId]/honors/completions/route";
import { AccessDeniedError } from "@/modules/access/authorization";
import { HonorsWeekendWriteBackError } from "@/modules/honors/weekend-completion-repository";

const eventContext = { params: Promise.resolve({ eventId: "site-b" }) };
function request() {
  return new Request("https://events.imsda.test/api/x", { method: "POST", headers: { origin: "https://events.imsda.test" } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.requireHonorPermission.mockResolvedValue({ user: { id: "staff-1" } });
  mocks.writeBackHonorsWeekendCompletions.mockResolvedValue({ written: 3, alreadyRecorded: 2, skipped: 1 });
});

describe("Honors Weekend write-back route (#487)", () => {
  it("requires the event's own CONFIGURE_EVENT permission and reports what was written", async () => {
    const response = await POST(request(), eventContext);
    expect(mocks.requireHonorPermission).toHaveBeenCalledWith("site-b");
    expect(mocks.writeBackHonorsWeekendCompletions).toHaveBeenCalledWith("site-b", "staff-1");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ written: 3, alreadyRecorded: 2, skipped: 1 });
  });

  it("refuses someone without permission on this event", async () => {
    mocks.requireHonorPermission.mockRejectedValue(new AccessDeniedError("nope", 403, "PERMISSION_DENIED"));
    const response = await POST(request(), eventContext);
    expect(response.status).toBe(403);
    expect(mocks.writeBackHonorsWeekendCompletions).not.toHaveBeenCalled();
  });

  it("404s an unknown event", async () => {
    mocks.writeBackHonorsWeekendCompletions.mockRejectedValue(new HonorsWeekendWriteBackError("EVENT_NOT_FOUND", "That event could not be found."));
    const response = await POST(request(), eventContext);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "EVENT_NOT_FOUND" });
  });
});
