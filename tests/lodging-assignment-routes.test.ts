import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Lodging assignment routes (#200): every staff route checks the permission for the event in the URL on the server;
 * publishing, notices and waitlist offers need MANAGE_REGISTRATION plus CONFIGURE_EVENT; exports need VIEW_REPORTS;
 * accessibility flags go only to staff holding VIEW_SENSITIVE_DATA; the registrant waitlist route works only through
 * a valid private link and can neither offer nor promote. The services are stubbed; sessions, memberships and tokens
 * are synthetic.
 */
const mocks = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  findActiveMembership: vi.fn(),
  applyAssignmentAction: vi.fn(),
  applyAssignmentPlan: vi.fn(),
  previewAssignmentPlan: vi.fn(),
  applyPlaceholderAction: vi.fn(),
  renameBucket: vi.fn(),
  updateAssignmentSettings: vi.fn(),
  getAssignmentWorkspace: vi.fn(),
  getRoomingReports: vi.fn(),
  getRegistrantAssignmentView: vi.fn(),
  sendRoomNotice: vi.fn(),
  applyWaitlistAction: vi.fn(),
  applyRegistrantWaitlistAction: vi.fn(),
  getRegistrantWaitlistView: vi.fn(),
  authorizeRegistrationAccessToken: vi.fn(),
  checkPublicManageRateLimit: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: () => null }));
vi.mock("@/modules/events/repository", () => ({ findActiveMembership: mocks.findActiveMembership }));
vi.mock("@/modules/lodging/assignment-service", () => ({
  applyAssignmentAction: mocks.applyAssignmentAction,
  applyAssignmentPlan: mocks.applyAssignmentPlan,
  previewAssignmentPlan: mocks.previewAssignmentPlan,
  applyPlaceholderAction: mocks.applyPlaceholderAction,
  renameBucket: mocks.renameBucket,
  updateAssignmentSettings: mocks.updateAssignmentSettings,
}));
vi.mock("@/modules/lodging/assignment-view", () => ({
  getAssignmentWorkspace: mocks.getAssignmentWorkspace,
  getRoomingReports: mocks.getRoomingReports,
  getRegistrantAssignmentView: mocks.getRegistrantAssignmentView,
}));
vi.mock("@/modules/lodging/notices", () => ({ sendRoomNotice: mocks.sendRoomNotice }));
vi.mock("@/modules/lodging/waitlist-service", () => ({
  applyWaitlistAction: mocks.applyWaitlistAction,
  applyRegistrantWaitlistAction: mocks.applyRegistrantWaitlistAction,
  getRegistrantWaitlistView: mocks.getRegistrantWaitlistView,
}));
vi.mock("@/modules/public-access/repository", () => ({ authorizeRegistrationAccessToken: mocks.authorizeRegistrationAccessToken }));
vi.mock("@/modules/rate-limit/service", () => ({ checkPublicManageRateLimit: mocks.checkPublicManageRateLimit }));

import { GET as assignmentsGet, POST as assignmentsPost } from "@/app/api/events/[eventId]/lodging/assignments/route";
import { POST as planPost } from "@/app/api/events/[eventId]/lodging/assignments/plan/route";
import { POST as placeholdersPost } from "@/app/api/events/[eventId]/lodging/assignments/placeholders/route";
import { PATCH as bucketsPatch } from "@/app/api/events/[eventId]/lodging/assignments/buckets/route";
import { PATCH as settingsPatch } from "@/app/api/events/[eventId]/lodging/assignments/settings/route";
import { POST as noticesPost } from "@/app/api/events/[eventId]/lodging/assignments/notices/route";
import { GET as reportsGet } from "@/app/api/events/[eventId]/lodging/assignments/reports/route";
import { POST as waitlistPost } from "@/app/api/events/[eventId]/lodging/waitlist/route";
import { GET as exportGet } from "@/app/api/events/[eventId]/exports/lodging-assignments/route";
import { GET as publicWaitlistGet, POST as publicWaitlistPost } from "@/app/api/public/manage/[token]/lodging/waitlist/route";
import { LodgingError } from "@/modules/lodging/errors";

