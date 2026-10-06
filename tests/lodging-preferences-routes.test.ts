import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Lodging preference routes (#199): staff routes check the permission for the event in the URL on the server,
 * accessibility flags go only to staff who hold VIEW_SENSITIVE_DATA, and the registrant routes work only through a
 * valid private registration link, never exposing another registration. The service is stubbed; sessions,
 * memberships and tokens are synthetic.
 */
const mocks = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  findActiveMembership: vi.fn(),
  getStaffLodgingRequestsView: vi.fn(),
  acknowledgeReviewItem: vi.fn(),
  saveLodgingRequest: vi.fn(),
  updateLodgingSettings: vi.fn(),
  decideRoommateRequest: vi.fn(),
  createLodgingRule: vi.fn(),
  endLodgingRule: vi.fn(),
  getLodgingRequestExportRows: vi.fn(),
  getRegistrantLodgingView: vi.fn(),
  changeRegistrantRoommates: vi.fn(),
  authorizeRegistrationAccessToken: vi.fn(),
  checkPublicManageRateLimit: vi.fn(),
  checkPublicRoommateLookupRateLimit: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: () => null }));
vi.mock("@/modules/events/repository", () => ({ findActiveMembership: mocks.findActiveMembership }));
vi.mock("@/modules/lodging/preferences-service", () => ({
  getStaffLodgingRequestsView: mocks.getStaffLodgingRequestsView,
  acknowledgeReviewItem: mocks.acknowledgeReviewItem,
  saveLodgingRequest: mocks.saveLodgingRequest,
  updateLodgingSettings: mocks.updateLodgingSettings,
  decideRoommateRequest: mocks.decideRoommateRequest,
  createLodgingRule: mocks.createLodgingRule,
  endLodgingRule: mocks.endLodgingRule,
  getLodgingRequestExportRows: mocks.getLodgingRequestExportRows,
  getRegistrantLodgingView: mocks.getRegistrantLodgingView,
  changeRegistrantRoommates: mocks.changeRegistrantRoommates,
}));
vi.mock("@/modules/public-access/repository", () => ({ authorizeRegistrationAccessToken: mocks.authorizeRegistrationAccessToken }));
vi.mock("@/modules/rate-limit/service", () => ({ checkPublicManageRateLimit: mocks.checkPublicManageRateLimit, checkPublicRoommateLookupRateLimit: mocks.checkPublicRoommateLookupRateLimit }));

import { GET as requestsGet, POST as requestsPost } from "@/app/api/events/[eventId]/lodging/requests/route";
import { PUT as requestPut } from "@/app/api/events/[eventId]/lodging/requests/[registrationId]/route";
import { PATCH as settingsPatch } from "@/app/api/events/[eventId]/lodging/settings/route";
import { POST as roommatesPost } from "@/app/api/events/[eventId]/lodging/roommates/route";
import { POST as rulesPost } from "@/app/api/events/[eventId]/lodging/rules/route";
import { GET as exportGet } from "@/app/api/events/[eventId]/exports/lodging-requests/route";
import { GET as publicGet, PUT as publicPut } from "@/app/api/public/manage/[token]/lodging/route";
import { POST as publicRoommates } from "@/app/api/public/manage/[token]/lodging/roommates/route";
import { LodgingError } from "@/modules/lodging/errors";

const user = { id: "usr_synthetic", email: "staff@imsda-events.test", displayName: "Synthetic Staff", globalRole: null };
const membership = (role: string, permissions: string[] = []) => ({ eventId: "ev1", userId: user.id, role, status: "ACTIVE", permissions });
const origin = "https://events.imsda.test";
const request = (method: string, body: unknown = {}) => new Request(`${origin}/api/x`, { method, headers: { "content-type": "application/json", origin }, body: method === "GET" ? undefined : JSON.stringify(body) });
const eventParams = { eventId: "ev1" };
const tokenParams = { token: "synthetic-token" };

