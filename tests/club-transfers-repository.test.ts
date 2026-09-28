import { beforeEach, describe, expect, it, vi } from "vitest";

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
  MemberTransferError,
  acknowledgeTransfer,
  initiateTransfer,
  listClubTransfers,
  listStaffTransferQueue,
  searchTransferCandidates,
  staffFinishTransfer,
  staffOverrideTransfer,
} from "@/modules/club-transfers/repository";

type Row = Record<string, unknown> & { id: string };

const now = new Date("2026-09-28T12:00:00Z");
const clubActor = { kind: "ATTENDEE" as const, accountId: "account-receiving-director", sessionId: "session-receiving" };
const sendingActor = { kind: "ATTENDEE" as const, accountId: "account-sending-director", sessionId: "session-sending" };
const staffActor = { userId: "staff-1" };

/** A small in-memory stand-in for the Prisma calls `modules/club-transfers/repository` makes. */
function fakeDatabase() {
  let seq = 0;
  const id = (prefix: string) => `${prefix}-${++seq}`;

  const rosterMembers: Row[] = [];
  const transfers: Row[] = [];
  const transferEvents: Row[] = [];
  const organizations = new Map<string, { name: string }>();
  const people = new Map<string, { firstName: string; lastName: string; normalizedEmail: string | null }>();
  const directorGrants: Array<Record<string, unknown>> = [];
  const messages: Row[] = [];
  const registrationAttendees: Row[] = [];
  const registrations = new Map<string, { status: string; clubRegistration: { organizationId: string } | null }>();
  const events = new Map<string, { billingMode: string; endsAt: Date }>();
  const clubEventRegistrations = new Map<string, { registrationId: string; registration: { status: string } }>();

  function matchRoster(row: Row, where: Row) {
    return Object.entries(where).every(([key, value]) => {
      if (value === undefined) return true;
      // The repository's cross-club search filters out roster rows with no linked Person;
      // every fake row in these tests already has one, so there's nothing to check here.
      if (key === "person") return true;
      if (value && typeof value === "object" && "not" in (value as Row)) return row[key] !== (value as Row).not;
      return row[key] === value;
    });
  }

  function withOrgAndPersonAndEvents(transfer: Row) {
    return {
      ...transfer,
      fromOrganization: organizations.get(transfer.fromOrganizationId as string),
      toOrganization: organizations.get(transfer.toOrganizationId as string),
      person: people.get(transfer.personId as string),
      events: transferEvents.filter((event) => event.transferId === transfer.id),
    };
  }

  const client = {
    clubRosterMember: {
      findFirst: async ({ where }: { where: Row }) => rosterMembers.find((row) => matchRoster(row, where)) ?? null,
      findMany: async ({ where }: { where: Row }) => rosterMembers.filter((row) => matchRoster(row, where))
        .map((row) => ({
          ...row,
          person: row.personId ? { firstName: people.get(row.personId as string)?.firstName, lastName: people.get(row.personId as string)?.lastName } : null,
          organization: organizations.get(row.organizationId as string),
        })),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: id("roster"), status: "ACTIVE", removedAt: null, ...data };
        rosterMembers.push(row);
        return row;
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const row = rosterMembers.find((candidate) => candidate.id === where.id);
        if (!row) throw new Error("roster member not found");
        Object.assign(row, data);
        return row;
      },
    },
    memberTransfer: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: id("transfer"), ...data };
        transfers.push(row);
        return row;
      },
      findUnique: async ({ where }: { where: Row }) => transfers.find((row) => row.id === where.id) ?? null,
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const row = transfers.find((candidate) => candidate.id === where.id);
        if (!row) throw new Error("transfer not found");
        Object.assign(row, data);
        return row;
      },
      findMany: async ({ where }: { where: Row }) => {
        const matched = transfers.filter((row) => {
          if (where.OR) {
            const clauses = where.OR as Row[];
            if (!clauses.some((clause) => Object.entries(clause).every(([key, value]) => row[key] === value))) return false;
          }
          if (where.status !== undefined && row.status !== where.status) return false;
          if (where.acknowledgeDueAt && typeof where.acknowledgeDueAt === "object") {
            const lte = (where.acknowledgeDueAt as Row).lte as Date;
            if (!((row.acknowledgeDueAt as Date) <= lte)) return false;
          }
          return true;
        });
        return matched.map(withOrgAndPersonAndEvents);
      },
    },
    memberTransferEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: id("transfer-event"), createdAt: now, ...data };
        transferEvents.push(row);
        return row;
      },
    },
    organization: {
      findUniqueOrThrow: async ({ where }: { where: Row }) => {
        const org = organizations.get(where.id as string);
        if (!org) throw new Error(`organization ${String(where.id)} not found`);
        return org;
      },
    },
    person: {
      findUniqueOrThrow: async ({ where }: { where: Row }) => {
        const person = people.get(where.id as string);
        if (!person) throw new Error(`person ${String(where.id)} not found`);
        return person;
      },
    },
    clubDirectorGrant: {
      findMany: async ({ where }: { where: Row }) => directorGrants.filter((grant) => grant.organizationId === where.organizationId
        && (where.role as { in: string[] }).in.includes(grant.role as string)
        && grant.revokedAt === null),
    },
    messageOutbox: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: id("message"), ...data };
        messages.push(row);
        return row;
      },
    },
    registrationAttendee: {
      findMany: async ({ where }: { where: Row }) => {
        const registrationWhere = where.registration as Row;
        const eventWhere = where.event as Row;
        return registrationAttendees.filter((attendee) => {
          if (attendee.personId !== where.personId) return false;
          const registration = registrations.get(attendee.registrationId as string);
          if (!registration) return false;
          const statusIn = ((registrationWhere.status as Row).in as string[]);
          if (!statusIn.includes(registration.status)) return false;
          const clubRegistration = registrationWhere.clubRegistration as Row;
          if (registration.clubRegistration?.organizationId !== clubRegistration.organizationId) return false;
          const event = events.get(attendee.eventId as string);
          if (!event) return false;
          if (event.billingMode !== eventWhere.billingMode) return false;
          if (!(event.endsAt >= ((eventWhere.endsAt as Row).gte as Date))) return false;
          return true;
        });
      },
      findUnique: async ({ where }: { where: Row }) => {
        const key = where.registrationId_personId as Row;
        return registrationAttendees.find((attendee) => attendee.registrationId === key.registrationId && attendee.personId === key.personId) ?? null;
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const row = registrationAttendees.find((candidate) => candidate.id === where.id);
        if (!row) throw new Error("attendee not found");
        Object.assign(row, data);
        return row;
      },
    },
    clubEventRegistration: {
      findUnique: async ({ where }: { where: Row }) => {
        const key = where.eventId_organizationId as Row;
        return clubEventRegistrations.get(`${key.eventId}:${key.organizationId}`) ?? null;
      },
    },
  };

  mocks.getPrisma.mockReturnValue({ ...client, $transaction: async (work: (tx: typeof client) => unknown) => work(client) });

  return {
    rosterMembers, transfers, transferEvents, organizations, people, directorGrants,
    messages, registrationAttendees, registrations, events, clubEventRegistrations,
    client,
  };
}

