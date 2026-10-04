import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #131: the registrant changes who is responsible for their minors from the private registration page. The
 * token names the registration; the route passes only the token and the choices. Synthetic data only.
 */
const mocks = vi.hoisted(() => ({
  rejectCrossOriginRequest: vi.fn(),
  updatePublicResponsibleAdults: vi.fn(),
  checkPublicManageRateLimit: vi.fn(),
}));

vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/public-access/repository", () => {
  class PublicResponsibleAdultError extends Error {
    constructor(public readonly code: string, message: string) { super(message); }
  }
  return { PublicResponsibleAdultError, updatePublicResponsibleAdults: mocks.updatePublicResponsibleAdults };
});
vi.mock("@/modules/rate-limit/service", () => ({ checkPublicManageRateLimit: mocks.checkPublicManageRateLimit }));

import { PUT } from "@/app/api/public/manage/[token]/responsible-adult/route";
import { PublicResponsibleAdultError } from "@/modules/public-access/repository";

const context = { params: Promise.resolve({ token: "private-token" }) };
const allowed = { allowed: true, decisions: [{ policy: "public.manage.update.client-token", allowed: true, limit: 20, remaining: 19, count: 1, windowSeconds: 900, resetAfterSeconds: 600 }] };

function request(body: unknown) {
  return new Request("https://events.imsda.test/api/public/manage/private-token/responsible-adult", {
    method: "PUT",
    headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.checkPublicManageRateLimit.mockResolvedValue(allowed);
  mocks.updatePublicResponsibleAdults.mockResolvedValue({ outcome: { changed: 1, sentToReview: 0 }, view: null });
});

describe("private registration responsible-adult route", () => {
  it("authorizes by private token only and passes the choices", async () => {
    const response = await PUT(request({ choices: { "att-son": "att-dad" } }), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.checkPublicManageRateLimit).toHaveBeenCalledWith(expect.any(Request), "private-token", "update");
    expect(mocks.updatePublicResponsibleAdults).toHaveBeenCalledWith("private-token", { "att-son": "att-dad" });
  });

  it("accepts nothing but choices: not a registration, event or person id", async () => {
    for (const body of [{ choices: {}, registrationId: "r-other" }, { choices: {}, eventId: "e-other" }, { registrationId: "r-other" }, "not json", { choices: { a: 1 } }]) {
      expect((await PUT(request(body), context)).status).toBe(400);
    }
    expect(mocks.updatePublicResponsibleAdults).not.toHaveBeenCalled();
  });

  it("is a 404 for a token that is not active, and refuses a cross-origin request", async () => {
    mocks.updatePublicResponsibleAdults.mockResolvedValueOnce(null);
    expect((await PUT(request({ choices: {} }), context)).status).toBe(404);
    mocks.rejectCrossOriginRequest.mockReturnValueOnce(Response.json({ error: "CROSS_ORIGIN" }, { status: 403 }));
    expect((await PUT(request({ choices: {} }), context)).status).toBe(403);
    expect(mocks.updatePublicResponsibleAdults).toHaveBeenCalledTimes(1);
  });

  it("is rate limited", async () => {
    mocks.checkPublicManageRateLimit.mockResolvedValueOnce({ ...allowed, allowed: false });
    expect((await PUT(request({ choices: {} }), context)).status).toBe(429);
    expect(mocks.updatePublicResponsibleAdults).not.toHaveBeenCalled();
  });

  it("maps a concurrent change to 409 and an event that verifies every edit to 403", async () => {
    mocks.updatePublicResponsibleAdults.mockRejectedValueOnce(new PublicResponsibleAdultError("CONCURRENT_CHANGE", "Someone else just changed this."));
    expect((await PUT(request({ choices: {} }), context)).status).toBe(409);
    mocks.updatePublicResponsibleAdults.mockRejectedValueOnce(new PublicResponsibleAdultError("EDIT_POLICY_REQUIRES_VERIFICATION", "Verify first."));
    expect((await PUT(request({ choices: {} }), context)).status).toBe(403);
  });

  it("reports an invalid choice as 422 and an inactive registration as 409", async () => {
    mocks.updatePublicResponsibleAdults.mockRejectedValueOnce(new PublicResponsibleAdultError("CHOICES_INVALID", "Choose an adult on this registration."));
    expect((await PUT(request({ choices: { "att-son": "att-elsewhere" } }), context)).status).toBe(422);
    mocks.updatePublicResponsibleAdults.mockRejectedValueOnce(new PublicResponsibleAdultError("REGISTRATION_NOT_ACTIVE", "Not active."));
    expect((await PUT(request({ choices: {} }), context)).status).toBe(409);
  });
});
