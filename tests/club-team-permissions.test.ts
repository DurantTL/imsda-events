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

type Row = { id: string; registrationAttendeeId: string; status: "PENDING" | "GRANTED" | "DECLINED"; ageOnAgeDate: number };

function database(options: { existing?: Row[]; coordinator?: boolean; staff?: Array<{ email: string; displayName: string }> } = {}) {
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
          coordinator: options.coordinator === false ? null : { email: "ac@example.test", displayName: "Alex Coordinator", disabledAt: null, areaCoordinatorGrant: { revokedAt: null, expiresAt: null } },
        },
        clubRegistration: { teamName: "Bible Bees", organization: { name: "Test Pathfinders" } },
      }),
    },
    eventTeamSettings: { findUnique: vi.fn().mockResolvedValue({ ageAsOf: "2026-01-01" }) },
    eventMessageSettings: { findUnique: vi.fn().mockResolvedValue({ deliveryMode: "LOCAL_CAPTURE", senderName: "IMSDA Events", senderEmail: null, replyToEmail: null }) },
    eventMembership: { findMany: vi.fn().mockResolvedValue((options.staff ?? []).map((user) => ({ user }))) },
    messageOutbox: { upsert: vi.fn().mockImplementation(async ({ create }: { create: { recipientEmail: string; status: string } }) => ({ id: `msg-${create.recipientEmail}`, status: create.status })) },
  };
  return tx;
}

const person = (attendeeId: string, name: string, age: number | null, role: "MEMBER" | "COACH" = "MEMBER") => ({ attendeeId, name, age, role });
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
    const tx = database({ existing: [{ id: "perm-a", registrationAttendeeId: "a", status: "GRANTED", ageOnAgeDate: 18 }] });
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

  it("clears the flag when the person becomes a coach, and audits it", async () => {
    const tx = database({ existing: [{ id: "perm-a", registrationAttendeeId: "a", status: "PENDING", ageOnAgeDate: 18 }] });
    await run(tx, [person("a", "Alex One", 18, "COACH")]);
    expect(tx.clubTeamMemberPermission.delete).toHaveBeenCalledWith({ where: { id: "perm-a" } });
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "CLUB_TEAM_PERMISSION_CLEARED" }), tx);
  });

  it("reports a declined person who is still a team member", async () => {
    const tx = database({ existing: [{ id: "perm-a", registrationAttendeeId: "a", status: "DECLINED", ageOnAgeDate: 18 }] });
    const result = await run(tx, [person("a", "Alex One", 18)]);
    expect(result.declined).toEqual(["Alex One"]);
  });
});

describe("deciding a permission (#809)", () => {
  const found = {
    id: "perm-a", eventId: "event-1", clubEventRegistrationId: "cer-1", status: "PENDING", ageOnAgeDate: 18, decidedAt: null,
    decidedByUser: null, decidedByAccount: null,
    attendee: { profileSnapshot: { firstName: "Alex", lastName: "One" } },
    clubEventRegistration: { registrationId: "reg-1", teamName: "Bible Bees", organization: { name: "Test Pathfinders" }, registration: { location: { name: "Iowa" }, event: { name: "Synthetic PBE" } } },
  };
  function decideDatabase(options: { first?: unknown } = {}) {
    const tx = {
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
    expect(permissionShortLabel("PENDING")).toBe("AC permission: pending");
    expect(permissionShortLabel("GRANTED")).toBe("AC permission: granted");
  });
});