function rosterRow(overrides: Partial<Row>): Row {
  return {
    id: "roster-source",
    organizationId: "club-sending",
    clubYear: "2026-27",
    personId: "person-1",
    attendeeType: "YOUTH",
    role: "Pathfinder",
    classLevel: "RANGER",
    reportedAge: null,
    gender: "MALE",
    sealedBirthDate: "sealed:2014-05-01",
    willingToDrive: false,
    status: "ACTIVE",
    ...overrides,
  };
}

let db: ReturnType<typeof fakeDatabase>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.writeAuditLog.mockResolvedValue({});
  mocks.isAccountEmailConfigured.mockReturnValue(true);
  mocks.getAccountEmailSender.mockReturnValue({ name: "IMSDA Events", address: "no-reply@imsda.test", replyTo: null });
  db = fakeDatabase();
  db.organizations.set("club-sending", { name: "Sending Club" });
  db.organizations.set("club-receiving", { name: "Receiving Club" });
  db.people.set("person-1", { firstName: "Pat", lastName: "Pathfinder", normalizedEmail: "guardian@example.test" });
});

describe("initiating a transfer (#489)", () => {
  it("creates the receiving club's roster row right away, keeps the sending club's row active, and leaves one Person", async () => {
    db.rosterMembers.push(rosterRow({}));
    const result = await initiateTransfer(
      "club-receiving",
      { fromOrganizationId: "club-sending", fromRosterMemberId: "roster-source", reason: "Family moved closer to the receiving club." },
      clubActor,
      now,
    );

    expect(db.rosterMembers).toHaveLength(2);
    const sendingRow = db.rosterMembers.find((row) => row.id === "roster-source")!;
    const receivingRow = db.rosterMembers.find((row) => row.id === result.rosterMemberId)!;
    // One Person the whole way through: both rows point at the same personId, and no new Person was created.
    expect(sendingRow.personId).toBe("person-1");
    expect(receivingRow.personId).toBe("person-1");
    expect(sendingRow.status).toBe("ACTIVE");
    expect(receivingRow.status).toBe("ACTIVE");
    expect(receivingRow.source).toBe("TRANSFER");
    // Roster fields and the sealed birth date moved with the roster row.
    expect(receivingRow.sealedBirthDate).toBe(sendingRow.sealedBirthDate);
    expect(receivingRow.classLevel).toBe(sendingRow.classLevel);

    const transfer = db.transfers[0];
    expect(transfer.status).toBe("PENDING");
    expect(transfer.acknowledgeDueAt).toEqual(new Date("2026-10-12T12:00:00Z"));

    const events = db.transferEvents.filter((event) => event.transferId === transfer.id);
    expect(events.map((event) => event.type)).toContain("INITIATED");
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "CLUB_MEMBER_TRANSFER_INITIATED", entityType: "MemberTransfer" }),
      expect.anything(),
    );
  });

  it("refuses to start a transfer to the member's own club", async () => {
    db.rosterMembers.push(rosterRow({}));
    await expect(initiateTransfer(
      "club-sending",
      { fromOrganizationId: "club-sending", fromRosterMemberId: "roster-source", reason: "reason" },
      clubActor,
      now,
    )).rejects.toThrow(MemberTransferError);
  });

  it("refuses a blank reason", async () => {
    db.rosterMembers.push(rosterRow({}));
    await expect(initiateTransfer(
      "club-receiving",
      { fromOrganizationId: "club-sending", fromRosterMemberId: "roster-source", reason: "   " },
      clubActor,
      now,
    )).rejects.toThrow(MemberTransferError);
  });

  it("refuses a member who's already on the receiving club's roster this year", async () => {
    db.rosterMembers.push(rosterRow({}));
    db.rosterMembers.push(rosterRow({ id: "roster-existing", organizationId: "club-receiving", status: "ACTIVE" }));
    await expect(initiateTransfer(
      "club-receiving",
      { fromOrganizationId: "club-sending", fromRosterMemberId: "roster-source", reason: "reason" },
      clubActor,
      now,
    )).rejects.toThrow(MemberTransferError);
  });

  it("queues a notification to the sending club's active directors only (never a bulk send)", async () => {
    db.rosterMembers.push(rosterRow({}));
    db.directorGrants.push({ organizationId: "club-sending", role: "DIRECTOR", revokedAt: null, attendeeAccountId: "sending-dir", attendeeAccount: { id: "sending-dir", email: "sending-director@example.test", displayName: "Sending Director" } });
    db.directorGrants.push({ organizationId: "club-receiving", role: "DIRECTOR", revokedAt: null, attendeeAccountId: "receiving-dir", attendeeAccount: { id: "receiving-dir", email: "receiving-director@example.test", displayName: "Receiving Director" } });
    await initiateTransfer(
      "club-receiving",
      { fromOrganizationId: "club-sending", fromRosterMemberId: "roster-source", reason: "reason" },
      clubActor,
      now,
    );
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].recipientEmail).toBe("sending-director@example.test");
    expect(db.messages[0].templateKey).toBe("MEMBER_TRANSFER_STARTED");
  });

  it("never reads or moves medical or insurance data: the fake database has no such model and nothing calls one", async () => {
    // No `backgroundCheck` model exists on this fake client at all. If the repository ever
    // touched medical or insurance data, this call would throw a "not a function" error.
    db.rosterMembers.push(rosterRow({}));
    await expect(initiateTransfer(
      "club-receiving",
      { fromOrganizationId: "club-sending", fromRosterMemberId: "roster-source", reason: "reason" },
      clubActor,
      now,
    )).resolves.toBeDefined();
  });
});

