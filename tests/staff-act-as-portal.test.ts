import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Staff "act as" (#442) end to end through the real act-as module, the real
 * club access choke point, the real Area Coordinator viewer check, and the
 * real roster route and repository. Only the staff session, the attendee
 * cookie, and the database are stubbed.
 */
const mocks = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  getCurrentAttendee: vi.fn(),
  listDirectedClubs: vi.fn(),
  accountNeedsSecondStep: vi.fn(),
  redirect: vi.fn((to: string) => { throw new Error(`REDIRECT ${to}`); }),
  notFound: vi.fn(() => { throw new Error("NOT_FOUND"); }),
  writeAuditLog: vi.fn(),
  actAsFindFirst: vi.fn(),
  sessionFindUnique: vi.fn(),
  orgFindUnique: vi.fn(),
  memberFindMany: vi.fn(),
  memberCreate: vi.fn(),
  personCreate: vi.fn(),
  reportFindUnique: vi.fn(),
  profileFindUnique: vi.fn(),
}));

const client = {
  staffActAs: { findFirst: mocks.actAsFindFirst, updateMany: vi.fn() },
  userSession: { findUnique: mocks.sessionFindUnique },
  organization: { findUnique: mocks.orgFindUnique },
  attendeeMfaEnrollment: { findUnique: async () => ({ status: "ACTIVE" }) },
  attendeePasskey: { count: async () => 0 },
  attendeeSession: { findUnique: async () => ({ secondFactorVerifiedAt: new Date(Date.now() - 60_000) }) },
  areaCoordinatorGrant: { findUnique: async () => null },
  clubRosterMember: { findMany: mocks.memberFindMany, create: mocks.memberCreate },
  clubMonthlyReport: { findUnique: mocks.reportFindUnique },
  clubProfile: { findUnique: mocks.profileFindUnique },
  person: { create: mocks.personCreate },
  $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(client),
};

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect, notFound: mocks.notFound }));
vi.mock("@/lib/env", () => ({
  getServerEnv: () => ({ APP_BASE_URL: "https://events.imsda.test", SECRET_ENCRYPTION_KEY: "a-secret-encryption-key-of-adequate-length" }),
  isServerEnvironmentError: () => false,
}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => client }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: mocks.getCurrentAttendee }));
vi.mock("@/modules/attendee-accounts/passkeys", () => ({ passkeysConfigured: async () => false }));
vi.mock("@/modules/attendee-accounts/sign-in-gate", () => ({ accountNeedsSecondStep: mocks.accountNeedsSecondStep }));
vi.mock("@/modules/organizations/director-access", () => ({ listDirectedClubs: mocks.listDirectedClubs }));

import { POST as ADD_TO_ROSTER } from "@/app/api/attendee/clubs/[organizationId]/roster/route";
import AccountPortalLayout from "@/app/(public)/account/(portal)/layout";
import AreaClubPage from "@/app/(public)/account/(portal)/area/[organizationId]/page";
import AreaClubReportPage from "@/app/(public)/account/(portal)/area/[organizationId]/reports/[month]/page";
import { getRosterAccessState } from "@/modules/club-rosters/access";

const admin = { user: { id: "admin-1", email: "admin@example.test", displayName: "Admin", globalRole: "SYSTEM_ADMIN" }, sessionId: "staff-session-1" };
const liveStaffSession = () => ({
  expiresAt: new Date(Date.now() + 6 * 3_600_000),
  revokedAt: null,
  lastSeenAt: new Date(),
  user: { id: "admin-1", globalRole: "SYSTEM_ADMIN", accountStatus: "ACTIVE", credential: { disabledAt: null } },
});
const actingRow = (role: "CLUB_DIRECTOR" | "AREA_COORDINATOR", organizationId: string | null) => ({
  id: "act-1", userId: "admin-1", staffSessionId: "staff-session-1", role, organizationId, expiresAt: new Date(Date.now() + 3_600_000),
});
// A different person's attendee cookie on the same browser: the director of club B.
const clubBDirector = { account: { id: "account-b", verifiedEmail: "director.b@example.test", displayName: "Director B" }, via: "attendee", sessionId: "attendee-session-b" };

const clubs: Record<string, { type: string; isActive: boolean; name: string; parentOrganization: null }> = {
  "club-a": { type: "CLUB", isActive: true, name: "Club A", parentOrganization: null },
  "club-b": { type: "CLUB", isActive: true, name: "Club B", parentOrganization: null },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentSession.mockResolvedValue(admin);
  mocks.sessionFindUnique.mockResolvedValue(liveStaffSession());
  mocks.actAsFindFirst.mockResolvedValue(actingRow("CLUB_DIRECTOR", "club-a"));
  mocks.getCurrentAttendee.mockResolvedValue(clubBDirector);
  mocks.listDirectedClubs.mockImplementation(async (accountId: string) => (
    accountId === "account-b" ? [{ organizationId: "club-b", name: "Club B", role: "DIRECTOR", sponsoringChurch: null }] : []
  ));
  mocks.accountNeedsSecondStep.mockResolvedValue("OK");
  mocks.orgFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => clubs[where.id] ?? null);
  mocks.memberFindMany.mockResolvedValue([]);
  mocks.personCreate.mockResolvedValue({ id: "person-1" });
  mocks.memberCreate.mockResolvedValue({ id: "member-1" });
  mocks.reportFindUnique.mockResolvedValue(null);
  mocks.profileFindUnique.mockResolvedValue(null);
});

