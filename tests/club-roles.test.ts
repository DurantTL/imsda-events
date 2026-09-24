import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  getCurrentAttendee: vi.fn(),
  listDirectedClubs: vi.fn(),
  findEnrollment: vi.fn(),
  findSession: vi.fn(),
  countPasskeys: vi.fn(),
  findSettings: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
  writeAuditLog: vi.fn(),
  findOrganization: vi.fn(),
  findAccount: vi.fn(),
  findGrants: vi.fn(),
  findGrant: vi.fn(),
  createGrant: vi.fn(),
  updateGrant: vi.fn(),
  revealRosterBirthDates: vi.fn(),
  listRoster: vi.fn(),
  updateClubProfile: vi.fn(),
  emailConfigured: vi.fn(),
  inviteFindMany: vi.fn(),
  inviteFindFirst: vi.fn(),
  inviteCreate: vi.fn(),
  inviteUpdate: vi.fn(),
  outboxCreate: vi.fn(),
  processAccountEmailQueue: vi.fn(),
}));

const client = {
  attendeeMfaEnrollment: { findUnique: mocks.findEnrollment },
  attendeeSession: { findUnique: mocks.findSession },
  attendeePasskey: { count: mocks.countPasskeys },
  platformSettings: { findUnique: mocks.findSettings },
  organization: { findUnique: mocks.findOrganization },
  attendeeAccount: { findUnique: mocks.findAccount },
  clubDirectorGrant: { findMany: mocks.findGrants, findFirst: mocks.findGrant, create: mocks.createGrant, update: mocks.updateGrant },
  clubInvite: { findMany: mocks.inviteFindMany, findFirst: mocks.inviteFindFirst, create: mocks.inviteCreate, update: mocks.inviteUpdate },
  messageOutbox: { create: mocks.outboxCreate },
  $transaction: (work: (tx: unknown) => unknown) => work(client),
};

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (importOriginal) => ({
  ...await importOriginal<typeof import("next/server")>(),
  after: mocks.after,
}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => client }));
vi.mock("@/lib/env", () => ({ getServerEnv: () => ({ APP_BASE_URL: "https://events.imsda.test" }) }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: mocks.getCurrentAttendee }));
vi.mock("@/modules/organizations/director-access", () => ({ listDirectedClubs: mocks.listDirectedClubs }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/club-rosters/repository", async () => {
  const actual = await vi.importActual<typeof import("@/modules/club-rosters/repository")>("@/modules/club-rosters/repository");
  return { ...actual, revealRosterBirthDates: mocks.revealRosterBirthDates, listRoster: mocks.listRoster };
});
vi.mock("@/modules/organizations/club-profile-repository", () => ({ updateClubProfile: mocks.updateClubProfile }));
vi.mock("@/modules/communications/account-email", () => ({
  isAccountEmailConfigured: mocks.emailConfigured,
  getAccountEmailSender: () => ({ name: "IMSDA Events", address: "events@example.test", replyTo: null }),
}));
vi.mock("@/modules/communications/email-delivery", () => ({
  processAccountEmailQueue: mocks.processAccountEmailQueue,
}));

import { GET as ROSTER } from "@/app/api/attendee/clubs/[organizationId]/roster/route";
import { POST as BIRTH_DATES } from "@/app/api/attendee/clubs/[organizationId]/roster/birth-dates/route";
import { GET as TEAM, POST as ADD_TEAM } from "@/app/api/attendee/clubs/[organizationId]/team/route";
import { DELETE as REMOVE_TEAM } from "@/app/api/attendee/clubs/[organizationId]/team/[grantId]/route";
import { DELETE as CANCEL_INVITE } from "@/app/api/attendee/clubs/[organizationId]/team/invites/[inviteId]/route";
import { POST as RESEND_INVITE } from "@/app/api/attendee/clubs/[organizationId]/team/invites/[inviteId]/resend/route";
import { PATCH as PROFILE } from "@/app/api/attendee/clubs/[organizationId]/profile/route";
import { getRosterAccessState } from "@/modules/club-rosters/access";
import { rosterSectionOf } from "@/modules/club-rosters/domain";
import { clubCapabilities, clubRoleIsAssignableByClub } from "@/modules/organizations/director-grants-domain";
import { grantClubTeamRole, revokeClubTeamRole } from "@/modules/organizations/director-grants-repository";
import { createClubTeamGrantInputSchema } from "@/modules/organizations/director-grants-schemas";

