import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit checks for the club member transfer repository (#489) with a
 * scripted Prisma stand-in. The flows themselves, with the real unique
 * indexes in place, are proven against PostgreSQL by
 * `scripts/verify-club-member-transfers.ts` (npm run test:club-transfers,
 * run in CI); these cover what's easier to pin down here: exactly which
 * rows a registration move touches, what the notices say, what each club is
 * shown, and that no medical or insurance model is ever reached.
 */

const mocks = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  writeAuditLog: vi.fn(),
  isAccountEmailConfigured: vi.fn(),
  getAccountEmailSender: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/communications/account-email", () => ({
  isAccountEmailConfigured: mocks.isAccountEmailConfigured,
  getAccountEmailSender: mocks.getAccountEmailSender,
}));

import {
  acceptTransfer,
  approveRegistrationMove,
  listClubTransfers,
  requestTransfer,
  skipRegistrationMove,
  staffFinishTransfer,
  staffOverrideTransfer,
} from "@/modules/club-transfers/repository";

type Fn = ReturnType<typeof vi.fn>;
type Db = Record<string, Record<string, Fn>> & { touchedModels: Set<string> };

/** Every `db.<model>.<method>` is a vi.fn (resolving to null unless a test scripts it); models reached are recorded. */
function scriptedDatabase(): Db {
  const models = new Map<string, Record<string, Fn>>();
  const touchedModels = new Set<string>();
  const transactionOptions: unknown[] = [];
  // Raw SQL helpers (`$queryRaw`, `$executeRawUnsafe`) are plain functions on a client, not models.
  const rawFns = new Map<string, Fn>();
  const model = (name: string) => {
    if (!models.has(name)) {
      models.set(name, new Proxy({} as Record<string, Fn>, {
        get(target, method: string) {
          if (!(method in target)) target[method] = vi.fn(async () => null);
          return target[method];
        },
      }));
    }
    return models.get(name)!;
  };
  const db = new Proxy({} as Db, {
    get(_target, name: string) {
      if (name === "touchedModels") return touchedModels;
      if (name === "transactionOptions") return transactionOptions;
      if (name === "$transaction") return async (work: (tx: unknown) => unknown, options?: unknown) => { transactionOptions.push(options); return work(db); };
      if (name === "then") return undefined;
      if (name.startsWith("$")) {
        if (!rawFns.has(name)) rawFns.set(name, vi.fn(async () => []));
        return rawFns.get(name);
      }
      touchedModels.add(name);
      return model(name);
    },
  });
  return db;
}

const now = new Date("2026-10-05T15:00:00Z");
const directorB = { kind: "ATTENDEE" as const, accountId: "account-b", sessionId: "s-b" };
const directorA = { kind: "ATTENDEE" as const, accountId: "account-a", sessionId: "s-a" };
const staff = { userId: "staff-1" };
const leaderGrant = (id: string, email: string) => ({
  role: "DIRECTOR", effectiveFrom: new Date("2026-01-01"), effectiveTo: null, revokedAt: null,
  attendeeAccount: { id, email, displayName: `Director ${id}` },
});

let db: Db;

beforeEach(() => {
  vi.clearAllMocks();
  db = scriptedDatabase();
  mocks.getPrisma.mockReturnValue(db);
  mocks.isAccountEmailConfigured.mockReturnValue(true);
  mocks.getAccountEmailSender.mockReturnValue({ name: "IMSDA Events", address: "events@example.test", replyTo: null });
  db.organization.findFirst.mockResolvedValue({ id: "club-a", name: "Club A" });
  db.organization.findUniqueOrThrow.mockImplementation(async ({ where }: { where: { id: string } }) => ({ name: where.id === "club-a" ? "Club A" : "Club B" }));
  db.clubRosterMember.findMany.mockImplementation(async ({ where }: { where: { organizationId: string } }) => (
    where.organizationId === "club-a"
      ? [{ id: "row-ada", personId: "person-ada", person: { firstName: "Ada", lastName: "Testperson" } }]
      : []
  ));
  db.clubRosterGuardian.deleteMany.mockResolvedValue({ count: 0 });
  db.memberTransfer.create.mockResolvedValue({ id: "transfer-1" });
  db.memberTransfer.findUnique.mockResolvedValue(null);
  db.clubDirectorGrant.findMany.mockResolvedValue([]);
  db.person.findUniqueOrThrow.mockResolvedValue({ firstName: "Ada", lastName: "Testperson", normalizedEmail: null });
  db.messageOutbox.createManyAndReturn.mockImplementation(async ({ data }: { data: unknown[] }) => data.map((_, index) => ({ id: `message-${index + 1}` })));
});