describe("acknowledging, finishing, and overriding a transfer (#489)", () => {
  async function initiated() {
    db.rosterMembers.push(rosterRow({}));
    const { transferId } = await initiateTransfer(
      "club-receiving",
      { fromOrganizationId: "club-sending", fromRosterMemberId: "roster-source", reason: "reason" },
      clubActor,
      now,
    );
    return transferId;
  }

  it("removes the sending club's roster row and completes the transfer once the sending club acknowledges it", async () => {
    const transferId = await initiated();
    await acknowledgeTransfer("club-sending", transferId, sendingActor, new Date("2026-09-29T00:00:00Z"));
    const sendingRow = db.rosterMembers.find((row) => row.id === "roster-source")!;
    expect(sendingRow.status).toBe("REMOVED");
    const transfer = db.transfers.find((row) => row.id === transferId)!;
    expect(transfer.status).toBe("COMPLETED");
    expect(transfer.resolution).toBe("SENDING_CLUB_ACKNOWLEDGED");
    const eventTypes = db.transferEvents.filter((event) => event.transferId === transferId).map((event) => event.type);
    expect(eventTypes).toContain("ACKNOWLEDGED");
  });

  it("refuses to acknowledge a transfer that belongs to a different sending club", async () => {
    const transferId = await initiated();
    await expect(acknowledgeTransfer("some-other-club", transferId, sendingActor, now)).rejects.toThrow(MemberTransferError);
  });

  it("refuses to acknowledge a transfer twice", async () => {
    const transferId = await initiated();
    await acknowledgeTransfer("club-sending", transferId, sendingActor, now);
    await expect(acknowledgeTransfer("club-sending", transferId, sendingActor, now)).rejects.toThrow(MemberTransferError);
  });

  it("lets conference staff finish a transfer the sending club hasn't acknowledged, and audits it", async () => {
    const transferId = await initiated();
    const overdueNow = new Date("2026-10-13T00:00:00Z");
    await staffFinishTransfer(transferId, "Sending club unresponsive after 14 days.", staffActor, overdueNow);
    const transfer = db.transfers.find((row) => row.id === transferId)!;
    expect(transfer.resolution).toBe("STAFF_FINISHED");
    expect(transfer.staffNote).toBe("Sending club unresponsive after 14 days.");
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "CLUB_MEMBER_TRANSFER_STAFF_FINISHED" }),
      expect.anything(),
    );
  });

  it("lets conference staff override a transfer outright, and audits it", async () => {
    const transferId = await initiated();
    await staffOverrideTransfer(transferId, "Sending club objected; staff decided the move stands.", staffActor, now);
    const transfer = db.transfers.find((row) => row.id === transferId)!;
    expect(transfer.resolution).toBe("STAFF_OVERRIDDEN");
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "CLUB_MEMBER_TRANSFER_STAFF_OVERRIDDEN" }),
      expect.anything(),
    );
  });

  it("notifies both clubs and the member's guardian, since an email is on file", async () => {
    db.directorGrants.push({ organizationId: "club-sending", role: "DIRECTOR", revokedAt: null, attendeeAccount: { id: "sending-dir", email: "sending-director@example.test", displayName: "Sending Director" } });
    db.directorGrants.push({ organizationId: "club-receiving", role: "DIRECTOR", revokedAt: null, attendeeAccount: { id: "receiving-dir", email: "receiving-director@example.test", displayName: "Receiving Director" } });
    const transferId = await initiated();
    await acknowledgeTransfer("club-sending", transferId, sendingActor, now);
    const completedMessages = db.messages.filter((message) => message.templateKey === "MEMBER_TRANSFER_COMPLETED");
    const recipientEmails = completedMessages.map((message) => message.recipientEmail);
    expect(recipientEmails).toContain("sending-director@example.test");
    expect(recipientEmails).toContain("receiving-director@example.test");
    expect(recipientEmails).toContain("guardian@example.test");
  });
});

