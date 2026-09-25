import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `POST /api/staff/last-event` and `readLastUsedEventId` (#108 queue 1). The
 * cookie is a sign-in hint written only for a signed-in staff member, from
 * the workspace origin, for a well-formed event they can open. Synthetic ids
 * only.
 */

const mocks = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  findActiveMembership: vi.fn(),
  cookieGet: vi.fn(),
  cookieSet: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: mocks.cookieGet, set: mocks.cookieSet })),
}));
vi.mock("@/modules/access/current-session", () => ({
  getCurrentSession: mocks.getCurrentSession,
}));
vi.mock("@/modules/events/repository", () => ({
  findActiveMembership: mocks.findActiveMembership,
}));

import { POST } from "@/app/api/staff/last-event/route";
import { readLastUsedEventId } from "@/modules/events/last-used-event";
import {
  LAST_USED_EVENT_COOKIE_MAX_AGE_SECONDS,
  LAST_USED_EVENT_COOKIE_NAME,
} from "@/modules/events/last-used-event-cookie";

const staff = { id: "usr_synthetic_staff", email: "staff@imsda-events.test", displayName: "Synthetic Staff", globalRole: null };
const admin = { ...staff, id: "usr_synthetic_admin", globalRole: "SYSTEM_ADMIN" as const };

function post(body: unknown, origin = "https://events.imsda.test") {
  return new Request("https://events.imsda.test/api/staff/last-event", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function activeMembership(eventId: string) {
  return { eventId, userId: staff.id, role: "READ_ONLY_STAFF", status: "ACTIVE", permissions: [] };
}

beforeEach(() => {
  mocks.getCurrentSession.mockResolvedValue({ user: staff });
  mocks.findActiveMembership.mockResolvedValue(null);
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("POST /api/staff/last-event", () => {
  it("rejects a signed-out request without setting a cookie", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: null });

    const response = await POST(post({ eventId: "evt_wr26" }));

    expect(response.status).toBe(401);
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin request before reading the session", async () => {
    const response = await POST(post({ eventId: "evt_wr26" }, "https://evil.example"));

    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("INVALID_REQUEST_ORIGIN");
    expect(mocks.getCurrentSession).not.toHaveBeenCalled();
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing id", {}],
    ["an id with a path separator", { eventId: "evt/../admin" }],
    ["an id with spaces", { eventId: "evt wr26" }],
    ["an overlong id", { eventId: "c".repeat(65) }],
    ["a non-string id", { eventId: 42 }],
    ["a body that is not JSON", "not json"],
  ])("rejects %s", async (_label, body) => {
    const response = await POST(post(body));

    expect(response.status).toBe(400);
    expect(mocks.findActiveMembership).not.toHaveBeenCalled();
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it("rejects an event the account has no active membership for", async () => {
    mocks.findActiveMembership.mockResolvedValue({ ...activeMembership("evt_cm27"), status: "INACTIVE" });

    const response = await POST(post({ eventId: "evt_cm27" }));

    expect(response.status).toBe(403);
    expect(mocks.findActiveMembership).toHaveBeenCalledWith(staff.id, "evt_cm27");
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it("sets the httpOnly lax cookie for an event with an active membership", async () => {
    mocks.findActiveMembership.mockResolvedValue(activeMembership("clx0synthetic0event0id0001"));

    const response = await POST(post({ eventId: "clx0synthetic0event0id0001" }));

    expect(response.status).toBe(200);
    expect(mocks.cookieSet).toHaveBeenCalledWith(
      LAST_USED_EVENT_COOKIE_NAME,
      "clx0synthetic0event0id0001",
      {
        httpOnly: true,
        secure: false,
        sameSite: "lax",
        path: "/",
        maxAge: LAST_USED_EVENT_COOKIE_MAX_AGE_SECONDS,
      },
    );
    expect(LAST_USED_EVENT_COOKIE_MAX_AGE_SECONDS).toBe(60 * 24 * 60 * 60);
  });

  it("accepts a system administrator without a membership lookup, and records nothing routing would ignore", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: admin });

    const response = await POST(post({ eventId: "evt_wr26" }));

    expect(response.status).toBe(200);
    expect(mocks.findActiveMembership).not.toHaveBeenCalled();
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });
});

describe("readLastUsedEventId", () => {
  it("returns a well-formed remembered id", async () => {
    mocks.cookieGet.mockReturnValue({ name: LAST_USED_EVENT_COOKIE_NAME, value: "evt_wr26" });

    await expect(readLastUsedEventId()).resolves.toBe("evt_wr26");
  });

  it("returns null when nothing is remembered", async () => {
    mocks.cookieGet.mockReturnValue(undefined);

    await expect(readLastUsedEventId()).resolves.toBeNull();
  });

  it.each([
    ["an empty value", ""],
    ["a path-like value", "../admin"],
    ["an encoded value", "evt%2Fwr26"],
    ["an overlong value", "c".repeat(500)],
  ])("ignores %s", async (_label, value) => {
    mocks.cookieGet.mockReturnValue({ name: LAST_USED_EVENT_COOKIE_NAME, value });

    await expect(readLastUsedEventId()).resolves.toBeNull();
  });
});
