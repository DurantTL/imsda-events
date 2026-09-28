import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The honors routes behind the real roster gate (#486, ADR 0005 Addendum A
 * §5): neither `modules/honors/member-honor-access` nor
 * `modules/club-rosters/access` is mocked. Only the lookups underneath them
 * (the attendee session, club grants, MFA enrollment, passkeys, the Area
 * Coordinator grant, and the staff act-as) are stubbed.
 */
const mocks = vi.hoisted(() => ({
  getCurrentAttendee: vi.fn(),
  listDirectedClubs: vi.fn(),
  findEnrollment: vi.fn(),
  findSession: vi.fn(),
  countPasskeys: vi.fn(),
  findSettings: vi.fn(),
  findAreaGrant: vi.fn(),
  findOrganization: vi.fn(),
  listClubHonorsPage: vi.fn(),
  listActiveHonorOptions: vi.fn(),
  recordMemberHonorEntries: vi.fn(),
  listMemberHonorHistory: vi.fn(),
  auditClubHonorsExport: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/attendee-accounts/sign-in-gate", () => ({ accountNeedsSecondStep: async () => "OK" }));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    attendeeMfaEnrollment: { findUnique: mocks.findEnrollment },
    attendeeSession: { findUnique: mocks.findSession },
    attendeePasskey: { count: mocks.countPasskeys },
    platformSettings: { findUnique: mocks.findSettings },
    areaCoordinatorGrant: { findUnique: mocks.findAreaGrant },
    organization: { findUnique: mocks.findOrganization },
  }),
}));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: mocks.getCurrentAttendee }));
vi.mock("@/modules/organizations/director-access", () => ({ listDirectedClubs: mocks.listDirectedClubs }));
vi.mock("@/modules/organizations/staff-act-as", () => ({ currentStaffActingContext: async () => null }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: () => null }));
vi.mock("@/modules/honors/member-honor-repository", async () => {
  const actual = await vi.importActual<typeof import("@/modules/honors/member-honor-repository")>("@/modules/honors/member-honor-repository");
  return {
    ...actual,
    listClubHonorsPage: mocks.listClubHonorsPage,
    listActiveHonorOptions: mocks.listActiveHonorOptions,
    recordMemberHonorEntries: mocks.recordMemberHonorEntries,
    listMemberHonorHistory: mocks.listMemberHonorHistory,
    auditClubHonorsExport: mocks.auditClubHonorsExport,
  };
});

import { GET as CLUB_HONORS_GET, POST as CLUB_HONORS_POST } from "@/app/api/attendee/clubs/[organizationId]/honors/route";
import { GET as CSV_GET } from "@/app/api/attendee/clubs/[organizationId]/honors/csv/route";
import { GET as MEMBER_GET, POST as MEMBER_POST } from "@/app/api/attendee/clubs/[organizationId]/roster/[memberId]/honors/route";

const club = { organizationId: "club-1", name: "Test Pathfinders", role: "DIRECTOR", sponsoringChurch: null };
const account = { id: "director-1", verifiedEmail: "director@example.test", displayName: "Test Director" };
const ctx = () => ({ params: Promise.resolve({ organizationId: "club-1" }) });
const memberCtx = () => ({ params: Promise.resolve({ organizationId: "club-1", memberId: "member-1" }) });
const getRequest = () => new Request("https://events.imsda.test/api/attendee/x");
const postRequest = (body: unknown) => new Request("https://events.imsda.test/api/attendee/x", {
  method: "POST",
  headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
  body: JSON.stringify(body),
});
const entry = { honorId: "honor-1", status: "IN_PROGRESS", completionDate: "", note: "" };

