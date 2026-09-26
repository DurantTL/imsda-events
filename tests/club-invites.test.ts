import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  writeAuditLog: vi.fn(),
  configured: vi.fn(),
  inviteFindMany: vi.fn(),
  inviteFindUnique: vi.fn(),
  inviteFindFirst: vi.fn(),
  inviteCreate: vi.fn(),
  inviteUpdate: vi.fn(),
  inviteUpdateMany: vi.fn(),
  outboxCreate: vi.fn(),
  organizationFindUnique: vi.fn(),
  grantFindFirst: vi.fn(),
  grantCreate: vi.fn(),
  getCurrentAttendee: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
}));

const client = {
  clubInvite: {
    findMany: mocks.inviteFindMany,
    findUnique: mocks.inviteFindUnique,
    findFirst: mocks.inviteFindFirst,
    create: mocks.inviteCreate,
    update: mocks.inviteUpdate,
    updateMany: mocks.inviteUpdateMany,
  },
  organization: { findUnique: mocks.organizationFindUnique },
  messageOutbox: { create: mocks.outboxCreate },
  clubDirectorGrant: { findFirst: mocks.grantFindFirst, create: mocks.grantCreate },
  $transaction: (work: (tx: unknown) => unknown) => work(client),
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => client }));
vi.mock("@/lib/env", () => ({ getServerEnv: () => ({ APP_BASE_URL: "https://events.imsda.test" }) }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/communications/account-email", () => ({
  isAccountEmailConfigured: mocks.configured,
  getAccountEmailSender: () => ({ name: "IMSDA Events", address: "events@example.test", replyTo: null }),
}));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: mocks.getCurrentAttendee }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));

import { POST as ACCEPT } from "@/app/api/attendee/club-invites/[inviteId]/accept/route";
import {
  acceptClubInvite,
  cancelClubTeamInvite,
  clubInviteExpiry,
  clubInviteSignUpUrl,
  createClubTeamInvite,
  listInvitesForAccount,
  listPendingClubTeamInvites,
  resendClubTeamInvite,
  sendClubInvites,
} from "@/modules/club-imports/invites";

const now = new Date("2026-09-23T15:00:00Z");
const account = { id: "account-1", verifiedEmail: "Leader@Example.test" };
const sentInvite = {
  id: "invite-1",
  email: "leader@example.test",
  role: "DIRECTOR",
  status: "SENT",
  organizationId: "club-1",
  createdByUserId: "admin-1",
  organization: { isActive: true, type: "CLUB" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.configured.mockReturnValue(true);
  mocks.inviteFindMany.mockResolvedValue([
    { id: "invite-1", email: "leader@example.test", name: "Pat Example", role: "DIRECTOR", organizationId: "club-1", organization: { name: "Example Pathfinders" } },
  ]);
  mocks.outboxCreate.mockResolvedValue({ id: "message-1" });
  mocks.inviteFindUnique.mockResolvedValue(sentInvite);
  mocks.grantFindFirst.mockResolvedValue(null);
  mocks.grantCreate.mockResolvedValue({ id: "grant-1" });
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.organizationFindUnique.mockResolvedValue({ id: "club-1", name: "Example Pathfinders", type: "CLUB", isActive: true });
  mocks.inviteFindFirst.mockResolvedValue(null);
  mocks.inviteCreate.mockResolvedValue({ id: "invite-2" });
  mocks.inviteUpdateMany.mockResolvedValue({ count: 1 });
});

