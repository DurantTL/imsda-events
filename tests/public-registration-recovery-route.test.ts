import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
  processQueuedMessageIdsAfterCommit: vi.fn(),
  requestRegistrationAccessRecovery: vi.fn(),
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
  requestRegistrationAccessRecovery: mocks.requestRegistrationAccessRecovery,
}));
vi.mock("@/modules/rate-limit/service", () => ({
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
  mocks.checkRegistrationRecoveryRateLimit.mockResolvedValue(outcome(true));
  mocks.requestRegistrationAccessRecovery.mockResolvedValue({
    pendingMessageIds: [],
  });
});

describe("public registration recovery route", () => {
  it("returns the same noindex response whether or not a matching email was queued", async () => {
    const input = {
      confirmationCode: "REG-PRIVATE",
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
  });

  it("rate limits before attempting a registration lookup", async () => {
    mocks.checkRegistrationRecoveryRateLimit.mockResolvedValue(outcome(false));
    const response = await POST(request({
      confirmationCode: "REG-PRIVATE",
      email: "guest@example.test",
    }));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("900");
    expect(mocks.requestRegistrationAccessRecovery).not.toHaveBeenCalled();
  });

  it("rejects cross-origin requests before parsing registration details", async () => {
    mocks.rejectCrossOriginRequest.mockReturnValue(
      Response.json({ error: "CROSS_ORIGIN_REQUEST" }, { status: 403 }),
    );
    const response = await POST(request({
      confirmationCode: "REG-PRIVATE",
      email: "guest@example.test",
    }));

    expect(response.status).toBe(403);
    expect(mocks.checkRegistrationRecoveryRateLimit).not.toHaveBeenCalled();
  });
});