const user = { id: "usr_synthetic", email: "staff@imsda-events.test", displayName: "Synthetic Staff", globalRole: null };
const membership = (role: string, permissions: string[] = []) => ({ eventId: "ev1", userId: user.id, role, status: "ACTIVE", permissions });
const origin = "https://events.imsda.test";
const request = (method: string, body: unknown = {}, url = `${origin}/api/x`) => new Request(url, { method, headers: { "content-type": "application/json", origin }, body: method === "GET" ? undefined : JSON.stringify(body) });
const params = { params: Promise.resolve({ eventId: "ev1" }) };
const tokenParams = { params: Promise.resolve({ token: "synthetic-token" }) };

type Needs = Array<"MANAGE_REGISTRATION" | "CONFIGURE_EVENT" | "VIEW_REPORTS">;
const staffRoutes: Array<{ name: string; call: () => Promise<Response>; needs: Needs; /** Any one of `needs` is enough. */ anyOf?: boolean }> = [
  { name: "workspace", call: () => assignmentsGet(request("GET"), params), needs: ["MANAGE_REGISTRATION"] },
  { name: "assignment action", call: () => assignmentsPost(request("POST", { action: "release_inactive", reason: "x" }), params), needs: ["MANAGE_REGISTRATION"] },
  { name: "proposal and import", call: () => planPost(request("POST", { mode: "preview", source: "PROPOSAL" }), params), needs: ["MANAGE_REGISTRATION"] },
  { name: "expected guests", call: () => placeholdersPost(request("POST", { action: "create", displayName: "Guest" }), params), needs: ["MANAGE_REGISTRATION"] },
  { name: "housing choices", call: () => bucketsPatch(request("PATCH", { bucketId: "b", label: "Hotel" }), params), needs: ["MANAGE_REGISTRATION"] },
  { name: "attendee display settings", call: () => settingsPatch(request("PATCH", { showAssignmentsToAttendees: true }), params), needs: ["MANAGE_REGISTRATION", "CONFIGURE_EVENT"] },
  { name: "room notice", call: () => noticesPost(request("POST", { registrationId: "reg1" }), params), needs: ["MANAGE_REGISTRATION", "CONFIGURE_EVENT"] },
  { name: "waitlist join", call: () => waitlistPost(request("POST", { action: "join" }), params), needs: ["MANAGE_REGISTRATION"] },
  { name: "waitlist offer", call: () => waitlistPost(request("POST", { action: "offer", entryIds: ["e1"] }), params), needs: ["MANAGE_REGISTRATION", "CONFIGURE_EVENT"] },
  { name: "waitlist promote", call: () => waitlistPost(request("POST", { action: "promote", entryId: "e1" }), params), needs: ["MANAGE_REGISTRATION", "CONFIGURE_EVENT"] },
  { name: "reports", call: () => reportsGet(request("GET"), params), needs: ["MANAGE_REGISTRATION", "VIEW_REPORTS"], anyOf: true },
  { name: "export", call: () => exportGet(request("GET", {}, `${origin}/api/x?report=assignments`), params), needs: ["VIEW_REPORTS"] },
];