const now = new Date("2026-10-01T15:00:00Z");
const account = { id: "account-1", verifiedEmail: "leader@example.test", displayName: "Test Leader" };
const clubAs = (role: string) => ({ organizationId: "club-1", name: "Test Pathfinders", role, sponsoringChurch: null });
const ctx = { params: Promise.resolve({ organizationId: "club-1" }) };

function request(method: string, body?: unknown) {
  return new Request("https://events.imsda.test/api/attendee/clubs/club-1/x", {
    method,
    headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentAttendee.mockResolvedValue({ account, via: "attendee", sessionId: "session-1" });
  mocks.listDirectedClubs.mockResolvedValue([clubAs("DIRECTOR")]);
  mocks.findEnrollment.mockResolvedValue({ status: "ACTIVE" });
  mocks.findSession.mockResolvedValue({ secondFactorVerifiedAt: new Date(Date.now() - 60_000) });
  mocks.countPasskeys.mockResolvedValue(0);
  mocks.findSettings.mockResolvedValue({ passkeyRpId: null });
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.findOrganization.mockResolvedValue({ id: "club-1", name: "Test Pathfinders", type: "CLUB", isActive: true });
  mocks.findAccount.mockResolvedValue({ id: "account-2", status: "ACTIVE", emailVerifiedAt: now, disabledAt: null });
  mocks.findGrants.mockResolvedValue([]);
  mocks.createGrant.mockResolvedValue({ id: "grant-2" });
  mocks.listRoster.mockResolvedValue([]);
  mocks.revealRosterBirthDates.mockResolvedValue({});
  mocks.updateClubProfile.mockResolvedValue({ id: "club-1" });
  mocks.emailConfigured.mockReturnValue(true);
  mocks.inviteFindMany.mockResolvedValue([]);
  mocks.inviteFindFirst.mockResolvedValue(null);
  mocks.inviteCreate.mockResolvedValue({ id: "invite-1" });
  mocks.inviteUpdate.mockResolvedValue({ id: "invite-1" });
  mocks.outboxCreate.mockResolvedValue({ id: "message-1" });
  mocks.processAccountEmailQueue.mockResolvedValue({ recoveredIds: [], sentIds: [], failedIds: [], rescheduledIds: [] });
});

describe("club role capabilities (#375)", () => {
  it("keeps full birth dates, the team, and the profile with directors and deputies", () => {
    for (const role of ["DIRECTOR", "DEPUTY"] as const) {
      expect(clubCapabilities(role)).toMatchObject({ roster: true, seeBirthDates: true, manageTeam: true, editProfile: true });
    }
    expect(clubCapabilities("REGISTRAR")).toEqual({
      roster: true, registerForEvents: true, seeBirthDates: false, manageTeam: false, editProfile: false, submitReports: false,
    });
    expect(clubCapabilities("REPORTER")).toMatchObject({ roster: false, registerForEvents: false, submitReports: true });
  });

  it("lets the club give only Registrar and Reporter", () => {
    expect(clubRoleIsAssignableByClub("REGISTRAR")).toBe(true);
    expect(clubRoleIsAssignableByClub("REPORTER")).toBe(true);
    expect(clubRoleIsAssignableByClub("DIRECTOR")).toBe(false);
    expect(clubRoleIsAssignableByClub("DEPUTY")).toBe(false);
    expect(createClubTeamGrantInputSchema.safeParse({ email: "a@example.test", role: "DEPUTY" }).success).toBe(false);
  });
});

describe("roster sections", () => {
  it("puts staff and adults in Staff and everyone else in Members", () => {
    expect(rosterSectionOf("STAFF")).toBe("STAFF");
    expect(rosterSectionOf("ADULT")).toBe("STAFF");
    expect(rosterSectionOf("YOUTH")).toBe("MEMBERS");
    expect(rosterSectionOf("UNDERAGE")).toBe("MEMBERS");
  });
});

describe("access by role", () => {
  it("opens the roster for a registrar after the second step, without birth dates", async () => {
    mocks.listDirectedClubs.mockResolvedValue([clubAs("REGISTRAR")]);
    const access = await getRosterAccessState("club-1");
    expect(access).toMatchObject({ state: "OPEN", capabilities: { roster: true, seeBirthDates: false } });
    expect((await ROSTER(request("GET"), ctx)).status).toBe(200);
    const reveal = await BIRTH_DATES(request("POST", {}), ctx);
    expect(reveal.status).toBe(403);
    expect(mocks.revealRosterBirthDates).not.toHaveBeenCalled();
  });

  it("still needs the second step for a registrar", async () => {
    mocks.listDirectedClubs.mockResolvedValue([clubAs("REGISTRAR")]);
    mocks.findEnrollment.mockResolvedValue(null);
    await expect(getRosterAccessState("club-1")).resolves.toMatchObject({ state: "MFA_SETUP" });
  });

  it("gives a reporter the club but never the roster", async () => {
    mocks.listDirectedClubs.mockResolvedValue([clubAs("REPORTER")]);
    await expect(getRosterAccessState("club-1")).resolves.toMatchObject({ state: "NO_ROSTER" });
    const roster = await ROSTER(request("GET"), ctx);
    expect(roster.status).toBe(403);
    expect(await roster.json()).toMatchObject({ error: "ROLE_NOT_ALLOWED" });
    expect(mocks.listRoster).not.toHaveBeenCalled();
  });

  it("lets a director reveal birth dates", async () => {
    expect((await BIRTH_DATES(request("POST", {}), ctx)).status).toBe(200);
    expect(mocks.revealRosterBirthDates).toHaveBeenCalledOnce();
  });

  it("keeps the team and profile from a registrar", async () => {
    mocks.listDirectedClubs.mockResolvedValue([clubAs("REGISTRAR")]);
    expect((await ADD_TEAM(request("POST", { email: "helper@example.test", role: "REPORTER" }), ctx)).status).toBe(403);
    expect((await PROFILE(request("PATCH", { name: "New Name" }), ctx)).status).toBe(403);
    expect(mocks.createGrant).not.toHaveBeenCalled();
    expect(mocks.updateClubProfile).not.toHaveBeenCalled();
  });

  it("lets a deputy save the profile, audited as the deputy's account", async () => {
    mocks.listDirectedClubs.mockResolvedValue([clubAs("DEPUTY")]);
    const response = await PROFILE(request("PATCH", { name: "Test Pathfinders", meetingPlace: "Fellowship hall" }), ctx);
    expect(response.status).toBe(200);
    expect(mocks.updateClubProfile).toHaveBeenCalledWith("club-1", expect.objectContaining({ meetingPlace: "Fellowship hall" }), { accountId: "account-1" });
  });
});

describe("the club team", () => {
  it("lets a director give the Registrar role, audited as the director", async () => {
    const response = await ADD_TEAM(request("POST", { email: "Helper@Example.test", role: "REGISTRAR" }), ctx);
    expect(response.status).toBe(201);
    expect(mocks.findAccount).toHaveBeenCalledWith(expect.objectContaining({ where: { email: "helper@example.test" } }));
    expect(mocks.createGrant).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ role: "REGISTRAR", grantedByAccountId: "account-1", organizationId: "club-1" }),
    }));
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "CLUB_ROLE_GRANTED",
      metadata: expect.objectContaining({ role: "REGISTRAR", actorAttendeeAccountId: "account-1" }),
    }), client);
  });

  it("won't give a second role to someone already on the team", async () => {
    mocks.findGrants.mockResolvedValueOnce([{ effectiveFrom: new Date("2026-01-01"), effectiveTo: null }]);
    await expect(grantClubTeamRole("club-1", { email: "helper@example.test", role: "REPORTER" }, "account-1", now))
      .rejects.toMatchObject({ code: "DIRECTOR_GRANT_CONFLICT" });
  });

  it("notifies an existing account by email when the role is granted (#425)", async () => {
    const response = await ADD_TEAM(request("POST", { email: "helper@example.test", role: "REGISTRAR" }), ctx);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.invited).toBe(false);
    const message = mocks.outboxCreate.mock.calls[0][0].data;
    expect(message).toMatchObject({ templateKey: "CLUB_TEAM_ROLE_NOTIFICATION", recipientEmail: "helper@example.test", accountAttendeeId: "account-2" });
    expect(mocks.after).toHaveBeenCalledOnce();
    const queued = mocks.after.mock.calls[0][0];
    await queued();
    expect(mocks.processAccountEmailQueue).toHaveBeenCalledWith({ messageIds: ["message-1"], limit: 1 });
  });

  it("invites someone with no verified account yet instead of failing (#425)", async () => {
    mocks.findAccount.mockResolvedValue(null);
    const response = await ADD_TEAM(request("POST", { email: "new.helper@example.test", role: "REPORTER" }), ctx);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.invited).toBe(true);
    expect(mocks.inviteCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ email: "new.helper@example.test", role: "REPORTER", source: "CLUB", createdByAccountId: "account-1" }),
    }));
    expect(mocks.createGrant).not.toHaveBeenCalled();
    expect(mocks.after).toHaveBeenCalledOnce();
  });

  it("invites rather than grants for a disabled or unverified account", async () => {
    mocks.findAccount.mockResolvedValue({ id: "account-2", status: "ACTIVE", emailVerifiedAt: null, disabledAt: null });
    const response = await ADD_TEAM(request("POST", { email: "unverified@example.test", role: "REGISTRAR" }), ctx);
    expect(response.status).toBe(201);
    expect((await response.json()).invited).toBe(true);
    expect(mocks.createGrant).not.toHaveBeenCalled();
  });

  it("refuses a director or deputy role from the club", async () => {
    await expect(grantClubTeamRole("club-1", { email: "x@example.test", role: "DEPUTY" as never }, "account-1", now))
      .rejects.toMatchObject({ code: "DIRECTOR_GRANT_ROLE_NOT_ALLOWED" });
  });

  it("removes a reporter but never a director", async () => {
    mocks.findGrant.mockResolvedValueOnce({ id: "grant-2", role: "REPORTER", revokedAt: null, attendeeAccountId: "account-2" });
    const response = await REMOVE_TEAM(request("DELETE"), { params: Promise.resolve({ organizationId: "club-1", grantId: "grant-2" }) });
    expect(response.status).toBe(200);
    expect(mocks.updateGrant).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ revokedByAccountId: "account-1" }),
    }));

    mocks.findGrant.mockResolvedValueOnce({ id: "grant-1", role: "DIRECTOR", revokedAt: null, attendeeAccountId: "account-3" });
    await expect(revokeClubTeamRole("club-1", "grant-1", "account-1", now)).rejects.toMatchObject({ code: "DIRECTOR_GRANT_ROLE_NOT_ALLOWED" });
  });

  it("finds no grant from another club", async () => {
    mocks.findGrant.mockResolvedValueOnce(null);
    await expect(revokeClubTeamRole("club-1", "grant-other", "account-1", now)).rejects.toMatchObject({ code: "DIRECTOR_GRANT_NOT_FOUND" });
    expect(mocks.findGrant).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "grant-other", organizationId: "club-1" } }));
  });
});

