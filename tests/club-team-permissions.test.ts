import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  writeAuditLog: vi.fn(),
  processQueuedMessageIdsAfterCommit: vi.fn(),
  requirePermission: vi.fn(),
  getCurrentSession: vi.fn(),
  currentAreaCoordinator: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/lib/env", () => ({ getServerEnv: () => ({ APP_BASE_URL: "https://events.imsda.test" }) }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/communications/messaging-repository", () => ({ processQueuedMessageIdsAfterCommit: mocks.processQueuedMessageIdsAfterCommit }));
vi.mock("@/modules/access/authorization", () => ({
  requirePermission: mocks.requirePermission,
  AccessDeniedError: class extends Error { constructor(message: string, public status: number, public code: string) { super(message); } },
}));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: () => null }));
vi.mock("@/modules/events/repository", () => ({ findActiveMembership: vi.fn() }));
vi.mock("@/modules/organizations/area-coordinators", () => ({ currentAreaCoordinator: mocks.currentAreaCoordinator, currentAreaCoordinatorViewerActive: vi.fn() }));

import { decideTeamPermission, syncTeamMemberPermissions } from "@/modules/club-teams/permission-repository";
import { permissionNotice, permissionPendingNotice, permissionShortLabel } from "@/modules/club-teams/permission-domain";
import { PUT as staffPut } from "@/app/api/events/[eventId]/team-permissions/[permissionId]/route";
import { PUT as coordinatorPut } from "@/app/api/attendee/area-clubs/team-permissions/[permissionId]/route";

type Row = { id: string; personId: string; registrationAttendeeId: string | null; active: boolean; status: "PENDING" | "GRANTED" | "DECLINED"; ageOnAgeDate: number };
const row = (attendeeId: string, status: Row["status"], extra: Partial<Row> = {}): Row => ({ id: `perm-${attendeeId}`, personId: `person-${attendeeId}`, registrationAttendeeId: attendeeId, active: true, status, ageOnAgeDate: 18, ...extra });

function database(options: { existing?: Row[]; coordinator?: boolean; coordinatorDirectsClub?: boolean; staff?: Array<{ email: string; displayName: string }> } = {}) {
  const tx = {
    clubTeamMemberPermission: {
      findMany: vi.fn().mockResolvedValue(options.existing ?? []),
      create: vi.fn().mockImplementation(async ({ data }: { data: { registrationAttendeeId: string } }) => ({ id: `perm-${data.registrationAttendeeId}` })),
      update: vi.fn(),
      delete: vi.fn(),
    },
    registration: {
      findUnique: vi.fn().mockResolvedValue({
        confirmationCode: "PBE-1",
        event: { name: "Synthetic PBE" },
        location: {
          name: "Iowa",
          coordinator: options.coordinator === false ? null : { id: "acct-ac", email: "ac@example.test", displayName: "Alex Coordinator", disabledAt: null, areaCoordinatorGrant: { revokedAt: null, expiresAt: null } },
        },
        clubRegistration: { teamName: "Bible Bees", organizationId: "club-1", organization: { name: "Test Pathfinders" } },
      }),
    },
    clubDirectorGrant: { findFirst: vi.fn().mockResolvedValue(options.coordinatorDirectsClub ? { id: "grant-1" } : null) },
    eventTeamSettings: { findUnique: vi.fn().mockResolvedValue({ ageAsOf: "2026-01-01" }) },
    eventMessageSettings: { findUnique: vi.fn().mockResolvedValue({ deliveryMode: "LOCAL_CAPTURE", senderName: "IMSDA Events", senderEmail: null, replyToEmail: null }) },
    eventMembership: { findMany: vi.fn().mockResolvedValue((options.staff ?? []).map((user) => ({ user }))) },
    messageOutbox: { upsert: vi.fn().mockImplementation(async ({ create }: { create: { recipientEmail: string; status: string } }) => ({ id: `msg-${create.recipientEmail}`, status: create.status })) },
  };
  return tx;
}