const reportsFixture = (canSeeSensitive: boolean) => ({
  eventId: "ev1", nights: ["2027-06-15"], canSeeSensitive,
  rooming: [{ placeKey: "unit:boys-101", building: "Boys Dorm", place: "101", floor: 1, capacity: 2, occupants: [{ assignmentId: "a1", occupantId: "att1", kind: "Attendee", name: "Pat Example", registrationCode: "REG-1", firstNight: "2027-06-15", lastNight: "2027-06-15", people: 1, ...(canSeeSensitive ? { groundFloorNeeded: true, accessibleRoomNeeded: false } : {}) }] }],
  occupancy: [], occupancyByUnit: [], unassigned: [], conflicts: [], closeout: [], keyHandoff: [],
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.applyAssignmentAction.mockResolvedValue({ created: 0, released: 0 });
  mocks.applyAssignmentPlan.mockResolvedValue({ created: 0 });
  mocks.previewAssignmentPlan.mockResolvedValue({ fingerprint: "f".repeat(64) });
  mocks.applyPlaceholderAction.mockResolvedValue({ id: "p1" });
  mocks.renameBucket.mockResolvedValue({ id: "b" });
  mocks.updateAssignmentSettings.mockResolvedValue({});
  mocks.getAssignmentWorkspace.mockResolvedValue({ eventId: "ev1" });
  mocks.getRoomingReports.mockImplementation(async (_eventId: string, options: { canSeeSensitive: boolean }) => reportsFixture(options.canSeeSensitive));
  mocks.getRegistrantAssignmentView.mockResolvedValue({ published: false, instructions: null, stays: [] });
  mocks.sendRoomNotice.mockResolvedValue({ noticeId: "n1" });
  mocks.applyWaitlistAction.mockResolvedValue({ action: "join", entryId: "e1" });
  mocks.applyRegistrantWaitlistAction.mockResolvedValue({ entryId: "e1", status: "ACCEPTED", replay: false });
  mocks.getRegistrantWaitlistView.mockResolvedValue({ enabled: true, entry: null });
  mocks.authorizeRegistrationAccessToken.mockResolvedValue({ accessTokenId: "tok1", registrationId: "reg1", eventId: "ev1" });
  mocks.checkPublicManageRateLimit.mockResolvedValue({ allowed: true, decisions: [] });
});