describe("pending club team invites (#425)", () => {
  it("lists pending invites alongside the team", async () => {
    mocks.inviteFindMany.mockResolvedValue([
      { id: "invite-1", email: "a@example.test", name: "", role: "REGISTRAR", status: "SENT", sentAt: now, sentCount: 1, expiresAt: null },
    ]);
    const response = await TEAM(request("GET"), ctx);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.invites).toEqual([{
      id: "invite-1", email: "a@example.test", name: "", role: "REGISTRAR",
      sentAt: now.toISOString(), sentCount: 1, expiresAt: null, expired: false,
    }]);
  });

  it("resends an invite through the route", async () => {
    mocks.inviteFindFirst.mockResolvedValue({
      id: "invite-1", email: "a@example.test", name: "", role: "REGISTRAR", status: "SENT",
      sentAt: new Date(Date.now() - 60 * 60_000),
      organization: { name: "Test Pathfinders", isActive: true },
    });
    const response = await RESEND_INVITE(request("POST"), { params: Promise.resolve({ organizationId: "club-1", inviteId: "invite-1" }) });
    expect(response.status).toBe(200);
    expect(mocks.inviteUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "SENT" }) }));
    expect(mocks.after).toHaveBeenCalledOnce();
  });

  it("cancels an invite through the route", async () => {
    mocks.inviteFindFirst.mockResolvedValue({ id: "invite-1", status: "SENT", role: "REPORTER" });
    const response = await CANCEL_INVITE(request("DELETE"), { params: Promise.resolve({ organizationId: "club-1", inviteId: "invite-1" }) });
    expect(response.status).toBe(200);
    expect(mocks.inviteUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "CANCELLED" }) }));
  });

  it("keeps invite management from a registrar", async () => {
    mocks.listDirectedClubs.mockResolvedValue([clubAs("REGISTRAR")]);
    mocks.inviteFindFirst.mockResolvedValue({ id: "invite-1", status: "SENT", role: "REPORTER" });
    const response = await CANCEL_INVITE(request("DELETE"), { params: Promise.resolve({ organizationId: "club-1", inviteId: "invite-1" }) });
    expect(response.status).toBe(403);
    expect(mocks.inviteUpdate).not.toHaveBeenCalled();
  });
});