const staffRoutes: Array<{ name: string; call: () => Promise<Response>; permission: "MANAGE_REGISTRATION" | "CONFIGURE_EVENT" | "VIEW_REPORTS" }> = [
  { name: "view", call: () => requestsGet(request("GET"), { params: Promise.resolve(eventParams) }), permission: "MANAGE_REGISTRATION" },
  { name: "acknowledge", call: () => requestsPost(request("POST", { action: "acknowledge" }), { params: Promise.resolve(eventParams) }), permission: "MANAGE_REGISTRATION" },
  { name: "staff edit", call: () => requestPut(request("PUT", {}), { params: Promise.resolve({ ...eventParams, registrationId: "reg1" }) }), permission: "MANAGE_REGISTRATION" },
  { name: "roommate decision", call: () => roommatesPost(request("POST", {}), { params: Promise.resolve(eventParams) }), permission: "MANAGE_REGISTRATION" },
  { name: "rules", call: () => rulesPost(request("POST", { action: "end", ruleId: "r1", reason: "Resolved" }), { params: Promise.resolve(eventParams) }), permission: "MANAGE_REGISTRATION" },
  { name: "settings", call: () => settingsPatch(request("PATCH", { fullBehavior: "WAITLIST" }), { params: Promise.resolve(eventParams) }), permission: "CONFIGURE_EVENT" },
  { name: "export", call: () => exportGet(request("GET"), { params: Promise.resolve(eventParams) }), permission: "VIEW_REPORTS" },
];

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getStaffLodgingRequestsView.mockResolvedValue({ eventId: "ev1" });
  mocks.acknowledgeReviewItem.mockResolvedValue({});
  mocks.saveLodgingRequest.mockResolvedValue({ requestId: "q1", version: 2, changed: true, afterDeadline: false });
  mocks.updateLodgingSettings.mockResolvedValue({});
  mocks.decideRoommateRequest.mockResolvedValue({});
  mocks.createLodgingRule.mockResolvedValue({ id: "r1" });
  mocks.endLodgingRule.mockResolvedValue({ id: "r1" });
  mocks.getLodgingRequestExportRows.mockResolvedValue([{
    confirmationCode: "REG-1", category: "TENT", firstNight: null, lastNight: null, partySize: 2, privateRoomRequested: false,
    householdPreference: "TOGETHER", mutualRoommates: 0, waitingRoommates: 1, updatedAt: "2027-02-01T00:00:00.000Z",
    groundFloorNeeded: true, accessibleRoomNeeded: true,
  }]);
  mocks.getRegistrantLodgingView.mockResolvedValue({ enabled: true });
  mocks.changeRegistrantRoommates.mockResolvedValue({ id: "rm1", created: true });
  mocks.authorizeRegistrationAccessToken.mockResolvedValue({ accessTokenId: "tok1", registrationId: "reg1", eventId: "ev1", registrationStatus: "CONFIRMED", attendeeEditPolicy: "VERIFY_EVERY_EDIT" });
  mocks.checkPublicManageRateLimit.mockResolvedValue({ allowed: true, decisions: [] });
  mocks.checkPublicRoommateLookupRateLimit.mockResolvedValue({ allowed: true, decisions: [] });
});