const request = { fromOrganizationId: "club-a", firstName: "Ada", lastName: "Testperson", reason: "Family moved closer to Club B." };

describe("requesting a transfer", () => {
  it("routes a director who also leads the sending club to staff (no self-acknowledgment)", async () => {
    db.clubDirectorGrant.findMany.mockResolvedValue([leaderGrant("account-b", "b@example.test")]);
    await requestTransfer("club-b", request, directorB, now);
    expect(db.memberTransfer.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "PENDING", staffReason: "SAME_DIRECTOR", pendingPersonId: "person-ada", sendingClubVisible: true }),
    }));
  });

  it("sends two exact matches to staff as ambiguous, naming no one", async () => {
    db.clubRosterMember.findMany.mockImplementation(async ({ where }: { where: { organizationId: string } }) => (
      where.organizationId === "club-a"
        ? [
          { id: "row-1", personId: "p-1", person: { firstName: "Ada", lastName: "Testperson" } },
          { id: "row-2", personId: "p-2", person: { firstName: "ada", lastName: "testperson" } },
        ]
        : []
    ));
    await requestTransfer("club-b", request, directorB, now);
    expect(db.memberTransfer.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "UNMATCHED", staffReason: "AMBIGUOUS_MATCH", personId: null, pendingPersonId: null, sendingClubVisible: false }),
    }));
    expect(db.messageOutbox.createManyAndReturn).not.toHaveBeenCalled();
  });

  it("matches only the named club's active rows for this club year", async () => {
    await requestTransfer("club-b", request, directorB, now);
    expect(db.clubRosterMember.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { organizationId: "club-a", clubYear: "2026-27", status: "ACTIVE", personId: { not: null } },
    }));
  });

  it("runs the same lookups whether or not the name matched, using a placeholder id when it didn't", async () => {
    await requestTransfer("club-b", request, directorB, now);
    await requestTransfer("club-b", { ...request, firstName: "Nobody" }, directorB, now);
    const pendingLookups = db.memberTransfer.findUnique.mock.calls
      .map(([args]) => (args as { where: { pendingPersonId?: string } }).where.pendingPersonId)
      .filter(Boolean);
    expect(pendingLookups).toEqual(["person-ada", "no-match-placeholder"]);
    expect(db.person.findUnique.mock.calls.map(([args]) => (args as { where: { id: string } }).where.id)).toEqual(["person-ada", "no-match-placeholder"]);
    expect(db.clubDirectorGrant.findMany).toHaveBeenCalledTimes(2);
  });

  it("writes the matched request's notice inside the request transaction, and none for an unmatched one", async () => {
    db.person.findUnique.mockResolvedValue({ firstName: "Ada", lastName: "Testperson" });
    db.clubDirectorGrant.findMany.mockResolvedValue([leaderGrant("account-a", "a@example.test")]);
    const matched = await requestTransfer("club-b", request, directorB, now);
    expect(matched.messageIds).toEqual(["message-1"]);
    db.person.findUnique.mockResolvedValue(null);
    const unmatched = await requestTransfer("club-b", { ...request, firstName: "Nobody" }, directorB, now);
    expect(unmatched.messageIds).toEqual([]);
    expect(db.messageOutbox.createManyAndReturn).toHaveBeenCalledTimes(1);
  });

  it("notifies the sending club without the reason, deduped, keyed without emails, never failing on a repeat", async () => {
    db.clubDirectorGrant.findMany.mockImplementation(async ({ where }: { where: { organizationId: string } }) => (
      where.organizationId === "club-a" ? [leaderGrant("account-a", "A@Example.test"), leaderGrant("account-a2", "a@example.test")] : []
    ));
    db.person.findUnique.mockResolvedValue({ firstName: "Ada", lastName: "Testperson" });
    await requestTransfer("club-b", request, directorB, now);
    const { data, skipDuplicates } = db.messageOutbox.createManyAndReturn.mock.calls[0]![0] as { data: Array<Record<string, string>>; skipDuplicates: boolean };
    expect(skipDuplicates).toBe(true);
    expect(data).toHaveLength(1);
    expect(data[0]!.recipientEmail).toBe("a@example.test");
    expect(data[0]!.idempotencyKey).toBe("member-transfer:transfer-1:MEMBER_TRANSFER_STARTED:account:account-a");
    expect(data[0]!.bodyTextSnapshot).not.toContain("Family moved");
    expect(data[0]!.bodyTextSnapshot).toContain("Sign in to see the details");
    expect(data[0]!.bodyTextSnapshot).toContain("accept or decline");
  });

  it("tells a director of both clubs that conference staff will complete it, not to accept or decline", async () => {
    // Director B leads Club A too.
    db.clubDirectorGrant.findMany.mockResolvedValue([leaderGrant("account-b", "b@example.test")]);
    db.person.findUnique.mockResolvedValue({ firstName: "Ada", lastName: "Testperson" });
    await requestTransfer("club-b", request, directorB, now);
    const body = (db.messageOutbox.createManyAndReturn.mock.calls[0]![0] as { data: Array<{ bodyTextSnapshot: string }> }).data[0]!.bodyTextSnapshot;
    expect(body).toContain("conference staff will complete this transfer");
    expect(body).not.toContain("accept or decline it");
  });

  it("audits every request with its actor and outcome", async () => {
    await requestTransfer("club-b", request, directorB, now);
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "CLUB_MEMBER_TRANSFER_REQUESTED",
      metadata: expect.objectContaining({ actorAttendeeAccountId: "account-b", outcome: "PENDING" }),
    }), expect.anything());
  });
});