describe("staff lodging assignment routes", () => {
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

    it(`${route.name}: needs ${route.needs.join(route.anyOf ? " or " : " and ")}`, async () => {
      mocks.getCurrentSession.mockResolvedValue({ user });
      for (const held of [["MANAGE_REGISTRATION"], ["CONFIGURE_EVENT"], ["VIEW_REPORTS"]] as const) {
        mocks.findActiveMembership.mockResolvedValue(membership("READ_ONLY_STAFF", [...held]));
        const allowed = route.anyOf ? route.needs.some((needed) => held.includes(needed as never)) : route.needs.every((needed) => held.includes(needed as never));
        const status = (await route.call()).status;
        expect(status < 300, `${route.name} with only ${held.join()} -> ${status}`).toBe(allowed);
      }
      mocks.findActiveMembership.mockResolvedValue(membership("READ_ONLY_STAFF", [...route.needs]));
      expect((await route.call()).status, `${route.name} with ${route.needs.join(" and ")}`).toBeLessThan(300);
    });
  }

  it("lets an event administrator use every route", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user });
    mocks.findActiveMembership.mockResolvedValue(membership("EVENT_ADMIN"));
    for (const route of staffRoutes) expect((await route.call()).status, route.name).toBeLessThan(300);
  });

  it("lets a registration manager place guests and answer the waitlist, but not publish, send notices or offer places", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user });
    mocks.findActiveMembership.mockResolvedValue(membership("REGISTRATION_MANAGER"));
    for (const route of staffRoutes) {
      const publishing = route.needs.includes("CONFIGURE_EVENT");
      expect((await route.call()).status < 300, route.name).toBe(!publishing);
    }
    expect(mocks.updateAssignmentSettings).not.toHaveBeenCalled();
    expect(mocks.sendRoomNotice).not.toHaveBeenCalled();
    expect(mocks.applyWaitlistAction.mock.calls.map((call) => call[2].action)).toEqual(["join"]);
  });

  it("keeps finance staff, who lack registration management, out of the workspace", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user });
    mocks.findActiveMembership.mockResolvedValue(membership("FINANCE_MANAGER"));
    expect((await staffRoutes[0]!.call()).status).toBe(403);
    expect(mocks.getAssignmentWorkspace).not.toHaveBeenCalled();
  });

  it("tells the services whether the caller may read accessibility flags", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user });
    mocks.findActiveMembership.mockResolvedValue(membership("READ_ONLY_STAFF", ["MANAGE_REGISTRATION"]));
    await assignmentsGet(request("GET"), params);
    expect(mocks.getAssignmentWorkspace).toHaveBeenLastCalledWith("ev1", { canSeeSensitive: false });
    await planPost(request("POST", { mode: "preview", source: "PROPOSAL" }), params);
    expect(mocks.previewAssignmentPlan).toHaveBeenLastCalledWith("ev1", expect.anything(), { canSeeSensitive: false });
    await reportsGet(request("GET"), params);
    expect(mocks.getRoomingReports).toHaveBeenLastCalledWith("ev1", { canSeeSensitive: false });
    mocks.findActiveMembership.mockResolvedValue(membership("REGISTRATION_MANAGER"));
    await assignmentsGet(request("GET"), params);
    expect(mocks.getAssignmentWorkspace).toHaveBeenLastCalledWith("ev1", { canSeeSensitive: true });
  });

  it("sends a plan to preview unless the body asks to apply, and applies only with the fingerprint", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user });
    mocks.findActiveMembership.mockResolvedValue(membership("EVENT_ADMIN"));
    await planPost(request("POST", { mode: "preview", source: "CSV_IMPORT", csv: "x" }), params);
    expect(mocks.previewAssignmentPlan).toHaveBeenCalledTimes(1);
    expect(mocks.applyAssignmentPlan).not.toHaveBeenCalled();
    await planPost(request("POST", { mode: "apply", source: "CSV_IMPORT", csv: "x", fingerprint: "f".repeat(64) }), params);
    expect(mocks.applyAssignmentPlan).toHaveBeenCalledTimes(1);
    expect(mocks.applyAssignmentPlan.mock.calls[0]![1]).toBe(user.id);
  });

  it("answers a lodging refusal with its status and code, and a bad body with a 400", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user });
    mocks.findActiveMembership.mockResolvedValue(membership("EVENT_ADMIN"));
    mocks.applyAssignmentAction.mockRejectedValue(new LodgingError("UNIT_FULL", "Room 101 has 0 places left."));
    const full = await assignmentsPost(request("POST", { action: "place" }), params);
    expect(full.status).toBe(409);
    expect((await full.json()).error).toBe("UNIT_FULL");
    mocks.applyAssignmentPlan.mockRejectedValue(new LodgingError("PLAN_CHANGED", "Preview again."));
    expect((await planPost(request("POST", { mode: "apply" }), params)).status).toBe(409);
    mocks.sendRoomNotice.mockRejectedValue(new LodgingError("NOT_PUBLISHED", "Publish first."));
    expect((await noticesPost(request("POST", { registrationId: "reg1" }), params)).status).toBe(409);
    expect((await noticesPost(request("POST", { registrationId: "reg1", everyone: true }), params)).status).toBe(400);
    mocks.applyWaitlistAction.mockRejectedValue(new LodgingError("WAITLIST_ENTRY_NOT_FOUND", "No."));
    expect((await waitlistPost(request("POST", { action: "remove" }), params)).status).toBe(404);
  });

  it("sends a room notice for one registration only", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user });
    mocks.findActiveMembership.mockResolvedValue(membership("EVENT_ADMIN"));
    await noticesPost(request("POST", { registrationId: "reg1" }), params);
    expect(mocks.sendRoomNotice).toHaveBeenCalledWith("ev1", user.id, "reg1");
    expect((await noticesPost(request("POST", { registrationIds: ["a", "b"] }), params)).status).toBe(400);
    expect(mocks.sendRoomNotice).toHaveBeenCalledTimes(1);
  });
});