describe("re-pointing open event registrations on completion (#489)", () => {
  async function initiated() {
    db.rosterMembers.push(rosterRow({}));
    const { transferId } = await initiateTransfer(
      "club-receiving",
      { fromOrganizationId: "club-sending", fromRosterMemberId: "roster-source", reason: "reason" },
      clubActor,
      now,
    );
    return transferId;
  }

  it("re-points an open, club-billed registration to the receiving club, and audits it", async () => {
    db.events.set("event-1", { billingMode: "DEFERRED_ORGANIZATION_INVOICE", endsAt: new Date("2026-11-01T00:00:00Z") });
    db.registrations.set("reg-sending", { status: "SUBMITTED", clubRegistration: { organizationId: "club-sending" } });
    db.registrationAttendees.push({ id: "attendee-1", eventId: "event-1", registrationId: "reg-sending", personId: "person-1" });
    db.clubEventRegistrations.set("event-1:club-receiving", { registrationId: "reg-receiving", registration: { status: "SUBMITTED" } });

    const transferId = await initiated();
    await acknowledgeTransfer("club-sending", transferId, sendingActor, now);

    const attendee = db.registrationAttendees.find((row) => row.id === "attendee-1")!;
    expect(attendee.registrationId).toBe("reg-receiving");
    const repointEvents = db.transferEvents.filter((event) => event.transferId === transferId && event.type === "REGISTRATION_REPOINTED");
    expect(repointEvents).toHaveLength(1);
    expect((repointEvents[0].metadata as Record<string, unknown>).outcome).toBe("REPOINTED");
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "CLUB_MEMBER_TRANSFER_REGISTRATION_REPOINTED", entityType: "RegistrationAttendee" }),
      expect.anything(),
    );
  });

  it("leaves the attendee in place and audits the skip when the receiving club has no open registration for that event", async () => {
    db.events.set("event-1", { billingMode: "DEFERRED_ORGANIZATION_INVOICE", endsAt: new Date("2026-11-01T00:00:00Z") });
    db.registrations.set("reg-sending", { status: "SUBMITTED", clubRegistration: { organizationId: "club-sending" } });
    db.registrationAttendees.push({ id: "attendee-1", eventId: "event-1", registrationId: "reg-sending", personId: "person-1" });
    // No clubEventRegistrations entry for club-receiving on event-1.

    const transferId = await initiated();
    await acknowledgeTransfer("club-sending", transferId, sendingActor, now);

    const attendee = db.registrationAttendees.find((row) => row.id === "attendee-1")!;
    expect(attendee.registrationId).toBe("reg-sending");
    const repointEvents = db.transferEvents.filter((event) => event.transferId === transferId && event.type === "REGISTRATION_REPOINTED");
    expect(repointEvents).toHaveLength(1);
    expect((repointEvents[0].metadata as Record<string, unknown>).outcome).toBe("SKIPPED_NO_RECEIVING_REGISTRATION");
  });

  it("never touches a past event's registration (closed history stays with the old club)", async () => {
    db.events.set("event-past", { billingMode: "DEFERRED_ORGANIZATION_INVOICE", endsAt: new Date("2026-01-01T00:00:00Z") });
    db.registrations.set("reg-sending-past", { status: "SUBMITTED", clubRegistration: { organizationId: "club-sending" } });
    db.registrationAttendees.push({ id: "attendee-past", eventId: "event-past", registrationId: "reg-sending-past", personId: "person-1" });

    const transferId = await initiated();
    await acknowledgeTransfer("club-sending", transferId, sendingActor, now);

    const attendee = db.registrationAttendees.find((row) => row.id === "attendee-past")!;
    expect(attendee.registrationId).toBe("reg-sending-past");
    expect(db.transferEvents.some((event) => event.transferId === transferId && event.type === "REGISTRATION_REPOINTED")).toBe(false);
  });
});