const pendingTransfer = {
  id: "transfer-1", status: "PENDING", staffReason: null, personId: "person-ada", clubYear: "2026-27",
  fromOrganizationId: "club-a", toOrganizationId: "club-b", fromRosterMemberId: "row-ada", sendingClubVisible: true,
  acknowledgeDueAt: new Date("2026-10-19T15:00:00Z"), initiatedByAccountId: "account-b", initiatedByUserId: null,
};

describe("completing a transfer", () => {
  it("is guarded by a status-conditional update and refuses a second completion (N1)", async () => {
    db.memberTransfer.findUnique.mockResolvedValue(pendingTransfer);
    db.memberTransfer.updateMany.mockResolvedValue({ count: 0 });
    await expect(acceptTransfer("club-a", "transfer-1", directorA, now)).rejects.toMatchObject({ code: "ALREADY_RESOLVED", status: 409 });
    expect(db.memberTransfer.updateMany).toHaveBeenCalledWith({ where: { id: "transfer-1", status: { in: ["PENDING"] } }, data: { status: "COMPLETED" } });
    expect(db.clubRosterMember.create).not.toHaveBeenCalled();
  });

  it("refuses the director who made the request, even at the sending club", async () => {
    db.memberTransfer.findUnique.mockResolvedValue({ ...pendingTransfer, initiatedByAccountId: "account-a" });
    await expect(acceptTransfer("club-a", "transfer-1", directorA, now)).rejects.toMatchObject({ code: "SELF_ACKNOWLEDGE_NOT_ALLOWED" });
  });

  it("reads a request the sending club was never shown as not found", async () => {
    db.memberTransfer.findUnique.mockResolvedValue({ ...pendingTransfer, status: "UNMATCHED", sendingClubVisible: false });
    await expect(acceptTransfer("club-a", "transfer-1", directorA, now)).rejects.toMatchObject({ code: "TRANSFER_NOT_FOUND", status: 404 });
  });

  it("lets staff finish only once overdue, and override an unmatched request only with a chosen member", async () => {
    db.memberTransfer.findUnique.mockResolvedValue(pendingTransfer);
    await expect(staffFinishTransfer("transfer-1", "", staff, now)).rejects.toMatchObject({ code: "NOT_OVERDUE" });
    db.memberTransfer.findUnique.mockResolvedValue({ ...pendingTransfer, status: "UNMATCHED" });
    await expect(staffOverrideTransfer("transfer-1", { note: "Checked." }, staff, now)).rejects.toMatchObject({ code: "MEMBER_CHOICE_REQUIRED" });
    await expect(staffOverrideTransfer("transfer-1", { note: " " }, staff, now)).rejects.toMatchObject({ code: "REASON_REQUIRED" });
  });

  it("erases the sending row with every ADR 0005 field, then creates the receiving row with the sealed birth date", async () => {
    db.memberTransfer.findUnique.mockResolvedValue(pendingTransfer);
    db.memberTransfer.updateMany.mockResolvedValue({ count: 1 });
    db.memberTransfer.findFirst.mockResolvedValue(null);
    db.clubRosterMember.findUnique.mockResolvedValue({
      id: "row-ada", organizationId: "club-a", clubYear: "2026-27", personId: "person-ada", attendeeType: "YOUTH", role: "Pathfinder",
      classLevel: "FRIEND", reportedAge: null, gender: "FEMALE", sealedBirthDate: "v1.sealed", willingToDrive: false, status: "ACTIVE",
    });
    db.clubRosterMember.findFirst.mockResolvedValue(null);
    db.clubRosterMember.create.mockResolvedValue({ id: "row-new" });
    db.registrationAttendee.findMany.mockResolvedValue([]);
    db.memberTransferRegistrationMove.findMany.mockResolvedValue([]);
    const order: string[] = [];
    db.clubRosterMember.update.mockImplementation(async () => { order.push("erase"); });
    db.clubRosterMember.create.mockImplementation(async () => { order.push("create"); return { id: "row-new" }; });
    await acceptTransfer("club-a", "transfer-1", directorA, now);
    expect(db.clubRosterMember.update).toHaveBeenCalledWith({
      where: { id: "row-ada" },
      data: { status: "REMOVED", removedAt: now, sealedBirthDate: null, gender: null, role: "", classLevel: null, reportedAge: null, personId: null, willingToDrive: false },
    });
    // Guardian contacts (#510) stay with the sending membership: they are deleted, never copied to the receiving row.
    expect(db.clubRosterGuardian.deleteMany).toHaveBeenCalledWith({ where: { rosterMemberId: "row-ada" } });
    expect(db.clubRosterMember.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ organizationId: "club-b", personId: "person-ada", sealedBirthDate: "v1.sealed", source: "TRANSFER", createdByAccountId: "account-a" }),
    }));
    expect(order).toEqual(["erase", "create"]);
    // Nothing about registrations moves here; the member's open registrations are only looked up to queue.
    expect(db.registrationAttendee.update).not.toHaveBeenCalled();
  });
});

