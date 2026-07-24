import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
  setGlobalRole: vi.fn(),
}));

vi.mock("@/modules/access/current-session", () => ({
  getCurrentSession: mocks.getCurrentSession,
}));
vi.mock("@/modules/access/request-security", () => ({
  rejectCrossOriginRequest: mocks.rejectCrossOriginRequest,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/membership-repository", async () => {
  const actual = await vi.importActual<
    typeof import("@/modules/access/membership-repository")
  >("@/modules/access/membership-repository");
  return { MembershipOperationError: actual.MembershipOperationError, setGlobalRole: mocks.setGlobalRole };
});

import { PATCH } from "@/app/api/users/[userId]/global-role/route";
import { MembershipOperationError } from "@/modules/access/membership-repository";

function patchRequest(body: unknown) {
  return new Request("https://events.imsda.test/api/users/user-2/global-role", {
    method: "PATCH",
    headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const params = Promise.resolve({ userId: "user-2" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.getCurrentSession.mockResolvedValue({
    user: { id: "user-1", email: "sys@imsda.org", displayName: "Sys", globalRole: "SYSTEM_ADMIN" },
  });
  mocks.setGlobalRole.mockResolvedValue({
    id: "user-2",
    email: "ops@imsda.org",
    displayName: "Ops",
    globalRole: "SYSTEM_ADMIN",
  });
});

describe("global role route", () => {
  it("lets a system administrator grant SYSTEM_ADMIN", async () => {
    const response = await PATCH(patchRequest({ globalRole: "SYSTEM_ADMIN" }), { params });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      user: { globalRole: "SYSTEM_ADMIN" },
    });
    expect(mocks.setGlobalRole).toHaveBeenCalledWith("user-2", "user-1", "SYSTEM_ADMIN", undefined);
  });

  it("passes the event through so the change is audited against it", async () => {
    await PATCH(patchRequest({ globalRole: null, eventId: "evt_wr26" }), { params });

    expect(mocks.setGlobalRole).toHaveBeenCalledWith("user-2", "user-1", null, "evt_wr26");
  });

  it("refuses an event administrator who is not a system administrator", async () => {
    mocks.getCurrentSession.mockResolvedValue({
      user: { id: "user-3", email: "admin@imsda.org", displayName: "Admin", globalRole: null },
    });

    const response = await PATCH(patchRequest({ globalRole: "SYSTEM_ADMIN" }), { params });

    expect(response.status).toBe(403);
    expect(mocks.setGlobalRole).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated request", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: null });

    expect((await PATCH(patchRequest({ globalRole: null }), { params })).status).toBe(401);
    expect(mocks.setGlobalRole).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin request before reading the body", async () => {
    mocks.rejectCrossOriginRequest.mockReturnValue(
      Response.json({ error: "INVALID_REQUEST_ORIGIN" }, { status: 403 }),
    );

    expect((await PATCH(patchRequest({ globalRole: null }), { params })).status).toBe(403);
    expect(mocks.getCurrentSession).not.toHaveBeenCalled();
  });

  it("rejects a role that is neither SYSTEM_ADMIN nor null", async () => {
    const response = await PATCH(patchRequest({ globalRole: "EVENT_ADMIN" }), { params });

    expect(response.status).toBe(400);
    expect(mocks.setGlobalRole).not.toHaveBeenCalled();
  });

  it("reports the last-system-administrator guard as a conflict", async () => {
    mocks.setGlobalRole.mockRejectedValue(
      new MembershipOperationError("LAST_SYSTEM_ADMIN", "Grant another account first."),
    );

    const response = await PATCH(patchRequest({ globalRole: null }), { params });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "LAST_SYSTEM_ADMIN" });
  });

  it("reports a missing account as 404", async () => {
    mocks.setGlobalRole.mockRejectedValue(
      new MembershipOperationError("USER_NOT_FOUND", "That account no longer exists."),
    );

    expect((await PATCH(patchRequest({ globalRole: null }), { params })).status).toBe(404);
  });
});