describe("the lodging report export", () => {
  it("holds accessibility columns only for staff with VIEW_SENSITIVE_DATA", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user });
    mocks.findActiveMembership.mockResolvedValue(membership("READ_ONLY_STAFF", ["VIEW_REPORTS"]));
    const plain = await (await exportGet(request("GET", {}, `${origin}/api/x?report=assignments`), params)).text();
    expect(plain).toContain("REG-1");
    expect(plain).not.toMatch(/ground floor|accessible/i);
    mocks.findActiveMembership.mockResolvedValue(membership("EVENT_ADMIN"));
    const restricted = await (await exportGet(request("GET", {}, `${origin}/api/x?report=assignments`), params)).text();
    expect(restricted).toMatch(/Ground floor needed/);
  });

  it("is a private, uncached download named for its report, and refuses an unknown report", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user });
    mocks.findActiveMembership.mockResolvedValue(membership("EVENT_ADMIN"));
    const response = await exportGet(request("GET", {}, `${origin}/api/x?report=keys`), params);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Content-Disposition")).toContain("lodging-keys.csv");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const unknown = await exportGet(request("GET", {}, `${origin}/api/x?report=everything`), params);
    expect(unknown.status).toBe(400);
  });
});

describe("the reports route", () => {
  it("opens to staff with the reports permission alone, and still hides flags from them", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user });
    mocks.findActiveMembership.mockResolvedValue(membership("READ_ONLY_STAFF", ["VIEW_REPORTS"]));
    const response = await reportsGet(request("GET"), params);
    expect(response.status).toBe(200);
    expect(mocks.getRoomingReports).toHaveBeenLastCalledWith("ev1", { canSeeSensitive: false });
    expect(JSON.stringify(await response.json())).not.toContain("groundFloorNeeded");
  });
});

describe("registrant lodging waitlist route", () => {
  it("answers 404 for an invalid or expired link, without touching the service", async () => {
    mocks.authorizeRegistrationAccessToken.mockResolvedValue(null);
    expect((await publicWaitlistGet(request("GET"), tokenParams)).status).toBe(404);
    expect((await publicWaitlistPost(request("POST", { action: "accept" }), tokenParams)).status).toBe(404);
    expect(mocks.applyRegistrantWaitlistAction).not.toHaveBeenCalled();
  });

  it("is rate limited per link", async () => {
    mocks.checkPublicManageRateLimit.mockResolvedValue({ allowed: false, decisions: [{ allowed: false, limit: 10, remaining: 0, windowSeconds: 60, resetAfterSeconds: 30 }] });
    expect((await publicWaitlistPost(request("POST", { action: "accept" }), tokenParams)).status).toBe(429);
    expect((await publicWaitlistGet(request("GET"), tokenParams)).status).toBe(429);
    expect(mocks.applyRegistrantWaitlistAction).not.toHaveBeenCalled();
  });

  it("takes the registration from the link, never from the body", async () => {
    const response = await publicWaitlistPost(request("POST", { action: "accept", registrationId: "someone-else" }), tokenParams);
    expect(response.status).toBe(200);
    expect(mocks.applyRegistrantWaitlistAction.mock.calls[0]![0]).toMatchObject({ eventId: "ev1", registrationId: "reg1", accessTokenId: "tok1" });
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("says so when the offer has expired, with a 409 and no further effect", async () => {
    mocks.applyRegistrantWaitlistAction.mockResolvedValue({ entryId: "e1", status: "EXPIRED", replay: false });
    const response = await publicWaitlistPost(request("POST", { action: "accept" }), tokenParams);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("WAITLIST_OFFER_EXPIRED");
  });

  it("turns a refusal into its status and code, and refuses an oversized body", async () => {
    mocks.applyRegistrantWaitlistAction.mockRejectedValueOnce(new LodgingError("WAITLIST_NOT_ENABLED", "No waitlist."));
    expect((await publicWaitlistPost(request("POST", { action: "join", category: "TENT", partySize: 1 }), tokenParams)).status).toBe(409);
    const big = await publicWaitlistPost(request("POST", { action: "join", category: "TENT", partySize: 1, padding: "x".repeat(3_000) }), tokenParams);
    expect(big.status).toBe(413);
  });
});
