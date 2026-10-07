import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockAccessDeniedError extends Error {
    constructor(
      public readonly code: string,
      public readonly status: 401 | 403,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    AccessDeniedError: MockAccessDeniedError,
    requirePermission: vi.fn(),
    getCurrentSessionPassive: vi.fn(),
    findActiveMembership: vi.fn(),
    listCheckInChanges: vi.fn(),
  };
});

vi.mock("@/modules/access/authorization", () => ({
  AccessDeniedError: mocks.AccessDeniedError,
  requirePermission: mocks.requirePermission,
}));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSessionPassive: mocks.getCurrentSessionPassive }));
vi.mock("@/modules/events/repository", () => ({ findActiveMembership: mocks.findActiveMembership }));
vi.mock("@/modules/checkin/live-repository", () => ({ listCheckInChanges: mocks.listCheckInChanges }));

import { GET } from "@/app/api/events/[eventId]/check-ins/route";

const context = { params: Promise.resolve({ eventId: "event_123" }) };
const get = (query: string) => GET(new Request(`https://events.imsda.test/api/events/event_123/check-ins${query}`), context);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentSessionPassive.mockResolvedValue({ user: { id: "staff_1" } });
  mocks.requirePermission.mockResolvedValue({ user: { id: "staff_1" } });
  mocks.listCheckInChanges.mockResolvedValue({ now: "2026-10-09T14:00:00.000Z", changes: [["a", null]] });
});

describe("live check-in changes route (#825)", () => {
  it("needs the check-in permission for the event", async () => {
    const response = await get("?since=2026-10-09T13:59:00.000Z");
    expect(response.status).toBe(200);
    expect(mocks.requirePermission).toHaveBeenCalledWith(expect.anything(), "event_123", "MANAGE_CHECK_IN", mocks.findActiveMembership);
    expect(await response.json()).toEqual({ now: "2026-10-09T14:00:00.000Z", changes: [["a", null]] });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("refuses a caller without access, before reading anything", async () => {
    mocks.requirePermission.mockRejectedValue(new mocks.AccessDeniedError("FORBIDDEN", 403, "No."));
    const response = await get("?since=2026-10-09T13:59:00.000Z");
    expect(response.status).toBe(403);
    expect(mocks.listCheckInChanges).not.toHaveBeenCalled();
  });

  it("reads the session without advancing its idle clock, and answers 401 once it has gone idle", async () => {
    mocks.requirePermission.mockRejectedValue(new mocks.AccessDeniedError("UNAUTHENTICATED", 401, "Sign in."));
    const response = await get("?since=2026-10-09T13:59:00.000Z");
    expect(response.status).toBe(401);
    expect(mocks.getCurrentSessionPassive).toHaveBeenCalled();
    expect(mocks.listCheckInChanges).not.toHaveBeenCalled();
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("app/api/events/[eventId]/check-ins/route.ts", "utf8");
    expect(source).not.toMatch(/getCurrentSession\b/);
  });

  it("requires a valid since time", async () => {
    expect((await get("")).status).toBe(400);
    expect((await get("?since=yesterday")).status).toBe(400);
    expect(mocks.listCheckInChanges).not.toHaveBeenCalled();
  });

  it("never looks back further than a few hours", async () => {
    await get("?since=2020-01-01T00:00:00.000Z");
    const since = mocks.listCheckInChanges.mock.calls[0][1] as Date;
    expect(Date.now() - since.getTime()).toBeLessThanOrEqual(6 * 60 * 60 * 1000 + 1000);
  });

  it("answers a failure with a retryable 500, not a stack trace", async () => {
    mocks.listCheckInChanges.mockRejectedValue(new Error("db down"));
    const response = await get("?since=2026-10-09T13:59:00.000Z");
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("db down");
  });
});