const person = (attendeeId: string, name: string, age: number | null, role: "MEMBER" | "COACH" = "MEMBER", personId = `person-${attendeeId}`): { attendeeId: string; personId: string; name: string; age: number | null; role: "MEMBER" | "COACH"; tlt?: boolean } => ({ attendeeId, personId, name, age, role });
const input = (people: ReturnType<typeof person>[]) => ({ eventId: "event-1", clubEventRegistrationId: "cer-1", registrationId: "reg-1", people });
const run = (tx: ReturnType<typeof database>, people: ReturnType<typeof person>[]) => syncTeamMemberPermissions(tx as never, input(people));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("flagging team members of 18 or older (#809)", () => {
  it("flags an 18-year-old team member as pending, audits it, and asks the location's Area Coordinator", async () => {
    const tx = database();
    const result = await run(tx, [person("a", "Alex One", 18), person("b", "Blake Two", 14)]);
    expect(tx.clubTeamMemberPermission.create).toHaveBeenCalledTimes(1);
    expect(tx.clubTeamMemberPermission.create.mock.calls[0]![0].data).toMatchObject({ registrationAttendeeId: "a", ageOnAgeDate: 18, eventId: "event-1" });
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "CLUB_TEAM_PERMISSION_REQUESTED" }), tx);
    expect(tx.messageOutbox.upsert).toHaveBeenCalledTimes(1);
    const message = tx.messageOutbox.upsert.mock.calls[0]![0].create;
    expect(message).toMatchObject({ recipientEmail: "ac@example.test", templateKey: "TEAM_PERMISSION_REQUEST", recipientKind: "INTERNAL", eventId: "event-1" });
    expect(message.bodyTextSnapshot).toContain("Alex One (18)");
    expect(message.bodyTextSnapshot).not.toContain("Blake Two");
    expect(message.bodyTextSnapshot).toContain("/account/area-clubs/team-permissions");
    expect(result).toEqual({ declined: [], queuedMessageIds: ["msg-ac@example.test"] });
  });

  it("does not flag a 17-year-old or a coach, whatever their age", async () => {
    const tx = database();
    const result = await run(tx, [person("a", "Alex One", 17), person("b", "Coach Two", 40, "COACH"), person("c", "Casey Three", null)]);
    expect(tx.clubTeamMemberPermission.create).not.toHaveBeenCalled();
    expect(tx.messageOutbox.upsert).not.toHaveBeenCalled();
    expect(result.queuedMessageIds).toEqual([]);
  });

  it("goes to event staff who manage registrations when no active Area Coordinator is set", async () => {
    const tx = database({ coordinator: false, staff: [{ email: "staff@example.test", displayName: "Sam Staff" }] });
    await run(tx, [person("a", "Alex One", 19)]);
    expect(tx.eventMembership.findMany.mock.calls[0]![0].where).toMatchObject({ eventId: "event-1", status: "ACTIVE" });
    const message = tx.messageOutbox.upsert.mock.calls[0]![0].create;
    expect(message.recipientEmail).toBe("staff@example.test");
    expect(message.bodyTextSnapshot).toContain("/more/team-results?event=event-1");
  });

  it("does not ask again for someone already flagged, and keeps a granted flag", async () => {
    const tx = database({ existing: [row("a", "GRANTED")] });
    const result = await run(tx, [person("a", "Alex One", 18)]);
    expect(tx.clubTeamMemberPermission.create).not.toHaveBeenCalled();
    expect(tx.clubTeamMemberPermission.update).not.toHaveBeenCalled();
    expect(tx.clubTeamMemberPermission.delete).not.toHaveBeenCalled();
    expect(tx.messageOutbox.upsert).not.toHaveBeenCalled();
    expect(result.declined).toEqual([]);
  });

  it("makes one message for everyone newly flagged in one change", async () => {
    const tx = database();
    await run(tx, [person("a", "Alex One", 18), person("b", "Blake Two", 19)]);
    expect(tx.messageOutbox.upsert).toHaveBeenCalledTimes(1);
    expect(tx.messageOutbox.upsert.mock.calls[0]![0].create.bodyTextSnapshot).toMatch(/Alex One \(18\)[\s\S]*Blake Two \(19\)/);
  });

  it("deletes a pending flag when the person becomes a coach, and audits it with who acted", async () => {
    const tx = database({ existing: [row("a", "PENDING")] });
    await syncTeamMemberPermissions(tx as never, { ...input([person("a", "Alex One", 18, "COACH")]), actor: { accountId: "acct-director" } });
    expect(tx.clubTeamMemberPermission.delete).toHaveBeenCalledWith({ where: { id: "perm-a" } });
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "CLUB_TEAM_PERMISSION_CLEARED", metadata: expect.objectContaining({ kept: false, actorAccountId: "acct-director" }) }), tx);
  });

  it("keeps a granted or declined decision, inactive, when the person becomes a coach or leaves", async () => {
    for (const status of ["GRANTED", "DECLINED"] as const) {
      const tx = database({ existing: [row("a", status)] });
      await run(tx, [person("a", "Alex One", 18, "COACH")]);
      expect(tx.clubTeamMemberPermission.delete).not.toHaveBeenCalled();
      expect(tx.clubTeamMemberPermission.update).toHaveBeenCalledWith({ where: { id: "perm-a" }, data: { active: false, registrationAttendeeId: null } });
      expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "CLUB_TEAM_PERMISSION_CLEARED", metadata: expect.objectContaining({ kept: true }) }), tx);
      const gone = database({ existing: [row("a", status)] });
      await run(gone, []);
      expect(gone.clubTeamMemberPermission.delete).not.toHaveBeenCalled();
      expect(gone.clubTeamMemberPermission.update).toHaveBeenCalledWith({ where: { id: "perm-a" }, data: { active: false, registrationAttendeeId: null } });
    }
  });

  it("does not touch a decision that is already inactive while the person is still not on the team", async () => {
    const tx = database({ existing: [row("a", "DECLINED", { active: false, registrationAttendeeId: null })] });
    await run(tx, [person("a", "Alex One", 18, "COACH")]);
    expect(tx.clubTeamMemberPermission.update).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("brings a declined person back as declined when they are a team member of 18 or over again, and asks nobody", async () => {
    const tx = database({ existing: [row("a", "DECLINED", { active: false, registrationAttendeeId: null })] });
    // A new attendee row (id "a2") for the same person.
    const result = await run(tx, [person("a2", "Alex One", 18, "MEMBER", "person-a")]);
    expect(tx.clubTeamMemberPermission.create).not.toHaveBeenCalled();
    expect(tx.clubTeamMemberPermission.update).toHaveBeenCalledWith({ where: { id: "perm-a" }, data: { active: true, registrationAttendeeId: "a2", ageOnAgeDate: 18 } });
    expect(result.declined).toEqual([{ name: "Alex One", tlt: false, attendeeId: "a2" }]);
    expect(tx.messageOutbox.upsert).not.toHaveBeenCalled();
  });

  it("brings a granted person back as granted, with no new request", async () => {
    const tx = database({ existing: [row("a", "GRANTED", { active: false, registrationAttendeeId: null })] });
    const result = await run(tx, [person("a2", "Alex One", 18, "MEMBER", "person-a")]);
    expect(tx.clubTeamMemberPermission.create).not.toHaveBeenCalled();
    expect(result.declined).toEqual([]);
    expect(tx.messageOutbox.upsert).not.toHaveBeenCalled();
  });

  it("reports a declined person who is still a team member, and whether they are a TLT", async () => {
    const tx = database({ existing: [row("a", "DECLINED")] });
    const result = await syncTeamMemberPermissions(tx as never, input([{ ...person("a", "Alex One", 18), tlt: true }]));
    expect(result.declined).toEqual([{ name: "Alex One", tlt: true, attendeeId: "a" }]);
  });

  it("emails again for a genuinely new pending flag, because the request is keyed by the new flag's own id", async () => {
    const first = database();
    await run(first, [person("a", "Alex One", 18)]);
    const second = database();
    second.clubTeamMemberPermission.create.mockResolvedValue({ id: "perm-new-flag" });
    await run(second, [person("a", "Alex One", 18)]);
    const keyOf = (tx: ReturnType<typeof database>) => tx.messageOutbox.upsert.mock.calls[0]![0].where.idempotencyKey as string;
    expect(keyOf(first)).toContain("perm-a");
    expect(keyOf(second)).toContain("perm-new-flag");
    expect(keyOf(first)).not.toBe(keyOf(second));
  });

  it("sends the request to event staff, not the coordinator, when the coordinator directs the team's own club", async () => {
    const tx = database({ coordinatorDirectsClub: true, staff: [{ email: "staff@example.test", displayName: "Sam Staff" }] });
    await run(tx, [person("a", "Alex One", 18)]);
    expect(tx.clubDirectorGrant.findFirst.mock.calls[0]![0].where).toMatchObject({ attendeeAccountId: "acct-ac", organizationId: "club-1", revokedAt: null });
    const recipients = tx.messageOutbox.upsert.mock.calls.map(([call]) => call.create.recipientEmail);
    expect(recipients).toEqual(["staff@example.test"]);
  });
});

