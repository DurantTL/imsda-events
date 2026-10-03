import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #741 slice 3: the request and decision routes. Same-origin only, server-side
 * authorization, validation, and rate limiting. The service is mocked here; its
 * rules are tested in module-requests-service.test.ts. Synthetic data only.
 */
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  createModuleRequest: vi.fn(),
  decideModuleRequest: vi.fn(),
  checkModuleRequestRateLimit: vi.fn(),
}));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/lib/env", () => ({
  getServerEnv: () => ({ APP_BASE_URL: "https://events.imsda.test" }),
  isServerEnvironmentError: () => false,
}));
vi.mock("@/modules/rate-limit/service", () => ({ checkModuleRequestRateLimit: mocks.checkModuleRequestRateLimit }));
vi.mock("@/modules/event-modules/requests", async () => {
  const actual = await vi.importActual<typeof import("@/modules/event-modules/request-domain")>("@/modules/event-modules/request-domain");
  class ModuleRequestError extends Error {
    constructor(message: string, public readonly code: string) { super(message); }
  }
  return { ...actual, ModuleRequestError, createModuleRequest: mocks.createModuleRequest, decideModuleRequest: mocks.decideModuleRequest };
});

import { POST as requestPost } from "@/app/api/events/[eventId]/module-requests/route";
import { POST as decisionPost } from "@/app/api/admin/module-requests/[requestId]/decision/route";
import { AccessDeniedError } from "@/modules/access/authorization";
import { ModuleRequestError } from "@/modules/event-modules/requests";

const eventAdmin = { id: "user-ea", globalRole: null };
const systemAdmin = { id: "user-admin", globalRole: "SYSTEM_ADMIN" };

