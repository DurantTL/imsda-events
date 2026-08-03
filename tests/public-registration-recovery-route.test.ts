import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
  processQueuedMessageIdsAfterCommit: vi.fn(),
  establishRegistrationAccess: vi.fn(),
  requestRegistrationAccessRecovery: vi.fn(),
  checkRegistrationCodeAccessRateLimit: vi.fn(),
  checkRegistrationRecoveryRateLimit: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => ({
  ...await importOriginal<typeof import("next/server")>(),
  after: mocks.after,
}));
vi.mock("@/modules/access/request-security", () => ({
  rejectCrossOriginRequest: mocks.rejectCrossOriginRequest,
}));
vi.mock("@/modules/communications/messaging-repository", () => ({
  processQueuedMessageIdsAfterCommit: mocks.processQueuedMessageIdsAfterCommit,
}));
vi.mock("@/modules/public-access/repository", () => ({
  establishRegistrationAccess: mocks.establishRegistrationAccess,
  requestRegistrationAccessRecovery: mocks.requestRegistrationAccessRecovery,
}));
vi.mock("@/modules/rate-limit/service", () => ({
  checkRegistrationCodeAccessRateLimit:
    mocks.checkRegistrationCodeAccessRateLimit,
  checkRegistrationRecoveryRateLimit: mocks.checkRegistrationRecoveryRateLimit,
}));

import { POST } from "@/app/api/public/registration-recovery/route";

function outcome(allowed: boolean) {
  return {
    allowed,
    decisions: [{
      policy: "registration.recovery.subject",
      allowed,
      limit: 3,
      remaining: allowed ? 2 : 0,
      count: allowed ? 1 : 4,
      windowSeconds: 3600,
      resetAfterSeconds: 900,
    }],
  };
}

function request(body: unknown) {
  return new Request(
    "https://events.imsda.test/api/public/registration-recovery",
    {
      method: "POST",
      headers: {
        origin: "https://events.imsda.test",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.checkRegistrationCodeAccessRateLimit.mockResolvedValue(outcome(true));
  mocks.checkRegistrationRecoveryRateLimit.mockResolvedValue(outcome(true));
  mocks.establishRegistrationAccess.mockResolvedValue(null);
  mocks.requestRegistrationAccessRecovery.mockResolvedValue({
    pendingMessageIds: [],
  });
});

describe("public registration recovery route", () => {
  it("returns scoped direct access for matching registration details", async () => {
    const input = {
      action: "access",
      clientRequestId: "34335e39-e0a0-4dd2-af6e-b97df37a915f",
      confirmationCode: "REG-PRIVATE",
      email: "guest@example.test",
    };
    mocks.establishRegistrationAccess.mockResolvedValue({
      managePath: "/manage/private-token",
      expiresAt: new Date("2026-08-03T18:30:00.000Z"),
    });

    const response = await POST(request(input));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      managePath: "/manage/private-token",
      expiresAt: "2026-08-03T18:30:00.000Z",
    });
    expect(mocks.checkRegistrationCodeAccessRateLimit).toHaveBeenCalledWith(
      expect.any(Request),
      input,
    );
    expect(mocks.establishRegistrationAccess).toHaveBeenCalledWith(input);
    expect(mocks.requestRegistrationAccessRecovery).not.toHaveBeenCalled();
  });

  it("returns one failure response for invalid or mismatched direct access", async () => {
    const invalidCode = await POST(request({
      action: "access",
      clientRequestId: "c01b88f2-f408-481b-8c2a-ec4b2cb79d70",
      confirmationCode: "INVALID",
      email: "guest@example.test",
    }));
    const mismatchedEmail = await POST(request({
      action: "access",
      clientRequestId: "c43ee22d-c9e7-4ce3-ac6e-ccac92acdf89",
      confirmationCode: "REG-PRIVATE",
      email: "other@example.test",
    }));

    expect(invalidCode.status).toBe(401);
    expect(await invalidCode.json()).toEqual(await mismatchedEmail.json());
  });

  it("returns the same noindex response whether or not a matching email was queued", async () => {
    const input = {
      action: "email",
      clientRequestId: "5f579588-13e4-455a-88fa-284f667ef2df",
      email: "guest@example.test",
    };
    const mismatch = await POST(request(input));
    mocks.requestRegistrationAccessRecovery.mockResolvedValueOnce({
      pendingMessageIds: ["message-1"],
    });
    const match = await POST(request(input));

    expect(match.status).toBe(200);
    expect(await match.json()).toEqual(await mismatch.json());
    expect(match.headers.get("x-robots-tag")).toContain("noindex");
    expect(match.headers.get("cache-control")).toContain("no-store");
    expect(mocks.after).toHaveBeenCalledOnce();
    expect(mocks.requestRegistrationAccessRecovery).toHaveBeenLastCalledWith(input);
    expect(mocks.checkRegistrationRecoveryRateLimit).toHaveBeenLastCalledWith(
      expect.any(Request),
      input.email,
    );
  });

  it.each(["access", "email"] as const)(
    "rate limits %s before attempting a registration lookup",
    async (action) => {
    const rateLimit = action === "access"
      ? mocks.checkRegistrationCodeAccessRateLimit
      : mocks.checkRegistrationRecoveryRateLimit;
    rateLimit.mockResolvedValue(outcome(false));
    const response = await POST(request({
      action,
      clientRequestId: "3c93b274-3726-4a44-a831-e786eb4c218a",
      ...(action === "access" ? { confirmationCode: "REG-PRIVATE" } : {}),
      email: "guest@example.test",
    }));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("900");
    expect(mocks.establishRegistrationAccess).not.toHaveBeenCalled();
    expect(mocks.requestRegistrationAccessRecovery).not.toHaveBeenCalled();
  });

  it("rejects cross-origin requests before parsing registration details", async () => {
    mocks.rejectCrossOriginRequest.mockReturnValue(
      Response.json({ error: "CROSS_ORIGIN_REQUEST" }, { status: 403 }),
    );
    const response = await POST(request({
      action: "access",
      clientRequestId: "ac1b8ec4-fdb1-42b8-b0b8-ee38959449a1",
      confirmationCode: "REG-PRIVATE",
      email: "guest@example.test",
    }));

    expect(response.status).toBe(403);
    expect(mocks.checkRegistrationCodeAccessRateLimit).not.toHaveBeenCalled();
    expect(mocks.checkRegistrationRecoveryRateLimit).not.toHaveBeenCalled();
  });
});