describe("deciding a permission (#809)", () => {
  const found = {
    id: "perm-a", eventId: "event-1", clubEventRegistrationId: "cer-1", status: "PENDING", ageOnAgeDate: 18, decidedAt: null,
    decidedByUser: null, decidedByAccount: null,
    attendee: { profileSnapshot: { firstName: "Alex", lastName: "One" } },
    clubEventRegistration: { registrationId: "reg-1", teamName: "Bible Bees", organizationId: "club-1", organization: { name: "Test Pathfinders" }, registration: { location: { name: "Iowa" }, event: { name: "Synthetic PBE" } } },
  };
  function decideDatabase(options: { first?: unknown; directsClub?: boolean } = {}) {
    const tx = {
      clubDirectorGrant: { findFirst: vi.fn().mockResolvedValue(options.directsClub ? { id: "grant-1" } : null) },
      clubTeamMemberPermission: {
        findFirst: vi.fn().mockResolvedValue("first" in options ? options.first : found),
        update: vi.fn(),
        findUniqueOrThrow: vi.fn().mockResolvedValue({ ...found, status: "GRANTED", decidedAt: new Date("2026-11-01T12:00:00Z"), decidedByAccount: { displayName: "Alex Coordinator" } }),
      },
    };
    mocks.getPrisma.mockReturnValue({ $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)) });
    return tx;
  }

  it("records who decided and when, and audits the change", async () => {
    const tx = decideDatabase();
    const row = await decideTeamPermission({ permissionId: "perm-a", decision: "GRANTED", actor: { accountId: "acct-1" }, scope: { coordinatorAccountId: "acct-1" }, now: new Date("2026-11-01T12:00:00Z") });
    expect(tx.clubTeamMemberPermission.update.mock.calls[0]![0].data).toMatchObject({ status: "GRANTED", decidedByAccountId: "acct-1", decidedByUserId: null, decidedAt: new Date("2026-11-01T12:00:00Z") });
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "CLUB_TEAM_PERMISSION_GRANTED", metadata: expect.objectContaining({ before: "PENDING", after: "GRANTED", decidedByAccountId: "acct-1" }) }), tx);
    expect(row).toMatchObject({ status: "GRANTED", decidedBy: "Alex Coordinator" });
  });

  it("does not let an Area Coordinator who directs the team's own club decide its flags, and never touches the row", async () => {
    const tx = decideDatabase({ directsClub: true });
    await expect(decideTeamPermission({ permissionId: "perm-a", decision: "GRANTED", actor: { accountId: "acct-1" }, scope: { coordinatorAccountId: "acct-1" } })).rejects.toMatchObject({ code: "REGISTRATION_NOT_FOUND" });
    expect(tx.clubTeamMemberPermission.update).not.toHaveBeenCalled();
    // Staff of the event still decide it.
    const staffTx = decideDatabase({ directsClub: true });
    await decideTeamPermission({ permissionId: "perm-a", decision: "GRANTED", actor: { userId: "user-1" }, scope: { eventId: "event-1" } });
    expect(staffTx.clubTeamMemberPermission.update).toHaveBeenCalled();
  });

  it("only decides flags that are active", async () => {
    const tx = decideDatabase();
    await decideTeamPermission({ permissionId: "perm-a", decision: "GRANTED", actor: { userId: "user-1" }, scope: { eventId: "event-1" } });
    expect(tx.clubTeamMemberPermission.findFirst.mock.calls[0]![0].where).toMatchObject({ active: true });
  });

  it("limits an Area Coordinator to teams at their own locations, and staff to their event", async () => {
    const coordinatorTx = decideDatabase({ first: null });
    await expect(decideTeamPermission({ permissionId: "perm-a", decision: "GRANTED", actor: { accountId: "acct-2" }, scope: { coordinatorAccountId: "acct-2" } })).rejects.toMatchObject({ code: "REGISTRATION_NOT_FOUND" });
    expect(coordinatorTx.clubTeamMemberPermission.findFirst.mock.calls[0]![0].where.clubEventRegistration.registration.location.is.coordinatorAccountId).toBe("acct-2");
    expect(coordinatorTx.clubTeamMemberPermission.update).not.toHaveBeenCalled();
    const staffTx = decideDatabase();
    await decideTeamPermission({ permissionId: "perm-a", decision: "DECLINED", actor: { userId: "user-1" }, scope: { eventId: "event-1" } });
    expect(staffTx.clubTeamMemberPermission.findFirst.mock.calls[0]![0].where).toMatchObject({ id: "perm-a", eventId: "event-1" });
    expect(staffTx.clubTeamMemberPermission.update.mock.calls[0]![0].data).toMatchObject({ status: "DECLINED", decidedByUserId: "user-1", decidedByAccountId: null });
  });
});