describe("sending club invites (#376)", () => {
  it("sends only when account email is set up", async () => {
    mocks.configured.mockReturnValue(false);
    await expect(sendClubInvites({}, "admin-1", now)).rejects.toMatchObject({ code: "EMAIL_NOT_CONFIGURED" });
    expect(mocks.outboxCreate).not.toHaveBeenCalled();
    expect(mocks.inviteUpdate).not.toHaveBeenCalled();
  });

  it("queues one email per invite with no secret in it, and marks it sent", async () => {
    const result = await sendClubInvites({}, "admin-1", now);
    expect(result).toEqual({ sent: 1, messageIds: ["message-1"] });
    expect(mocks.inviteFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: "PENDING" }) }));
    const message = mocks.outboxCreate.mock.calls[0][0].data;
    expect(message).toMatchObject({ templateKey: "CLUB_INVITE", recipientEmail: "leader@example.test", eventId: null });
    // Import invites (#376) point at the working sign-up page, email prefilled, not the bare account page.
    expect(message.bodyTextSnapshot).toContain("https://events.imsda.test/account/sign-up#email=leader%40example.test");
    expect(message.bodyTextSnapshot).not.toMatch(/token=/);
    expect(mocks.inviteUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "SENT", lastMessageId: "message-1" }) }));
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "CLUB_INVITES_SENT", metadata: { count: 1, organizationIds: ["club-1"] } }));
  });

  it("refuses when nothing is waiting", async () => {
    mocks.inviteFindMany.mockResolvedValue([]);
    await expect(sendClubInvites({ organizationId: "club-1" }, "admin-1", now)).rejects.toMatchObject({ code: "NOTHING_TO_SEND" });
  });

  it("doesn't give a staff import invite the 14-day expiry (#425): it reuses this flow but had no expiry", async () => {
    await sendClubInvites({}, "admin-1", now);
    expect(mocks.inviteUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ expiresAt: null }) }));
    const message = mocks.outboxCreate.mock.calls[0][0].data;
    expect(message.bodyTextSnapshot).not.toMatch(/expires/i);
  });
});

describe("accepting a club invite", () => {
  it("gives the invited role to the account whose verified email matches", async () => {
    await expect(acceptClubInvite("invite-1", account, now)).resolves.toEqual({ organizationId: "club-1" });
    expect(mocks.grantCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ organizationId: "club-1", attendeeAccountId: "account-1", role: "DIRECTOR", grantedByUserId: "admin-1" }),
      select: { id: true },
    });
    expect(mocks.inviteUpdateMany).toHaveBeenCalledWith({
      where: { id: "invite-1", status: "SENT" },
      data: expect.objectContaining({ status: "ACCEPTED", acceptedAccountId: "account-1" }),
    });
  });

  it("accepts an invite that never expires (expiresAt: null, #425)", async () => {
    mocks.inviteFindUnique.mockResolvedValue({ ...sentInvite, expiresAt: null });
    await expect(acceptClubInvite("invite-1", account, now)).resolves.toEqual({ organizationId: "club-1" });
    expect(mocks.grantCreate).toHaveBeenCalled();
  });

  it("looks missing to anyone else", async () => {
    await expect(acceptClubInvite("invite-1", { id: "account-2", verifiedEmail: "other@example.test" }, now)).rejects.toMatchObject({ code: "INVITE_NOT_FOUND" });
    expect(mocks.grantCreate).not.toHaveBeenCalled();
  });

  it("can't be accepted before an administrator sends it", async () => {
    mocks.inviteFindUnique.mockResolvedValue({ ...sentInvite, status: "PENDING" });
    await expect(acceptClubInvite("invite-1", account, now)).rejects.toMatchObject({ code: "INVITE_NOT_OPEN" });
  });

  it("doesn't add a second grant for someone who already has a role", async () => {
    mocks.grantFindFirst.mockResolvedValue({ id: "grant-existing" });
    await acceptClubInvite("invite-1", account, now);
    expect(mocks.grantCreate).not.toHaveBeenCalled();
    expect(mocks.inviteUpdateMany).toHaveBeenCalled();
  });

  it("refuses an expired invite (#425)", async () => {
    mocks.inviteFindUnique.mockResolvedValue({ ...sentInvite, expiresAt: new Date("2026-09-01T00:00:00Z") });
    await expect(acceptClubInvite("invite-1", account, now)).rejects.toMatchObject({ code: "INVITE_EXPIRED" });
    expect(mocks.grantCreate).not.toHaveBeenCalled();
  });

  it("gives a club-created invite's expiry message club-specific wording (#425)", async () => {
    mocks.inviteFindUnique.mockResolvedValue({ ...sentInvite, role: "REGISTRAR", source: "CLUB", expiresAt: new Date("2026-09-01T00:00:00Z") });
    await expect(acceptClubInvite("invite-1", account, now)).rejects.toMatchObject({ code: "INVITE_EXPIRED", message: expect.stringContaining("club director") });
  });

  it("gives a staff-import invite's expiry message its own wording (#425)", async () => {
    mocks.inviteFindUnique.mockResolvedValue({ ...sentInvite, source: "IMPORT", expiresAt: new Date("2026-09-01T00:00:00Z") });
    await expect(acceptClubInvite("invite-1", account, now)).rejects.toMatchObject({ code: "INVITE_EXPIRED", message: expect.stringContaining("registrar") });
  });

  it("accepts right up to its expiry", async () => {
    mocks.inviteFindUnique.mockResolvedValue({ ...sentInvite, expiresAt: new Date("2026-09-30T00:00:00Z") });
    await expect(acceptClubInvite("invite-1", account, now)).resolves.toEqual({ organizationId: "club-1" });
  });

  it("refuses a club-created invite whose role is no longer club-assignable (#425)", async () => {
    mocks.inviteFindUnique.mockResolvedValue({ ...sentInvite, role: "DEPUTY", source: "CLUB" });
    await expect(acceptClubInvite("invite-1", account, now)).rejects.toMatchObject({ code: "INVITE_ROLE_NOT_ALLOWED" });
    expect(mocks.grantCreate).not.toHaveBeenCalled();
  });

  it("serializes a race between two concurrent accepts: the guarded update losing means no grant or audit (#425)", async () => {
    mocks.inviteUpdateMany.mockResolvedValue({ count: 0 });
    await expect(acceptClubInvite("invite-1", account, now)).rejects.toMatchObject({ code: "INVITE_NOT_OPEN" });
    expect(mocks.grantCreate).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("needs the person's own sign-in", async () => {
    mocks.getCurrentAttendee.mockResolvedValue({ account: { ...account, displayName: "Pat" }, via: "staff", sessionId: null });
    const response = await ACCEPT(new Request("https://events.imsda.test/api/attendee/club-invites/invite-1/accept", {
      method: "POST", headers: { origin: "https://events.imsda.test" }, body: "{}",
    }), { params: Promise.resolve({ inviteId: "invite-1" }) });
    expect(response.status).toBe(401);
    expect(mocks.grantCreate).not.toHaveBeenCalled();
  });
});