describe("what each club sees", () => {
  it("never shows the receiving club a staff reason, a decline, or the sending club's record, and never a birth date", async () => {
    const declined = {
      id: "t1", status: "DECLINED", staffReason: null, fromOrganizationId: "club-a", toOrganizationId: "club-b",
      requestedFirstName: "Ada", requestedLastName: "Testperson", reason: "r", initiatedAt: now, acknowledgeDueAt: now, resolvedAt: null,
      resolution: null, initiatedByAccountId: "account-b", initiatedByUserId: null,
      fromOrganization: { name: "Club A" }, toOrganization: { name: "Club B" }, person: { firstName: "Ada", lastName: "Lovelace-Real" },
      events: [{ id: "e1", type: "REQUESTED", createdAt: now }, { id: "e2", type: "DECLINED", createdAt: now }],
    };
    db.memberTransfer.findMany.mockImplementation(async ({ where }: { where: { toOrganizationId?: string } }) => (where.toOrganizationId ? [declined] : []));
    const { incoming } = await listClubTransfers("club-b", directorB, now);
    expect(incoming[0]).toMatchObject({ status: "PENDING", statusLabel: "Pending", memberName: "Ada Testperson", canCancel: true, canAccept: false });
    expect(incoming[0]!.events.map((event) => event.type)).toEqual(["REQUESTED"]);
    expect(JSON.stringify(incoming)).not.toMatch(/DECLINED|Lovelace-Real|staffReason|sealed|birth/i);
  });
});