/** Every honors route, called the way the browser would. */
const calls = [
  ["GET club honors", () => CLUB_HONORS_GET(getRequest(), ctx())],
  ["POST bulk entry", () => CLUB_HONORS_POST(postRequest({ ...entry, memberIds: ["member-1"] }), ctx())],
  ["GET CSV export", () => CSV_GET(getRequest(), ctx())],
  ["GET member history", () => MEMBER_GET(getRequest(), memberCtx())],
  ["POST member entry", () => MEMBER_POST(postRequest(entry), memberCtx())],
] as const;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getCurrentAttendee.mockResolvedValue({ account, via: "attendee", sessionId: "session-1" });
  mocks.listDirectedClubs.mockResolvedValue([club]);
  mocks.findEnrollment.mockResolvedValue({ status: "ACTIVE" });
  mocks.findSession.mockResolvedValue({ secondFactorVerifiedAt: new Date(Date.now() - 60_000) });
  mocks.countPasskeys.mockResolvedValue(0);
  mocks.findSettings.mockResolvedValue({ passkeyRpId: null });
  mocks.findAreaGrant.mockResolvedValue(null);
  mocks.findOrganization.mockResolvedValue({ type: "CLUB", isActive: true });
  mocks.listClubHonorsPage.mockResolvedValue([]);
  mocks.listActiveHonorOptions.mockResolvedValue([]);
  mocks.recordMemberHonorEntries.mockResolvedValue(undefined);
  mocks.listMemberHonorHistory.mockResolvedValue({ firstName: "Test", lastName: "Member", current: [], history: [] });
  mocks.auditClubHonorsExport.mockResolvedValue(undefined);
});

function expectNothingRead() {
  expect(mocks.listClubHonorsPage).not.toHaveBeenCalled();
  expect(mocks.listMemberHonorHistory).not.toHaveBeenCalled();
  expect(mocks.recordMemberHonorEntries).not.toHaveBeenCalled();
  expect(mocks.auditClubHonorsExport).not.toHaveBeenCalled();
}

describe("honors routes refuse exactly like the roster", () => {
  it.each(calls)("%s: MFA_SETUP_REQUIRED when no authenticator or passkey is set up", async (_name, call) => {
    mocks.findEnrollment.mockResolvedValue(null);
    const response = await call();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "MFA_SETUP_REQUIRED" });
    expectNothingRead();
  });

  it.each(calls)("%s: MFA_UNLOCK_REQUIRED when the roster hasn't been unlocked this session", async (_name, call) => {
    mocks.findSession.mockResolvedValue({ secondFactorVerifiedAt: null });
    const response = await call();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "MFA_UNLOCK_REQUIRED" });
    expectNothingRead();
  });

  it("an Area Coordinator who also directs this club still has to unlock; the read-only fallback never skips it", async () => {
    mocks.findSession.mockResolvedValue({ secondFactorVerifiedAt: null });
    mocks.findAreaGrant.mockResolvedValue({ revokedAt: null, expiresAt: null });
    const response = await CLUB_HONORS_GET(getRequest(), ctx());
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "MFA_UNLOCK_REQUIRED" });
  });

  it("opens for an unlocked director and audits the CSV export", async () => {
    const response = await CSV_GET(getRequest(), ctx());
    expect(response.status).toBe(200);
    expect(mocks.auditClubHonorsExport).toHaveBeenCalledWith("club-1", expect.any(String), 0, { accountId: "director-1" }, false);
  });

  it("gives an Area Coordinator with no club role read-only access, and 404 for a non-club organization", async () => {
    mocks.listDirectedClubs.mockResolvedValue([]);
    mocks.findAreaGrant.mockResolvedValue({ revokedAt: null, expiresAt: null });
    const read = await CLUB_HONORS_GET(getRequest(), ctx());
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ readOnly: true });
    const write = await CLUB_HONORS_POST(postRequest({ ...entry, memberIds: ["member-1"] }), ctx());
    expect(write.status).toBe(404);
    expect(mocks.recordMemberHonorEntries).not.toHaveBeenCalled();

    mocks.findOrganization.mockResolvedValue({ type: "CHURCH", isActive: true });
    const church = await CLUB_HONORS_GET(getRequest(), ctx());
    expect(church.status).toBe(404);
  });
});