describe("the sign-up link a club invite's email carries (#434)", () => {
  it("is built from APP_BASE_URL and the sign-up route, with the invited address prefilled and no token", () => {
    const url = clubInviteSignUpUrl("New.Helper@Example.test");
    expect(url).toBe("https://events.imsda.test/account/sign-up#email=new.helper%40example.test");
    expect(url).not.toMatch(/[?&]token=/);
  });

  it("normalizes the address the same way an invite matches one", () => {
    // Leading/trailing space and case shouldn't produce a different link for the same address.
    expect(clubInviteSignUpUrl("  Leader@Example.test  ")).toBe(clubInviteSignUpUrl("leader@example.test"));
  });
});

describe("club team invites (#425)", () => {
  it("creates and sends an invite for someone with no account yet", async () => {
    const result = await createClubTeamInvite("club-1", { email: "New.Helper@Example.test", role: "REGISTRAR" }, { accountId: "account-1" }, now);
    expect(result).toEqual({ inviteId: "invite-2", messageId: "message-1" });
    expect(mocks.inviteCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        organizationId: "club-1",
        email: "new.helper@example.test",
        role: "REGISTRAR",
        source: "CLUB",
        createdByAccountId: "account-1",
        status: "SENT",
      }),
    }));
    const message = mocks.outboxCreate.mock.calls[0][0].data;
    expect(message).toMatchObject({ templateKey: "CLUB_INVITE", recipientEmail: "new.helper@example.test" });
    // Club-created invites (#425) get the same working sign-up link as import invites.
    expect(message.bodyTextSnapshot).toContain("https://events.imsda.test/account/sign-up#email=new.helper%40example.test");
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "CLUB_INVITE_CREATED",
      metadata: { organizationId: "club-1", role: "REGISTRAR", actorAttendeeAccountId: "account-1" },
    }), client);
  });

  it("only lets a club invite a Registrar or Reporter", async () => {
    await expect(createClubTeamInvite("club-1", { email: "x@example.test", role: "DEPUTY" as never }, { accountId: "account-1" }, now))
      .rejects.toMatchObject({ code: "INVITE_ROLE_NOT_ALLOWED" });
    expect(mocks.inviteCreate).not.toHaveBeenCalled();
  });

  it("won't open a second invite for the same email", async () => {
    mocks.inviteFindFirst.mockResolvedValue({ id: "invite-open" });
    await expect(createClubTeamInvite("club-1", { email: "helper@example.test", role: "REGISTRAR" }, { accountId: "account-1" }, now))
      .rejects.toMatchObject({ code: "INVITE_ALREADY_OPEN" });
    expect(mocks.inviteFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ role: { in: ["REGISTRAR", "REPORTER"] } }),
    }));
  });

  it("doesn't let a pending staff-import invite for the same email invisibly block a club invite (#425)", async () => {
    // The duplicate check is scoped to club-assignable roles, so an IMPORT invite for
    // this email (always DIRECTOR/DEPUTY) never matches it.
    mocks.inviteFindFirst.mockResolvedValue(null);
    await expect(createClubTeamInvite("club-1", { email: "helper@example.test", role: "REGISTRAR" }, { accountId: "account-1" }, now))
      .resolves.toMatchObject({ inviteId: "invite-2" });
  });

  it("lists only sent, club-assignable invites", async () => {
    mocks.inviteFindMany.mockResolvedValue([
      { id: "invite-1", email: "a@example.test", name: "", role: "REGISTRAR", status: "SENT", sentAt: now, sentCount: 1, expiresAt: new Date("2026-10-07T15:00:00Z") },
    ]);
    const invites = await listPendingClubTeamInvites("club-1", now);
    expect(invites).toEqual([{
      id: "invite-1", email: "a@example.test", name: "", role: "REGISTRAR",
      sentAt: now.toISOString(), sentCount: 1, expiresAt: "2026-10-07T15:00:00.000Z", expired: false,
    }]);
    expect(mocks.inviteFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { organizationId: "club-1", status: "SENT", role: { in: ["REGISTRAR", "REPORTER"] } },
    }));
  });

  it("resends with a fresh expiry, rate-limited", async () => {
    mocks.inviteFindFirst.mockResolvedValue({
      id: "invite-1", email: "a@example.test", name: "", role: "REGISTRAR", status: "SENT",
      sentAt: new Date(now.getTime() - 10 * 60_000),
      organization: { name: "Example Pathfinders", isActive: true },
    });
    const result = await resendClubTeamInvite("club-1", "invite-1", { accountId: "account-1" }, now);
    expect(result).toEqual({ messageId: "message-1" });
    expect(mocks.inviteUpdateMany).toHaveBeenCalledWith({
      where: { id: "invite-1", status: { in: ["PENDING", "SENT"] } },
      data: expect.objectContaining({ status: "SENT", sentCount: { increment: 1 }, expiresAt: clubInviteExpiry(now) }),
    });
    expect(mocks.inviteUpdate).toHaveBeenCalledWith({ where: { id: "invite-1" }, data: { lastMessageId: "message-1" } });
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "CLUB_INVITE_RESENT" }), client);
  });

  it("refuses to resend too soon after the last send", async () => {
    mocks.inviteFindFirst.mockResolvedValue({
      id: "invite-1", email: "a@example.test", name: "", role: "REGISTRAR", status: "SENT",
      sentAt: new Date(now.getTime() - 60_000),
      organization: { name: "Example Pathfinders", isActive: true },
    });
    await expect(resendClubTeamInvite("club-1", "invite-1", { accountId: "account-1" }, now)).rejects.toMatchObject({ code: "INVITE_RESEND_TOO_SOON" });
    expect(mocks.outboxCreate).not.toHaveBeenCalled();
    expect(mocks.inviteUpdateMany).not.toHaveBeenCalled();
  });

  it("won't resend or cancel a director/deputy invite from the club side", async () => {
    mocks.inviteFindFirst.mockResolvedValue({
      id: "invite-1", email: "a@example.test", name: "", role: "DIRECTOR", status: "SENT", sentAt: null,
      organization: { name: "Example Pathfinders", isActive: true },
    });
    await expect(resendClubTeamInvite("club-1", "invite-1", { accountId: "account-1" }, now)).rejects.toMatchObject({ code: "INVITE_ROLE_NOT_ALLOWED" });
    mocks.inviteFindFirst.mockResolvedValue({ id: "invite-1", status: "SENT", role: "DIRECTOR" });
    await expect(cancelClubTeamInvite("club-1", "invite-1", { accountId: "account-1" }, now)).rejects.toMatchObject({ code: "INVITE_ROLE_NOT_ALLOWED" });
  });

  it("an invite id from another club isn't found (404) on resend", async () => {
    mocks.inviteFindFirst.mockResolvedValue(null);
    await expect(resendClubTeamInvite("club-1", "invite-other-club", { accountId: "account-1" }, now)).rejects.toMatchObject({ code: "INVITE_NOT_FOUND" });
    expect(mocks.inviteFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "invite-other-club", organizationId: "club-1" }),
    }));
    expect(mocks.inviteUpdateMany).not.toHaveBeenCalled();
  });

  it("serializes a race between two concurrent resends: the guarded update losing means no email or audit (#425)", async () => {
    mocks.inviteFindFirst.mockResolvedValue({
      id: "invite-1", email: "a@example.test", name: "", role: "REGISTRAR", status: "SENT",
      sentAt: new Date(now.getTime() - 10 * 60_000),
      organization: { name: "Example Pathfinders", isActive: true },
    });
    mocks.inviteUpdateMany.mockResolvedValue({ count: 0 });
    await expect(resendClubTeamInvite("club-1", "invite-1", { accountId: "account-1" }, now)).rejects.toMatchObject({ code: "INVITE_NOT_OPEN" });
    expect(mocks.outboxCreate).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("cancels a pending invite", async () => {
    mocks.inviteFindFirst.mockResolvedValue({ id: "invite-1", status: "SENT", role: "REPORTER" });
    await cancelClubTeamInvite("club-1", "invite-1", { accountId: "account-1" }, now);
    expect(mocks.inviteUpdateMany).toHaveBeenCalledWith({
      where: { id: "invite-1", status: { in: ["PENDING", "SENT"] } },
      data: expect.objectContaining({ status: "CANCELLED" }),
    });
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "CLUB_INVITE_CANCELLED" }), client);
  });

  it("won't cancel an invite that's already accepted", async () => {
    mocks.inviteFindFirst.mockResolvedValue({ id: "invite-1", status: "ACCEPTED", role: "REPORTER" });
    await expect(cancelClubTeamInvite("club-1", "invite-1", { accountId: "account-1" }, now)).rejects.toMatchObject({ code: "INVITE_NOT_OPEN" });
    expect(mocks.inviteUpdateMany).not.toHaveBeenCalled();
  });

  it("an invite id from another club isn't found (404) on cancel", async () => {
    mocks.inviteFindFirst.mockResolvedValue(null);
    await expect(cancelClubTeamInvite("club-1", "invite-other-club", { accountId: "account-1" }, now)).rejects.toMatchObject({ code: "INVITE_NOT_FOUND" });
    expect(mocks.inviteFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "invite-other-club", organizationId: "club-1" }),
    }));
    expect(mocks.inviteUpdateMany).not.toHaveBeenCalled();
  });

  it("serializes a race between a cancel and a resend: the guarded update losing means no audit (#425)", async () => {
    mocks.inviteFindFirst.mockResolvedValue({ id: "invite-1", status: "SENT", role: "REPORTER" });
    mocks.inviteUpdateMany.mockResolvedValue({ count: 0 });
    await expect(cancelClubTeamInvite("club-1", "invite-1", { accountId: "account-1" }, now)).rejects.toMatchObject({ code: "INVITE_NOT_OPEN" });
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });
});

describe("listing invites for an account (#425)", () => {
  it("excludes expired invites", async () => {
    await listInvitesForAccount("leader@example.test", now);
    expect(mocks.inviteFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: "SENT",
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      }),
    }));
  });
});