describe("staff lodging request routes", () => {
  for (const route of staffRoutes) {
    it(`${route.name}: refuses a signed-out request`, async () => {
      mocks.getCurrentSession.mockResolvedValue({ user: null });
      expect((await route.call()).status).toBe(401);
    });

    it(`${route.name}: refuses a person who is not on the event`, async () => {
      mocks.getCurrentSession.mockResolvedValue({ user });
      mocks.findActiveMembership.mockResolvedValue(null);
      expect((await route.call()).status).toBe(403);
    });

    it(`${route.name}: refuses read-only staff`, async () => {
      mocks.getCurrentSession.mockResolvedValue({ user });
      mocks.findActiveMembership.mockResolvedValue(membership("READ_ONLY_STAFF"));
      expect((await route.call()).status).toBe(403);
    });
  }

  it("lets an event administrator use every route", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user });
    mocks.findActiveMembership.mockResolvedValue(membership("EVENT_ADMIN"));
    for (const route of staffRoutes) expect((await route.call()).status, route.name).toBeLessThan(300);
  });

  it("opens requests to registration managers, but leaves settings to event setup", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user });
    mocks.findActiveMembership.mockResolvedValue(membership("REGISTRATION_MANAGER"));
    for (const route of staffRoutes.filter((entry) => entry.permission !== "CONFIGURE_EVENT")) expect((await route.call()).status, route.name).toBeLessThan(300);
    expect((await staffRoutes.find((entry) => entry.name === "settings")!.call()).status).toBe(403);
    expect(mocks.updateLodgingSettings).not.toHaveBeenCalled();
  });

  it("does not let finance staff, who lack registration management, into the requests", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user });
    mocks.findActiveMembership.mockResolvedValue(membership("FINANCE_MANAGER"));
    expect((await staffRoutes[0]!.call()).status).toBe(403);
    expect(mocks.getStaffLodgingRequestsView).not.toHaveBeenCalled();
  });

  it("tells the service whether the caller may read accessibility flags", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user });
    mocks.findActiveMembership.mockResolvedValue(membership("READ_ONLY_STAFF", ["MANAGE_REGISTRATION"]));
    await requestsGet(request("GET"), { params: Promise.resolve(eventParams) });
    expect(mocks.getStaffLodgingRequestsView).toHaveBeenLastCalledWith("ev1", { canSeeSensitive: false });
    await requestPut(request("PUT", { category: "TENT", reason: "Phone call" }), { params: Promise.resolve({ ...eventParams, registrationId: "reg1" }) });
    expect(mocks.saveLodgingRequest.mock.calls.at(-1)![0].actor).toEqual({ kind: "STAFF", userId: user.id, canSeeSensitive: false });
    mocks.findActiveMembership.mockResolvedValue(membership("REGISTRATION_MANAGER"));
    await requestsGet(request("GET"), { params: Promise.resolve(eventParams) });
    expect(mocks.getStaffLodgingRequestsView).toHaveBeenLastCalledWith("ev1", { canSeeSensitive: true });
  });

  it("answers a lodging refusal with its status and code", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user });
    mocks.findActiveMembership.mockResolvedValue(membership("EVENT_ADMIN"));
    mocks.saveLodgingRequest.mockRejectedValue(new LodgingError("SENSITIVE_DATA_FORBIDDEN", "No."));
    const response = await requestPut(request("PUT", {}), { params: Promise.resolve({ ...eventParams, registrationId: "reg1" }) });
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("SENSITIVE_DATA_FORBIDDEN");
  });

  it("turns a bad rule body into a 400 and never reaches the service", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user });
    mocks.findActiveMembership.mockResolvedValue(membership("EVENT_ADMIN"));
    const response = await rulesPost(request("POST", { action: "create", rule: { kind: "SEPARATE", personAId: "a", reason: "x" } }), { params: Promise.resolve(eventParams) });
    expect(response.status).toBe(400);
    expect(mocks.createLodgingRule).not.toHaveBeenCalled();
  });
});

describe("the settings route", () => {
  it("returns only the result to someone who cannot manage registrations", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user });
    mocks.findActiveMembership.mockResolvedValue(membership("READ_ONLY_STAFF", ["CONFIGURE_EVENT"]));
    const response = await settingsPatch(request("PATCH", { fullBehavior: "WAITLIST" }), { params: Promise.resolve(eventParams) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body)).toEqual(["result"]);
    expect(mocks.getStaffLodgingRequestsView).not.toHaveBeenCalled();
  });

  it("adds the staff view only when the caller also manages registrations", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user });
    mocks.findActiveMembership.mockResolvedValue(membership("EVENT_ADMIN"));
    const body = await (await settingsPatch(request("PATCH", { fullBehavior: "WAITLIST" }), { params: Promise.resolve(eventParams) })).json();
    expect(body.requests).toBeDefined();
  });
});