describe("acting as club A's director with club B's director signed in on the same browser (#442)", () => {
  it("resolves club A from the staff act-as and club B from the attendee account", async () => {
    await expect(getRosterAccessState("club-a")).resolves.toMatchObject({
      state: "OPEN", actor: { kind: "STAFF_ACTING", userId: "admin-1", actAsId: "act-1", organizationId: "club-a" },
    });
    await expect(getRosterAccessState("club-b")).resolves.toMatchObject({
      state: "OPEN", actor: { kind: "ATTENDEE", accountId: "account-b", sessionId: "attendee-session-b" },
    });
  });

  const add = (organizationId: string) => ADD_TO_ROSTER(new Request(`https://events.imsda.test/api/attendee/clubs/${organizationId}/roster`, {
    method: "POST",
    headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
    body: JSON.stringify({ firstName: "Test", lastName: "Youth", birthDate: "2014-12-06", attendeeType: "YOUTH", gender: "FEMALE" }),
  }), { params: Promise.resolve({ organizationId }) });

  it("adds to club A's roster as the staff user (createdByUserId), never an attendee account", async () => {
    const response = await add("club-a");
    expect(response.status).toBe(201);
    const data = mocks.memberCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({ organizationId: "club-a", createdByUserId: "admin-1" });
    expect(data).not.toHaveProperty("createdByAccountId");
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "CLUB_ROSTER_MEMBER_ADDED",
      actorUserId: "admin-1",
      metadata: expect.objectContaining({ organizationId: "club-a", actAsId: "act-1" }),
    }), client);
    expect(mocks.writeAuditLog.mock.calls[0][0].metadata).not.toHaveProperty("actorAttendeeAccountId");
  });

  it("adds to club B's roster as club B's own director, untouched by the act-as", async () => {
    const response = await add("club-b");
    expect(response.status).toBe(201);
    const data = mocks.memberCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({ organizationId: "club-b", createdByAccountId: "account-b" });
    expect(data).not.toHaveProperty("createdByUserId");
  });

  it("ignores an act-as row that isn't this staff user's, falling back to the attendee path", async () => {
    mocks.actAsFindFirst.mockResolvedValue({ ...actingRow("CLUB_DIRECTOR", "club-a"), userId: "admin-2" });
    await expect(getRosterAccessState("club-a")).resolves.toEqual({ state: "NOT_FOUND" });
  });
});

describe("Area Coordinator view-only pages (#442)", () => {
  const areaPage = () => AreaClubPage({ params: Promise.resolve({ organizationId: "club-b" }) });
  const reportPage = () => AreaClubReportPage({ params: Promise.resolve({ organizationId: "club-b", month: "2026-09" }) });

  it("open for a system administrator acting as an Area Coordinator, with no attendee account", async () => {
    mocks.actAsFindFirst.mockResolvedValue(actingRow("AREA_COORDINATOR", null));
    mocks.getCurrentAttendee.mockResolvedValue({ account: null, via: null, sessionId: null });
    mocks.reportFindUnique.mockResolvedValue({
      id: "report-1", organizationId: "club-b", clubYear: "2026-27", reportMonth: "2026-09", classLevels: [], points: {}, honors: [],
      status: "SUBMITTED", submittedAt: new Date("2026-10-05T15:00:00Z"), firstSubmittedAt: new Date("2026-10-05T15:00:00Z"),
      updatedAt: new Date("2026-10-05T15:00:00Z"), totalPoints: 25, onTimePoints: 25,
    });
    await expect(areaPage()).resolves.toBeTruthy();
    await expect(reportPage()).resolves.toBeTruthy();
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  it("stay closed while acting as a club director, or once the act-as is gone", async () => {
    await expect(areaPage()).rejects.toThrow("NOT_FOUND");
    mocks.actAsFindFirst.mockResolvedValue(null);
    await expect(reportPage()).rejects.toThrow("NOT_FOUND");
  });

  it("stay closed when the staff user is no longer a system administrator", async () => {
    mocks.actAsFindFirst.mockResolvedValue(actingRow("AREA_COORDINATOR", null));
    mocks.getCurrentSession.mockResolvedValue({ ...admin, user: { ...admin.user, globalRole: null } });
    await expect(areaPage()).rejects.toThrow("NOT_FOUND");
  });
});

describe("the account portal layout while acting (#442)", () => {
  it("doesn't send an act-as to /account/two-step because of an unrelated attendee cookie", async () => {
    mocks.accountNeedsSecondStep.mockResolvedValue("VERIFY");
    await expect(AccountPortalLayout({ children: null })).resolves.toBeTruthy();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("still sends an attendee who hasn't passed the second step there when nobody is acting", async () => {
    mocks.actAsFindFirst.mockResolvedValue(null);
    mocks.accountNeedsSecondStep.mockResolvedValue("VERIFY");
    await expect(AccountPortalLayout({ children: null })).rejects.toThrow("REDIRECT /account/two-step");
  });
});

describe("the act-as banner (#442)", () => {
  it("shows the end time in the conference's time zone, whatever the server's", async () => {
    const { actAsEndTime } = await import("@/components/act-as-banner");
    // 17:30 UTC is 12:30 PM in Chicago (CDT) in September.
    expect(actAsEndTime(new Date("2026-09-26T17:30:00Z"))).toBe("12:30 PM CDT");
    // And 11:30 AM CST once daylight saving has ended.
    expect(actAsEndTime(new Date("2026-12-01T17:30:00Z"))).toBe("11:30 AM CST");
  });
});