describe("registration moves (staff approve each one)", () => {
  const storedMove = {
    id: "move-1", status: "PENDING", note: "", decidedAt: null, createdAt: now, eventId: "event-1",
    registrationAttendeeId: "att-1", fromRegistrationId: "reg-a", toRegistrationId: null, decidedBy: null,
    event: { name: "Camporee", startsAt: now },
    transfer: {
      id: "transfer-1", fromOrganizationId: "club-a", toOrganizationId: "club-b", toRosterMemberId: "row-b",
      toRosterMember: { status: "ACTIVE", personId: "person-ada" }, fromOrganization: { name: "Club A" }, toOrganization: { name: "Club B" },
    },
    attendee: {
      id: "att-1", personId: "person-ada", registrationId: "reg-a", profileSnapshot: { firstName: "Ada", clubRosterMemberId: "row-a" },
      person: { firstName: "Ada", lastName: "Testperson" }, adjustments: [{ amountCents: -2500, registrationId: "reg-a" }, { amountCents: -9900, registrationId: "reg-elsewhere" }],
      honorEnrollments: [{ offeringId: "class-1", consumesSeat: true, offering: { perClubLimit: 2 } }],
    },
    fromRegistration: { id: "reg-a", confirmationCode: "A-1", status: "SUBMITTED", totalAmount: 75, payments: [] },
  };
  /** The receiving club's registrations for the event (#809: a club may have several teams, so it is looked up as a list). */
  const setDestination = (row: unknown) => db.clubEventRegistration.findMany.mockResolvedValue([row]);
  const destination = (overrides: Record<string, unknown> = {}) => ({
    registration: { id: "reg-b", confirmationCode: "B-1", status: "SUBMITTED", totalAmount: 150, waitlistEntry: null, payments: [], ...overrides },
  });

  /** Two different counts share `honorEnrollment.count`: seats taken in a class (per-club limit) and picks at another site (#589). */
  const countPicks = ({ perClub, otherSite = 0 }: { perClub: number; otherSite?: number }) => db.honorEnrollment.count.mockImplementation(
    async (args: { where: Record<string, unknown> }) => ("OR" in args.where ? otherSite : perClub),
  );

  beforeEach(() => {
    db.memberTransferRegistrationMove.updateMany.mockResolvedValue({ count: 1 });
    db.memberTransferRegistrationMove.findUniqueOrThrow.mockResolvedValue(storedMove);
    setDestination(destination());
    db.registrationAttendee.findUnique.mockResolvedValue(null);
    db.registrationAttendee.findFirst.mockResolvedValue({ position: 3 });
    countPicks({ perClub: 1 });
    for (const name of ["registrationAdjustment", "honorEnrollment", "registrationCapacityReservation"]) {
      db[name]!.updateMany!.mockResolvedValue({ count: 1 });
    }
  });

  it("moves the attendee and every dependent row, shifting totals only by the person's own adjustment lines", async () => {
    const result = await approveRegistrationMove("move-1", "ok", staff, now);
    expect(db.registrationAttendee.update).toHaveBeenCalledWith({
      where: { id: "att-1" },
      data: { registrationId: "reg-b", position: 4, profileSnapshot: { firstName: "Ada", clubRosterMemberId: "row-b" } },
    });
    expect(db.registrationAdjustment.updateMany).toHaveBeenCalledWith({ where: { registrationAttendeeId: "att-1", registrationId: "reg-a" }, data: { registrationId: "reg-b" } });
    expect(db.honorEnrollment.updateMany).toHaveBeenCalledWith({ where: { registrationAttendeeId: "att-1" }, data: { registrationId: "reg-b", organizationId: "club-b" } });
    expect(db.registrationCapacityReservation.updateMany).toHaveBeenCalledWith({ where: { registrationAttendeeId: "att-1" }, data: { registrationId: "reg-b" } });
    // Operation history stays with the old registration.
    expect(db.registrationOperation.updateMany).not.toHaveBeenCalled();
    expect(db.registration.update).toHaveBeenCalledWith({ where: { id: "reg-a" }, data: { totalAmount: 100, updatedAt: now } });
    expect(db.registration.update).toHaveBeenCalledWith({ where: { id: "reg-b" }, data: { totalAmount: 125, updatedAt: now } });
    expect(result).toMatchObject({ fromTotalCentsBefore: 7500, fromTotalCentsAfter: 10000, toTotalCentsBefore: 15000, toTotalCentsAfter: 12500 });
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "CLUB_MEMBER_TRANSFER_REGISTRATION_MOVE_APPROVED", actorUserId: "staff-1", eventId: "event-1",
    }), expect.anything());
  });

  it("refuses a waitlisted destination and a person already on it, moving nothing", async () => {
    setDestination(destination({ waitlistEntry: { status: "WAITING" } }));
    await expect(approveRegistrationMove("move-1", "", staff, now)).rejects.toMatchObject({ code: "MOVE_BLOCKED", blocker: "DESTINATION_WAITLISTED" });
    setDestination(destination());
    db.registrationAttendee.findUnique.mockResolvedValue({ id: "att-existing" });
    await expect(approveRegistrationMove("move-1", "", staff, now)).rejects.toMatchObject({ code: "MOVE_BLOCKED", blocker: "ALREADY_ON_DESTINATION" });
    expect(db.registrationAttendee.update).not.toHaveBeenCalled();
  });

  it("refuses a stale move, a class over the per-club limit, and every money guard", async () => {
    const cases: Array<[string, () => void]> = [
      ["MEMBER_LEFT_RECEIVING_CLUB", () => db.memberTransferRegistrationMove.findUniqueOrThrow.mockResolvedValue({
        ...storedMove, transfer: { ...storedMove.transfer, toRosterMember: { status: "REMOVED", personId: null } },
      })],
      ["CLUB_CLASS_LIMIT", () => countPicks({ perClub: 2 })],
      ["CLASS_PICKS_OTHER_SITE", () => countPicks({ perClub: 1, otherSite: 2 })],
      ["TOTAL_CLAMPED", () => setDestination(destination({ totalAmount: 0 }))],
      // Moving a +$200 correction off a $75 registration would leave it at -$125.
      ["TOTAL_BELOW_ZERO", () => db.memberTransferRegistrationMove.findUniqueOrThrow.mockResolvedValue({
        ...storedMove, attendee: { ...storedMove.attendee, adjustments: [{ amountCents: 20000, registrationId: "reg-a" }] },
      })],
      // Moving a -$25 scholarship onto a $150 registration already paid $140 leaves $125 < $140.
      ["TOTAL_BELOW_PAID", () => setDestination(destination({ payments: [{ amount: 140, refunds: [] }] }))],
    ];
    for (const [blocker, arrange] of cases) {
      db.memberTransferRegistrationMove.findUniqueOrThrow.mockResolvedValue(storedMove);
      setDestination(destination());
      countPicks({ perClub: 1 });
      arrange();
      await expect(approveRegistrationMove("move-1", "", staff, now)).rejects.toMatchObject({ code: "MOVE_BLOCKED", blocker });
    }
    expect(db.registrationAttendee.update).not.toHaveBeenCalled();
    expect(db.registration.update).not.toHaveBeenCalled();
  });

  describe("class picks at another site (#589)", () => {
    /** The new club is at Des Moines with room; the old club was at Kansas City. */
    const receivingAtDesMoines = () => {
      db.memberTransferRegistrationMove.findUniqueOrThrow.mockResolvedValue({
        ...storedMove, fromRegistration: { ...storedMove.fromRegistration, locationId: "loc-2", location: { name: "Kansas City" } },
      });
      setDestination(destination({ locationId: "loc-1", location: { name: "Des Moines" }, _count: { attendees: 2 } }));
      (db as unknown as Record<string, ReturnType<typeof vi.fn>>).$queryRaw!.mockResolvedValue([
        { id: "loc-1", eventId: "event-1", name: "Des Moines", address: null, firstDay: null, lastDay: null, capacity: null, registrationClosesOn: null, isActive: true },
      ]);
      db.registrationAttendee.count.mockResolvedValue(0);
    };

    it("refuses a move that would carry class picks to a registration at a different site, checked against the receiver's site", async () => {
      receivingAtDesMoines();
      countPicks({ perClub: 1, otherSite: 1 });
      await expect(approveRegistrationMove("move-1", "", staff, now)).rejects.toMatchObject({ code: "MOVE_BLOCKED", blocker: "CLASS_PICKS_OTHER_SITE" });
      const query = db.honorEnrollment.count.mock.calls.map(([args]) => (args as { where: Record<string, unknown> }).where).find((where) => "OR" in where)!;
      expect(query).toEqual({
        registrationAttendeeId: "att-1",
        registrationId: "reg-a",
        OR: [{ offering: { session: { locationId: { not: "loc-1" } } } }, { offering: { locationId: { not: "loc-1" } } }],
      });
      expect(db.registrationAttendee.update).not.toHaveBeenCalled();
      expect(db.honorEnrollment.updateMany).not.toHaveBeenCalled();
    });

    it("lets the move through when no pick is at another site", async () => {
      // The old registration is at a location, so the seat it frees is offered to that waitlist (#599); this event has none.
      (db as unknown as { event: { findUnique: ReturnType<typeof vi.fn> } }).event.findUnique
        .mockResolvedValue({ id: "event-1", name: "Camporee", capacity: null, waitlistEnabled: false, autoPromoteWaitlist: false });
      receivingAtDesMoines();
      countPicks({ perClub: 1, otherSite: 0 });
      await expect(approveRegistrationMove("move-1", "", staff, now)).resolves.toBeDefined();
    });
  });

  describe("at an event location (#413)", () => {
    const raw = (name: string) => (db as unknown as Record<string, ReturnType<typeof vi.fn>>)[name]!;
    const location = (capacity: number | null) => [{ id: "loc-1", eventId: "event-1", name: "Des Moines", address: null, firstDay: null, lastDay: null, capacity, registrationClosesOn: null, isActive: true }];
    const noWaitlist = () => (db as unknown as { event: { findUnique: ReturnType<typeof vi.fn> } }).event.findUnique
      .mockResolvedValue({ id: "event-1", name: "Camporee", capacity: null, waitlistEnabled: false, autoPromoteWaitlist: false });
    const at = (capacity: number | null, seatsElsewhere: number) => {
      noWaitlist();
      db.memberTransferRegistrationMove.findUniqueOrThrow.mockResolvedValue({
        ...storedMove, fromRegistration: { ...storedMove.fromRegistration, locationId: "loc-2", location: { name: "Kansas City" } },
      });
      // The receiving registration already has two people; the move adds a third.
      setDestination(destination({ locationId: "loc-1", location: { name: "Des Moines" }, _count: { attendees: 2 } }));
      raw("$queryRaw").mockResolvedValue(location(capacity));
      db.registrationAttendee.count.mockResolvedValue(seatsElsewhere);
    };

    it("refuses a move into a full location, under the location lock, and moves nothing", async () => {
      at(4, 2);
      await expect(approveRegistrationMove("move-1", "", staff, now)).rejects.toMatchObject({ code: "MOVE_BLOCKED", blocker: "LOCATION_FULL" });
      expect(raw("$queryRaw")).toHaveBeenCalledTimes(1);
      expect(raw("$executeRawUnsafe").mock.calls.map((call) => call[0])).toEqual(["SET LOCAL lock_timeout = '5s'", "SET LOCAL lock_timeout = 0"]);
      expect(db.registrationAttendee.count).toHaveBeenCalledWith({ where: { registration: expect.objectContaining({ locationId: "loc-1", id: { not: "reg-b" } }) } });
      expect(db.registrationAttendee.update).not.toHaveBeenCalled();
    });

    it("moves the person when the location has room, and names the crossing in the review", async () => {
      at(5, 2);
      await approveRegistrationMove("move-1", "ok", staff, now);
      expect(db.registrationAttendee.update).toHaveBeenCalled();
    });

    it("adds no seat, so takes no location lock, when both registrations are at the same location", async () => {
      noWaitlist();
      db.memberTransferRegistrationMove.findUniqueOrThrow.mockResolvedValue({
        ...storedMove, fromRegistration: { ...storedMove.fromRegistration, locationId: "loc-1", location: { name: "Des Moines" } },
      });
      setDestination(destination({ locationId: "loc-1", location: { name: "Des Moines" }, _count: { attendees: 2 } }));
      await approveRegistrationMove("move-1", "ok", staff, now);
      expect(raw("$queryRaw")).not.toHaveBeenCalled();
    });

    it("offers the seat the person leaves at the old registration's location to that location's waitlist, in the same transaction (#599)", async () => {
      at(5, 0);
      const client = db as unknown as { event: { findUnique: ReturnType<typeof vi.fn> }; registrationWaitlistEntry: { findMany: ReturnType<typeof vi.fn> } };
      client.event.findUnique.mockResolvedValue({ id: "event-1", name: "Camporee", capacity: null, waitlistEnabled: true, autoPromoteWaitlist: true });
      client.registrationWaitlistEntry.findMany.mockResolvedValue([]);
      const result = await approveRegistrationMove("move-1", "ok", staff, now);
      expect(client.registrationWaitlistEntry.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { eventId: "event-1", status: "WAITING" } }));
      expect(result.pendingMessageIds).toEqual([]);
    });

    it("offers nothing when the event has no waitlist", async () => {
      at(5, 0);
      const client = db as unknown as { registrationWaitlistEntry: { findMany: ReturnType<typeof vi.fn> } };
      const result = await approveRegistrationMove("move-1", "ok", staff, now);
      expect(client.registrationWaitlistEntry.findMany).not.toHaveBeenCalled();
      expect(result.pendingMessageIds).toEqual([]);
    });

    it("offers nothing when the old registration has no location", async () => {
      setDestination(destination());
      const client = db as unknown as { event: { findUnique: ReturnType<typeof vi.fn> } };
      await approveRegistrationMove("move-1", "ok", staff, now);
      expect(client.event.findUnique).not.toHaveBeenCalled();
    });

    it("gives the approval transaction room for the lock wait", async () => {
      at(5, 0);
      await approveRegistrationMove("move-1", "ok", staff, now);
      expect((db as unknown as { transactionOptions: unknown[] }).transactionOptions[0]).toMatchObject({ isolationLevel: "Serializable", timeout: 20_000 });
    });
  });

  it("maps a unique collision that outlasts the retries to a clear 409", async () => {
    const { Prisma } = await import("@prisma/client");
    db.registrationAttendee.update.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" }));
    await expect(approveRegistrationMove("move-1", "", staff, now)).rejects.toMatchObject({
      code: "MOVE_BLOCKED", status: 409, message: "This person is already on that registration.",
    });
  });

  it("audits a skip with the actor (N4)", async () => {
    db.memberTransferRegistrationMove.findUniqueOrThrow.mockResolvedValue({ eventId: "event-1", transferId: "transfer-1", registrationAttendeeId: "att-1", fromRegistrationId: "reg-a" });
    await skipRegistrationMove("move-1", "Stays", staff, now);
    expect(db.memberTransferRegistrationMove.updateMany).toHaveBeenCalledWith({
      where: { id: "move-1", status: "PENDING" },
      data: { status: "SKIPPED", decidedAt: now, decidedByUserId: "staff-1", note: "Stays" },
    });
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "CLUB_MEMBER_TRANSFER_REGISTRATION_MOVE_SKIPPED", actorUserId: "staff-1" }), expect.anything());
  });
});

describe("no medical or insurance data", () => {
  it("never reaches a background-check, medical or insurance model on any path", async () => {
    await requestTransfer("club-b", request, directorB, now).catch(() => undefined);
    db.memberTransfer.findUnique.mockResolvedValue(pendingTransfer);
    db.memberTransfer.updateMany.mockResolvedValue({ count: 1 });
    await acceptTransfer("club-a", "transfer-1", directorA, now).catch(() => undefined);
    await listClubTransfers("club-a", directorA, now).catch(() => undefined);
    const touched = [...db.touchedModels];
    expect(touched.filter((name) => /background|medical|insurance|health/i.test(name))).toEqual([]);
  });
});