describe("the lodging request export", () => {
  it("holds accessibility columns only for staff with VIEW_SENSITIVE_DATA", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user });
    mocks.findActiveMembership.mockResolvedValue(membership("READ_ONLY_STAFF", ["VIEW_REPORTS"]));
    const plain = await (await exportGet(request("GET"), { params: Promise.resolve(eventParams) })).text();
    expect(plain).toContain("REG-1");
    expect(plain).not.toMatch(/ground floor|accessible/i);
    mocks.findActiveMembership.mockResolvedValue(membership("EVENT_ADMIN"));
    const restricted = await (await exportGet(request("GET"), { params: Promise.resolve(eventParams) })).text();
    expect(restricted).toMatch(/Ground floor needed/);
  });

  it("is a private, uncached download", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user });
    mocks.findActiveMembership.mockResolvedValue(membership("EVENT_ADMIN"));
    const response = await exportGet(request("GET"), { params: Promise.resolve(eventParams) });
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Content-Disposition")).toContain("lodging-requests.csv");
  });
});

describe("registrant lodging routes", () => {
  it("answers 404 for an invalid or expired link, without touching the service", async () => {
    mocks.authorizeRegistrationAccessToken.mockResolvedValue(null);
    expect((await publicGet(request("GET"), { params: Promise.resolve(tokenParams) })).status).toBe(404);
    expect((await publicPut(request("PUT", { category: "TENT" }), { params: Promise.resolve(tokenParams) })).status).toBe(404);
    expect((await publicRoommates(request("POST", { action: "withdraw", requestId: "x" }), { params: Promise.resolve(tokenParams) })).status).toBe(404);
    expect(mocks.saveLodgingRequest).not.toHaveBeenCalled();
    expect(mocks.changeRegistrantRoommates).not.toHaveBeenCalled();
  });

  it("puts the view on the read budget and refuses when it is spent", async () => {
    await publicGet(request("GET"), { params: Promise.resolve(tokenParams) });
    expect(mocks.checkPublicManageRateLimit).toHaveBeenLastCalledWith(expect.anything(), "synthetic-token", "read");
    mocks.checkPublicManageRateLimit.mockResolvedValue({ allowed: false, decisions: [{ allowed: false, limit: 120, remaining: 0, windowSeconds: 900, resetAfterSeconds: 30 }] });
    expect((await publicGet(request("GET"), { params: Promise.resolve(tokenParams) })).status).toBe(429);
    expect(mocks.getRegistrantLodgingView).toHaveBeenCalledTimes(1);
  });

  it("gives a roommate lookup by name and code its own, tighter budget", async () => {
    mocks.checkPublicRoommateLookupRateLimit.mockResolvedValue({ allowed: false, decisions: [{ allowed: false, limit: 5, remaining: 0, windowSeconds: 900, resetAfterSeconds: 60 }] });
    const lookup = await publicRoommates(request("POST", { action: "add_by_code", name: "Pat Example", confirmationCode: "REG-ABCDEF123456" }), { params: Promise.resolve(tokenParams) });
    expect(lookup.status).toBe(429);
    expect(mocks.changeRegistrantRoommates).not.toHaveBeenCalled();
    // Withdrawing a request is not a lookup and does not spend that budget.
    const withdraw = await publicRoommates(request("POST", { action: "withdraw", requestId: "x" }), { params: Promise.resolve(tokenParams) });
    expect(withdraw.status).toBe(200);
    expect(mocks.checkPublicRoommateLookupRateLimit).toHaveBeenCalledTimes(1);
  });

  it("refuses an event that verifies every edit, and a registrant changing their flags, with their own codes", async () => {
    mocks.saveLodgingRequest.mockRejectedValueOnce(new LodgingError("EDIT_POLICY_REQUIRES_VERIFICATION", "This event requires verification before this change. To change this, contact the event team."));
    const verify = await publicPut(request("PUT", { category: "TENT" }), { params: Promise.resolve(tokenParams) });
    expect(verify.status).toBe(403);
    expect((await verify.json()).error).toBe("EDIT_POLICY_REQUIRES_VERIFICATION");
    mocks.saveLodgingRequest.mockRejectedValueOnce(new LodgingError("FLAGS_STAFF_ONLY", "Contact the event team."));
    const flags = await publicPut(request("PUT", { category: "TENT", groundFloorNeeded: false }), { params: Promise.resolve(tokenParams) });
    expect(flags.status).toBe(403);
    expect((await flags.json()).error).toBe("FLAGS_STAFF_ONLY");
    mocks.changeRegistrantRoommates.mockRejectedValueOnce(new LodgingError("EDIT_POLICY_REQUIRES_VERIFICATION", "Contact the event team."));
    expect((await publicRoommates(request("POST", { action: "withdraw", requestId: "x" }), { params: Promise.resolve(tokenParams) })).status).toBe(403);
  });

  it("takes the registration from the link, never from the body", async () => {
    const response = await publicPut(request("PUT", { category: "TENT", registrationId: "someone-else" }), { params: Promise.resolve(tokenParams) });
    expect(response.status).toBe(200);
    expect(mocks.saveLodgingRequest.mock.calls[0]![0]).toMatchObject({ eventId: "ev1", registrationId: "reg1", actor: { kind: "REGISTRANT", accessTokenId: "tok1" } });
    // The stray registration id is passed on as part of the body for the strict schema to refuse.
    expect(mocks.saveLodgingRequest.mock.calls[0]![0].raw).toMatchObject({ registrationId: "someone-else" });
  });

  it("is rate limited per link and private", async () => {
    mocks.checkPublicManageRateLimit.mockResolvedValue({ allowed: false, decisions: [{ allowed: false, limit: 10, remaining: 0, windowSeconds: 60, resetAfterSeconds: 30 }] });
    const limited = await publicRoommates(request("POST", { action: "withdraw", requestId: "x" }), { params: Promise.resolve(tokenParams) });
    expect(limited.status).toBe(429);
    expect(mocks.changeRegistrantRoommates).not.toHaveBeenCalled();
    mocks.checkPublicManageRateLimit.mockResolvedValue({ allowed: true, decisions: [] });
    const ok = await publicRoommates(request("POST", { action: "add_by_code", name: "Pat Example", confirmationCode: "REG-ABCDEF123456" }), { params: Promise.resolve(tokenParams) });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Cache-Control")).toContain("no-store");
  });

  it("refuses an oversized body", async () => {
    const big = await publicPut(request("PUT", { category: "TENT", pad: "x".repeat(6_000) }), { params: Promise.resolve(tokenParams) });
    expect(big.status).toBe(413);
    expect(mocks.saveLodgingRequest).not.toHaveBeenCalled();
  });

  it("gives a missed roommate lookup the same answer whatever was wrong", async () => {
    mocks.changeRegistrantRoommates.mockRejectedValue(new LodgingError("ROOMMATE_NOT_FOUND", "We could not find a registration with that name and confirmation code. Check both and try again."));
    const wrongCode = await publicRoommates(request("POST", { action: "add_by_code", name: "Pat Example", confirmationCode: "REG-NOSUCHCODE" }), { params: Promise.resolve(tokenParams) });
    const wrongName = await publicRoommates(request("POST", { action: "add_by_code", name: "Nobody Here", confirmationCode: "REG-ABCDEF123456" }), { params: Promise.resolve(tokenParams) });
    expect(wrongCode.status).toBe(404);
    expect(await wrongCode.json()).toEqual(await wrongName.json());
  });
});