describe("the permission routes (#809)", () => {
  const request = (body: unknown) => new Request("https://events.imsda.test/api/x", { method: "PUT", headers: { "content-type": "application/json", origin: "https://events.imsda.test" }, body: JSON.stringify(body) });

  it("lets staff with registration permission decide, and refuses a staff member without it", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: { id: "user-1" } });
    mocks.requirePermission.mockResolvedValue({ user: { id: "user-1" } });
    decideDatabase();
    const ok = await staffPut(request({ decision: "GRANTED" }), { params: Promise.resolve({ eventId: "event-1", permissionId: "perm-a" }) });
    expect(ok.status).toBe(200);
    expect(mocks.requirePermission).toHaveBeenCalledWith(expect.anything(), "event-1", "MANAGE_REGISTRATION", expect.anything());
    const { AccessDeniedError } = await import("@/modules/access/authorization");
    mocks.requirePermission.mockRejectedValue(new AccessDeniedError("No.", 403, "PERMISSION_DENIED"));
    const refused = await staffPut(request({ decision: "GRANTED" }), { params: Promise.resolve({ eventId: "event-1", permissionId: "perm-a" }) });
    expect(refused.status).toBe(403);
  });

  it("answers 404 to anyone who is not an Area Coordinator, and 400 to a bad decision", async () => {
    mocks.currentAreaCoordinator.mockResolvedValue(null);
    expect((await coordinatorPut(request({ decision: "GRANTED" }), { params: Promise.resolve({ permissionId: "perm-a" }) })).status).toBe(404);
    mocks.currentAreaCoordinator.mockResolvedValue({ id: "acct-1" });
    expect((await coordinatorPut(request({ decision: "MAYBE" }), { params: Promise.resolve({ permissionId: "perm-a" }) })).status).toBe(400);
  });

  function decideDatabase() {
    const found = {
      id: "perm-a", eventId: "event-1", clubEventRegistrationId: "cer-1", status: "PENDING", ageOnAgeDate: 18, decidedAt: null, decidedByUser: null, decidedByAccount: null,
      attendee: { profileSnapshot: { firstName: "Alex", lastName: "One" } },
      clubEventRegistration: { registrationId: "reg-1", teamName: "Bible Bees", organization: { name: "Test Pathfinders" }, registration: { location: null, event: { name: "Synthetic PBE" } } },
    };
    const tx = { clubTeamMemberPermission: { findFirst: vi.fn().mockResolvedValue(found), update: vi.fn(), findUniqueOrThrow: vi.fn().mockResolvedValue({ ...found, status: "GRANTED" }) } };
    mocks.getPrisma.mockReturnValue({ $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)) });
  }
});

describe("permission wording (#809)", () => {
  it("says what Caleb's rule says, per status, and short for the form", () => {
    expect(permissionPendingNotice("Alex One")).toBe("Alex One is 18 or older. Team members 18 and over need permission from the Area Coordinator. Your team is registered, and the Area Coordinator has been asked to review it.");
    expect(permissionNotice("GRANTED", "Alex One")).toContain("Permission granted");
    expect(permissionNotice("DECLINED", "Alex One")).toContain("coach or remove them");
    expect(permissionNotice("DECLINED", "Alex One", true)).toContain("Remove them or replace them with another team member");
    expect(permissionNotice("DECLINED", "Alex One", true)).not.toContain("coach");
    expect(permissionShortLabel("PENDING")).toBe("AC permission: pending");
    expect(permissionShortLabel("GRANTED")).toBe("AC permission: granted");
  });
});