function post(body: unknown, origin: string | null = "https://events.imsda.test") {
  return new Request("https://events.imsda.test/api/test", {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  });
}
const requestContext = { params: Promise.resolve({ eventId: "event-1" }) };
const decisionContext = { params: Promise.resolve({ requestId: "req-1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentSession.mockResolvedValue({ user: eventAdmin });
  mocks.checkModuleRequestRateLimit.mockResolvedValue({ allowed: true, decisions: [] });
  mocks.createModuleRequest.mockResolvedValue({ id: "req-1" });
  mocks.decideModuleRequest.mockResolvedValue({ status: "APPROVED" });
});

describe("POST /api/events/[eventId]/module-requests", () => {
  it("creates a request for the signed-in event admin", async () => {
    const response = await requestPost(post({ moduleKey: "merchandise", reason: "Shirts." }), requestContext);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: "req-1", status: "PENDING" });
    expect(mocks.createModuleRequest).toHaveBeenCalledWith(eventAdmin, "event-1", "merchandise", "Shirts.");
  });

  it("rejects a cross-origin request or one with no Origin before any session work", async () => {
    for (const origin of ["https://elsewhere.example", null]) {
      const response = await requestPost(post({ moduleKey: "merchandise", reason: "Shirts." }, origin), requestContext);
      expect(response.status).toBe(403);
      expect((await response.json()).error).toBe("INVALID_REQUEST_ORIGIN");
    }
    expect(mocks.getCurrentSession).not.toHaveBeenCalled();
    expect(mocks.createModuleRequest).not.toHaveBeenCalled();
  });

  it("answers a signed-out caller with 401", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: null });
    expect((await requestPost(post({ moduleKey: "merchandise", reason: "Shirts." }), requestContext)).status).toBe(401);
    expect(mocks.createModuleRequest).not.toHaveBeenCalled();
  });

  it("passes the service's permission refusal through as 403", async () => {
    mocks.createModuleRequest.mockRejectedValue(new AccessDeniedError("The CONFIGURE_EVENT permission is required for this event.", 403, "PERMISSION_DENIED"));
    const response = await requestPost(post({ moduleKey: "merchandise", reason: "Shirts." }), requestContext);
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("PERMISSION_DENIED");
  });

  it("rejects a missing or over-long reason with 400 before the service", async () => {
    expect((await requestPost(post({ moduleKey: "merchandise", reason: "  " }), requestContext)).status).toBe(400);
    expect((await requestPost(post({ moduleKey: "merchandise", reason: "x".repeat(501) }), requestContext)).status).toBe(400);
    expect((await requestPost(post({}), requestContext)).status).toBe(400);
    expect(mocks.createModuleRequest).not.toHaveBeenCalled();
  });

  it("answers 409 for a pending or already-on request", async () => {
    mocks.createModuleRequest.mockRejectedValue(new ModuleRequestError("Already waiting.", "ALREADY_PENDING"));
    const response = await requestPost(post({ moduleKey: "merchandise", reason: "Shirts." }), requestContext);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("ALREADY_PENDING");
  });

  it("answers 403 when a system administrator tries to request", async () => {
    mocks.createModuleRequest.mockRejectedValue(new ModuleRequestError("Turn it on directly.", "SYSTEM_ADMIN_ENABLES_DIRECTLY"));
    const response = await requestPost(post({ moduleKey: "merchandise", reason: "Shirts." }), requestContext);
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("SYSTEM_ADMIN_ENABLES_DIRECTLY");
  });

  it("answers 429 with the rate limit headers once the limit is spent, without calling the service", async () => {
    mocks.checkModuleRequestRateLimit.mockResolvedValue({
      allowed: false,
      decisions: [{ policy: "staff.module-request.account", allowed: false, limit: 10, remaining: 0, count: 11, windowSeconds: 3600, resetAfterSeconds: 120 }],
    });
    const response = await requestPost(post({ moduleKey: "merchandise", reason: "Shirts." }), requestContext);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBeTruthy();
    expect(mocks.createModuleRequest).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/module-requests/[requestId]/decision", () => {
  it("approves for a system administrator", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: systemAdmin });
    const response = await decisionPost(post({ decision: "approve" }), decisionContext);
    expect(response.status).toBe(200);
    expect(mocks.decideModuleRequest).toHaveBeenCalledWith(systemAdmin, "req-1", { decision: "approve" });
  });

  it("refuses an event admin with 403 before reading the body or calling the service", async () => {
    const response = await decisionPost(post({ decision: "approve" }), decisionContext);
    expect(response.status).toBe(403);
    expect(mocks.decideModuleRequest).not.toHaveBeenCalled();
  });

  it("answers a signed-out caller with 401 and a cross-origin one with 403", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: null });
    expect((await decisionPost(post({ decision: "approve" }), decisionContext)).status).toBe(401);
    mocks.getCurrentSession.mockResolvedValue({ user: systemAdmin });
    const response = await decisionPost(post({ decision: "approve" }, "https://elsewhere.example"), decisionContext);
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("INVALID_REQUEST_ORIGIN");
    expect(mocks.decideModuleRequest).not.toHaveBeenCalled();
  });

  it("requires a reason to decline", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: systemAdmin });
    expect((await decisionPost(post({ decision: "decline" }), decisionContext)).status).toBe(400);
    expect((await decisionPost(post({ decision: "decline", declineReason: "  " }), decisionContext)).status).toBe(400);
    expect(mocks.decideModuleRequest).not.toHaveBeenCalled();
    const ok = await decisionPost(post({ decision: "decline", declineReason: "Not this year." }), decisionContext);
    expect(ok.status).toBe(200);
    expect(mocks.decideModuleRequest).toHaveBeenCalledWith(systemAdmin, "req-1", { decision: "decline", declineReason: "Not this year." });
  });

  it("maps a decided or missing request to 409 and 404", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: systemAdmin });
    mocks.decideModuleRequest.mockRejectedValueOnce(new ModuleRequestError("Already decided.", "ALREADY_DECIDED"));
    expect((await decisionPost(post({ decision: "approve" }), decisionContext)).status).toBe(409);
    mocks.decideModuleRequest.mockRejectedValueOnce(new ModuleRequestError("Missing.", "REQUEST_NOT_FOUND"));
    expect((await decisionPost(post({ decision: "approve" }), decisionContext)).status).toBe(404);
  });
});
