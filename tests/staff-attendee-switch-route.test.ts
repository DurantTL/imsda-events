import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cookieGet: vi.fn(),
  cookieSet: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
  getCurrentSession: vi.fn(),
  findSwitchableAttendeeAccountForStaff: vi.fn(),
  createAttendeeSession: vi.fn(),
  revokeAttendeeSession: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: mocks.cookieGet,
    set: mocks.cookieSet,
  })),
}));
vi.mock("@/modules/access/request-security", () => ({
  rejectCrossOriginRequest: mocks.rejectCrossOriginRequest,
}));
vi.mock("@/modules/access/current-session", () => ({
  getCurrentSession: mocks.getCurrentSession,
}));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({
  findSwitchableAttendeeAccountForStaff: mocks.findSwitchableAttendeeAccountForStaff,
}));
vi.mock("@/modules/attendee-accounts/session-store", () => ({
  ATTENDEE_SESSION_COOKIE_NAME: "imsda_attendee_session",
  ATTENDEE_SESSION_LIFETIME_SECONDS: 1_209_600,
  createAttendeeSession: mocks.createAttendeeSession,
  revokeAttendeeSession: mocks.revokeAttendeeSession,
}));

import { POST } from "@/app/api/auth/switch-to-attendee/route";

function request(body?: unknown) {
  return new Request("https://events.imsda.test/api/auth/switch-to-attendee", {
    method: "POST",
    headers: {
      origin: "https://events.imsda.test",
      "user-agent": "switch-test",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.getCurrentSession.mockResolvedValue({
    user: {
      id: "staff-1",
      email: "same@example.test",
      displayName: "Same Person",
      globalRole: null,
    },
  });
  mocks.findSwitchableAttendeeAccountForStaff.mockResolvedValue({
    id: "attendee-account-1",
    verifiedEmail: "same@example.test",
    displayName: "Same Person",
  });
  mocks.cookieGet.mockReturnValue({ value: "prior-attendee-token" });
  mocks.createAttendeeSession.mockResolvedValue({
    token: "new-attendee-token",
    expiresAt: new Date("2026-08-13T14:00:00.000Z"),
  });
});

describe("staff attendee-account switch route", () => {
  it("creates a real attendee session only for the matching staff email", async () => {
    const response = await POST(request());

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://events.imsda.test/account");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.findSwitchableAttendeeAccountForStaff).toHaveBeenCalledWith(
      "same@example.test",
    );
    expect(mocks.revokeAttendeeSession).toHaveBeenCalledWith("prior-attendee-token");
    expect(mocks.createAttendeeSession).toHaveBeenCalledWith(
      "attendee-account-1",
      "switch-test",
    );
    expect(mocks.cookieSet).toHaveBeenCalledWith(
      "imsda_attendee_session",
      "new-attendee-token",
      expect.objectContaining({
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 1_209_600,
        priority: "high",
      }),
    );
  });

  it("requires an active staff session", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: null });

    const response = await POST(request());

    expect(response.status).toBe(401);
    expect(mocks.findSwitchableAttendeeAccountForStaff).not.toHaveBeenCalled();
    expect(mocks.createAttendeeSession).not.toHaveBeenCalled();
  });

  it("does not accept an attendee account id from the browser", async () => {
    const response = await POST(request({ attendeeAccountId: "attendee-account-other" }));

    expect(response.status).toBe(303);
    expect(mocks.findSwitchableAttendeeAccountForStaff).toHaveBeenCalledWith(
      "same@example.test",
    );
    expect(mocks.createAttendeeSession).toHaveBeenCalledWith(
      "attendee-account-1",
      "switch-test",
    );
    expect(mocks.createAttendeeSession).not.toHaveBeenCalledWith(
      "attendee-account-other",
      expect.anything(),
    );
  });

  it("refuses the switch when no active verified account matches", async () => {
    mocks.findSwitchableAttendeeAccountForStaff.mockResolvedValue(null);

    const response = await POST(request());

    expect(response.status).toBe(404);
    expect(mocks.createAttendeeSession).not.toHaveBeenCalled();
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it("rejects cross-origin requests before resolving either identity", async () => {
    mocks.rejectCrossOriginRequest.mockReturnValue(
      Response.json({ error: "INVALID_REQUEST_ORIGIN" }, { status: 403 }),
    );

    const response = await POST(request());

    expect(response.status).toBe(403);
    expect(mocks.getCurrentSession).not.toHaveBeenCalled();
    expect(mocks.findSwitchableAttendeeAccountForStaff).not.toHaveBeenCalled();
  });
});