describe("club history and the conference staff queue (#489)", () => {
  it("shows the transfer in both clubs' history", async () => {
    db.rosterMembers.push(rosterRow({}));
    const { transferId } = await initiateTransfer(
      "club-receiving",
      { fromOrganizationId: "club-sending", fromRosterMemberId: "roster-source", reason: "reason" },
      clubActor,
      now,
    );
    const sendingHistory = await listClubTransfers("club-sending", now);
    const receivingHistory = await listClubTransfers("club-receiving", now);
    expect(sendingHistory.map((row) => row.id)).toContain(transferId);
    expect(receivingHistory.map((row) => row.id)).toContain(transferId);
  });

  it("surfaces a pending transfer in the staff queue only once the 14-day window has passed", async () => {
    db.rosterMembers.push(rosterRow({}));
    const { transferId } = await initiateTransfer(
      "club-receiving",
      { fromOrganizationId: "club-sending", fromRosterMemberId: "roster-source", reason: "reason" },
      clubActor,
      now,
    );
    expect((await listStaffTransferQueue(new Date("2026-10-01T00:00:00Z"))).map((row) => row.id)).not.toContain(transferId);
    const overdueQueue = await listStaffTransferQueue(new Date("2026-10-13T00:00:00Z"));
    expect(overdueQueue.map((row) => row.id)).toContain(transferId);
    expect(overdueQueue[0].overdueForStaff).toBe(true);
  });

  it("drops a transfer from the staff queue once it's resolved", async () => {
    db.rosterMembers.push(rosterRow({}));
    const { transferId } = await initiateTransfer(
      "club-receiving",
      { fromOrganizationId: "club-sending", fromRosterMemberId: "roster-source", reason: "reason" },
      clubActor,
      now,
    );
    await staffOverrideTransfer(transferId, "resolved", staffActor, new Date("2026-10-13T00:00:00Z"));
    const queue = await listStaffTransferQueue(new Date("2026-10-14T00:00:00Z"));
    expect(queue.map((row) => row.id)).not.toContain(transferId);
  });
});

describe("searching another club's roster to start a transfer (#489)", () => {
  it("finds an active member at another club by name, without a birth date or age", async () => {
    db.rosterMembers.push(rosterRow({}));
    const candidates = await searchTransferCandidates("path", "club-receiving", now);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual({
      rosterMemberId: "roster-source",
      organizationId: "club-sending",
      organizationName: "Sending Club",
      firstName: "Pat",
      lastName: "Pathfinder",
      attendeeType: "YOUTH",
    });
    expect(candidates[0]).not.toHaveProperty("birthDate");
    expect(candidates[0]).not.toHaveProperty("age");
  });

  it("never returns the searching club's own roster members", async () => {
    db.rosterMembers.push(rosterRow({ id: "roster-own", organizationId: "club-receiving" }));
    const candidates = await searchTransferCandidates("path", "club-receiving", now);
    expect(candidates).toHaveLength(0);
  });
});
