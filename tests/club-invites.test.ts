import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  writeAuditLog: vi.fn(),
  configured: vi.fn(),
  inviteFindMany: vi.fn(),
  inviteFindUnique: vi.fn(),
  inviteUpdate: vi.fn(),
  outboxCreate: vi.fn(),
  grantFindFirst: vi.fn(),
  grantCreate: vi.fn(),
  getCurrentAttendee: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
}));

const client = {
  clubInvite: { findMany: mocks.inviteFindMany, findUnique: mocks.inviteFindUnique, update: mocks.inviteUpdate },
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
import { acceptClubInvite, sendClubInvites } from "@/modules/club-imports/invites";

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
    expect(message.bodyTextSnapshot).toContain("https://events.imsda.test/account");
    expect(message.bodyTextSnapshot).not.toMatch(/token=/);
    expect(mocks.inviteUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "SENT", lastMessageId: "message-1" }) }));
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "CLUB_INVITES_SENT", metadata: { count: 1, organizationIds: ["club-1"] } }));
  });

  it("refuses when nothing is waiting", async () => {
    mocks.inviteFindMany.mockResolvedValue([]);
    await expect(sendClubInvites({ organizationId: "club-1" }, "admin-1", now)).rejects.toMatchObject({ code: "NOTHING_TO_SEND" });
  });
});

describe("accepting a club invite", () => {
  it("gives the invited role to the account whose verified email matches", async () => {
    await expect(acceptClubInvite("invite-1", account, now)).resolves.toEqual({ organizationId: "club-1" });
    expect(mocks.grantCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ organizationId: "club-1", attendeeAccountId: "account-1", role: "DIRECTOR", grantedByUserId: "admin-1" }),
      select: { id: true },
    });
    expect(mocks.inviteUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "ACCEPTED", acceptedAccountId: "account-1" }) }));
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
    expect(mocks.inviteUpdate).toHaveBeenCalled();
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
