import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  requirePermission: vi.fn(),
  getHonorRosterData: vi.fn(),
  requireRosterAccess: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/modules/events/repository", () => ({ findActiveMembership: vi.fn() }));
vi.mock("@/modules/access/authorization", async () => {
  const actual = await vi.importActual<typeof import("@/modules/access/authorization")>("@/modules/access/authorization");
  return { ...actual, requirePermission: mocks.requirePermission };
});
vi.mock("@/modules/honors/roster-repository", () => ({ getHonorRosterData: mocks.getHonorRosterData }));
vi.mock("@/modules/club-rosters/access", async () => {
  const actual = await vi.importActual<typeof import("@/modules/club-rosters/access")>("@/modules/club-rosters/access");
  return { ...actual, requireRosterAccess: mocks.requireRosterAccess };
});

import { GET as STAFF_GET } from "@/app/api/events/[eventId]/honors/rosters/route";
import { GET as DIRECTOR_GET } from "@/app/api/attendee/clubs/[organizationId]/events/[eventId]/schedule/route";
import { AccessDeniedError } from "@/modules/access/authorization";
import { RosterAccessError } from "@/modules/club-rosters/access";

const data = {
  event: { id: "event-1", name: "Honors Weekend", startsAt: "", endsAt: "", timezone: "America/Chicago", location: null },
  sessions: [{ id: "s1", name: "Sabbath", sortOrder: 1 }],
  offerings: [{ id: "o1", honorName: "Knots", honorCode: "AR-011", span: "SINGLE_SESSION", sessionId: "s1", capacity: 5, teacherName: "", location: "", isActive: true }],
  enrollments: [{ offeringId: "o1", attendeeId: "a1", consumesSeat: true }],
  attendees: [{ id: "a1", firstName: "Sam", lastName: "Sample", clubId: "club-a", clubName: "Test Club", ageOnEventDate: 12, attendeeType: "YOUTH", checkedIn: false, dietary: "Vegan" }],
  clubs: [{ id: "club-a", name: "Test Club" }],
};
const staffCtx = { params: Promise.resolve({ eventId: "event-1" }) };
const staffRequest = (query: string) => new Request(`https://events.imsda.test/api/events/event-1/honors/rosters?${query}`);
const member = (role: string, permissions: string[] = []) => ({ user: { id: "u1", globalRole: "USER" }, membership: { role, permissions } });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentSession.mockResolvedValue({ user: { id: "u1" } });
  mocks.requirePermission.mockResolvedValue(member("REGISTRATION_MANAGER"));
  mocks.getHonorRosterData.mockResolvedValue(data);
  mocks.requireRosterAccess.mockResolvedValue({ accountId: "director-1" });
});

describe("staff roster CSV", () => {
  it("needs report access", async () => {
    mocks.requirePermission.mockRejectedValueOnce(new AccessDeniedError("No.", 403, "PERMISSION_DENIED"));
    expect((await STAFF_GET(staffRequest("view=classes"), staffCtx)).status).toBe(403);
    expect(mocks.requirePermission).toHaveBeenCalledWith(expect.anything(), "event-1", "VIEW_REPORTS", expect.anything());
    expect(mocks.getHonorRosterData).not.toHaveBeenCalled();
  });

  it("reads dietary answers only for the site roster and only with sensitive-data access", async () => {
    const withAccess = await STAFF_GET(staffRequest("view=site"), staffCtx);
    expect(mocks.getHonorRosterData).toHaveBeenLastCalledWith("event-1", { includeDietary: true });
    expect(await withAccess.text()).toContain("Dietary notes");

    // Report access granted on its own, without sensitive-data access.
    mocks.requirePermission.mockResolvedValueOnce(member("READ_ONLY_STAFF", ["VIEW_REPORTS"]));
    await STAFF_GET(staffRequest("view=site"), staffCtx);
    expect(mocks.getHonorRosterData).toHaveBeenLastCalledWith("event-1", { includeDietary: false });

    await STAFF_GET(staffRequest("view=classes"), staffCtx);
    expect(mocks.getHonorRosterData).toHaveBeenLastCalledWith("event-1", { includeDietary: false });
  });

  it("returns a private CSV attachment", async () => {
    const response = await STAFF_GET(staffRequest("view=classes"), staffCtx);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.text()).toContain('"Knots"');
  });

  it("rejects unknown views and clubs that didn't register", async () => {
    expect((await STAFF_GET(staffRequest("view=everything"), staffCtx)).status).toBe(400);
    expect((await STAFF_GET(staffRequest("view=club&club=someone-else"), staffCtx)).status).toBe(404);
    expect((await STAFF_GET(staffRequest("view=club&club=club-a"), staffCtx)).status).toBe(200);
  });
});

