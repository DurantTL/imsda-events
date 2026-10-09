import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => {
  class MockAccessDeniedError extends Error {
    constructor(message: string, public readonly status = 403, public readonly code = "PERMISSION_DENIED") {
      super(message);
    }
  }
  return {
    AccessDeniedError: MockAccessDeniedError,
    recordAnnouncementOptOut: vi.fn(),
    removeAnnouncementOptOuts: vi.fn(),
    requirePermission: vi.fn(),
    getCurrentSession: vi.fn(),
    rejectCrossOriginRequest: vi.fn(),
    setAnnouncementEssential: vi.fn(),
  };
});

vi.mock("@/modules/communications/email-preferences-repository", () => ({
  recordAnnouncementOptOut: mocks.recordAnnouncementOptOut,
  removeAnnouncementOptOuts: mocks.removeAnnouncementOptOuts,
}));
vi.mock("@/modules/access/authorization", () => ({
  AccessDeniedError: mocks.AccessDeniedError,
  requirePermission: mocks.requirePermission,
}));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/events/repository", () => ({ findActiveMembership: vi.fn() }));
vi.mock("@/modules/communications/announcement-essential", () => ({ setAnnouncementEssential: mocks.setAnnouncementEssential }));

import { GET, POST } from "@/app/api/public/unsubscribe/[token]/route";
import { PATCH } from "@/app/api/events/[eventId]/announcements/[announcementId]/essential/route";
import { createUnsubscribeToken } from "@/modules/communications/email-preferences";

const token = createUnsubscribeToken({ email: "avery@example.test", eventId: "event-1" });
const context = (value = token) => ({ params: Promise.resolve({ token: value }) });

function post(body: string, value = token, headers: Record<string, string> = {}) {
  return POST(
    new Request(`https://events.imsda.test/api/public/unsubscribe/${value}`, {
      method: "POST",
      // No Origin, no cookie, no CSRF token: a mail client's one-click POST carries none.
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body,
    }),
    context(value),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.recordAnnouncementOptOut.mockResolvedValue({ recorded: true, id: "optout-1" });
  mocks.removeAnnouncementOptOuts.mockResolvedValue({ removedCount: 1 });
});

describe("public unsubscribe endpoint (#838)", () => {
  it("accepts the RFC 8058 one-click POST with no login or CSRF token, for the signed address only", async () => {
    const response = await post("List-Unsubscribe=One-Click");
    expect(response.status).toBe(200);
    expect(mocks.recordAnnouncementOptOut).toHaveBeenCalledWith({
      email: "avery@example.test",
      eventId: "event-1",
      scope: "EVENT",
      source: "ONE_CLICK",
    });
    expect(mocks.rejectCrossOriginRequest).not.toHaveBeenCalled();
    expect(mocks.getCurrentSession).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toMatch(/no-store/);
  });

  it("refuses an altered or unknown token without touching anything", async () => {
    const [version, payload, signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ e: "someone-else@example.test", v: "event-1" })).toString("base64url");
    for (const bad of [`${version}.${forged}.${signature}`, `${token}x`, "garbage", `${version}.${payload}.`]) {
      const response = await post("List-Unsubscribe=One-Click", bad);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not found");
    }
    expect(mocks.recordAnnouncementOptOut).not.toHaveBeenCalled();
    expect(mocks.removeAnnouncementOptOuts).not.toHaveBeenCalled();
  });

  it("refuses a POST that is neither one-click nor a page choice", async () => {
    expect((await post("")).status).toBe(400);
    expect((await post("List-Unsubscribe=Something")).status).toBe(400);
    expect((await post("action=delete")).status).toBe(400);
    expect(mocks.recordAnnouncementOptOut).not.toHaveBeenCalled();
  });

  it("opts out of this event or of all announcements from the page, then returns to it", async () => {
    const event = await post("action=event");
    expect(event.status).toBe(303);
    expect(event.headers.get("location")).toBe(`/unsubscribe/${token}?done=event`);
    expect(mocks.recordAnnouncementOptOut).toHaveBeenLastCalledWith(expect.objectContaining({ scope: "EVENT", source: "UNSUBSCRIBE_PAGE" }));

    const all = await post("action=all");
    expect(all.headers.get("location")).toBe(`/unsubscribe/${token}?done=all`);
    expect(mocks.recordAnnouncementOptOut).toHaveBeenLastCalledWith(expect.objectContaining({ scope: "ALL", eventId: "event-1" }));
  });

  it("re-subscribes from the page", async () => {
    const response = await post("action=resubscribe");
    expect(response.headers.get("location")).toBe(`/unsubscribe/${token}?done=resubscribed`);
    expect(mocks.removeAnnouncementOptOuts).toHaveBeenCalledWith({ email: "avery@example.test", eventId: "event-1" });
  });

  it("never changes anything on a GET, which link scanners fetch; it sends the person to the page", async () => {
    const response = await GET(new Request(`https://events.imsda.test/api/public/unsubscribe/${token}`), context());
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/unsubscribe/${token}`);
    expect(mocks.recordAnnouncementOptOut).not.toHaveBeenCalled();
  });
});

describe("marking an announcement essential (#838)", () => {
  const params = { params: Promise.resolve({ eventId: "event-1", announcementId: "announcement-1" }) };
  const request = (body: unknown) => new Request("https://events.imsda.test/api/events/event-1/announcements/announcement-1/essential", {
    method: "PATCH",
    headers: { "content-type": "application/json", origin: "https://events.imsda.test" },
    body: JSON.stringify(body),
  });

  beforeEach(() => {
    mocks.rejectCrossOriginRequest.mockReturnValue(null);
    mocks.getCurrentSession.mockResolvedValue({ user: { id: "manager-1" } });
    mocks.requirePermission.mockResolvedValue({ user: { id: "manager-1" } });
    mocks.setAnnouncementEssential.mockResolvedValue({ id: "announcement-1", isEssential: true, changed: true });
  });

  it("requires event-manager access (CONFIGURE_EVENT), not just communications access", async () => {
    await PATCH(request({ essential: true }), params);
    expect(mocks.requirePermission).toHaveBeenCalledWith(expect.anything(), "event-1", "CONFIGURE_EVENT", expect.anything());
    expect(mocks.setAnnouncementEssential).toHaveBeenCalledWith("event-1", "announcement-1", "manager-1", true);
  });

  it("refuses someone without it, and changes nothing", async () => {
    mocks.requirePermission.mockRejectedValue(new mocks.AccessDeniedError("Your event role cannot do this."));
    const response = await PATCH(request({ essential: true }), params);
    expect(response.status).toBe(403);
    expect(mocks.setAnnouncementEssential).not.toHaveBeenCalled();
  });

  it("rejects a malformed body and an unknown announcement", async () => {
    expect((await PATCH(request({ essential: "yes" }), params)).status).toBe(400);
    mocks.setAnnouncementEssential.mockResolvedValue(null);
    expect((await PATCH(request({ essential: true }), params)).status).toBe(404);
  });
});