describe("staff roster CSV with sites (#589)", () => {
  const siteData = {
    ...data,
    locations: [{ id: "loc-hr", name: "Camp Heritage 1", sortOrder: 0 }, { id: "loc-dm", name: "Des Moines", sortOrder: 1 }],
    hasLocations: true,
    sessions: [{ id: "s1", name: "Sabbath", locationId: "loc-hr", sortOrder: 1 }],
    offerings: [{ ...data.offerings[0], siteName: "Camp Heritage 1" }],
    attendees: [{ ...data.attendees[0], locationId: "loc-hr", locationName: "Camp Heritage 1" }],
  };

  it("filters by site and names the site on every row", async () => {
    mocks.getHonorRosterData.mockResolvedValue(siteData);
    const response = await STAFF_GET(staffRequest("view=classes&site=loc-hr"), staffCtx);
    expect(mocks.getHonorRosterData).toHaveBeenLastCalledWith("event-1", { includeDietary: false, locationId: "loc-hr" });
    const csv = await response.text();
    expect(csv.split("\r\n")[0]).toMatch(/^"?Site"?,/);
    expect(csv).toContain('"Camp Heritage 1","Sabbath"');
  });

  it("uses all sites when no site is given, and refuses a site the event doesn't have", async () => {
    mocks.getHonorRosterData.mockResolvedValue(siteData);
    await STAFF_GET(staffRequest("view=site"), staffCtx);
    expect(mocks.getHonorRosterData).toHaveBeenLastCalledWith("event-1", { includeDietary: true });
    const missing = await STAFF_GET(staffRequest("view=site&site=loc-nope"), staffCtx);
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ error: "SITE_NOT_FOUND" });
  });

  it("leaves the columns as they were for an event without sites", async () => {
    const csv = await (await STAFF_GET(staffRequest("view=classes"), staffCtx)).text();
    expect(csv.split("\r\n")[0]).not.toMatch(/Site/);
  });
});

describe("director schedule CSV", () => {
  const ctx = (organizationId = "club-a") => ({ params: Promise.resolve({ organizationId, eventId: "event-1" }) });
  const request = () => new Request("https://events.imsda.test/api/attendee/clubs/club-a/events/event-1/schedule");

  it("loads only the director's own club, never dietary answers", async () => {
    const response = await DIRECTOR_GET(request(), ctx());
    expect(response.status).toBe(200);
    expect(mocks.requireRosterAccess).toHaveBeenCalledWith("club-a");
    expect(mocks.getHonorRosterData).toHaveBeenCalledWith("event-1", { includeDietary: false, organizationId: "club-a" });
    const text = await response.text();
    expect(text).toContain('"Knots"');
    expect(text).not.toContain("Vegan");
  });

  it("needs roster access (authenticator or passkey) first", async () => {
    mocks.requireRosterAccess.mockRejectedValueOnce(new RosterAccessError("MFA_UNLOCK_REQUIRED", 403, "Confirm it's you."));
    expect((await DIRECTOR_GET(request(), ctx())).status).toBe(403);
    expect(mocks.getHonorRosterData).not.toHaveBeenCalled();
  });

  it("answers 404 when the club isn't registered", async () => {
    mocks.getHonorRosterData.mockResolvedValueOnce({ ...data, clubs: [] });
    expect((await DIRECTOR_GET(request(), ctx())).status).toBe(404);
  });
});
