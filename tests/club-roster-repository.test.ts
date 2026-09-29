import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getPrisma: vi.fn(), writeAuditLog: vi.fn(), getServerEnv: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ getServerEnv: mocks.getServerEnv }));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));

import { openSecret } from "@/lib/secret-box";
import {
  addRosterMember,
  listRoster,
  removeRosterMember,
  revealRosterBirthDates,
  rosterAgesOn,
  updateRosterMember,
} from "@/modules/club-rosters/repository";

type Row = Record<string, unknown> & { id: string };

const now = new Date("2026-10-01T15:00:00Z");
const actor = { accountId: "director-1" };
const youth = {
  firstName: "Test",
  lastName: "Youth",
  birthDate: "2014-12-06",
  attendeeType: "YOUTH" as const,
  role: "Pathfinder",
  classLevel: null,
  gender: "FEMALE" as const,
};

function fakeDatabase() {
  let sequence = 0;
  const db = { people: [] as Row[], members: [] as Row[], otherReferences: new Set<string>(), honorEntries: [] as Row[], needs: [] as Row[], classCompletions: new Set<string>(), transferBlanks: [] as unknown[] };
  const matches = (row: Row, where: Record<string, unknown> = {}) => Object.entries(where).every(([key, value]) => {
    if (value === undefined) return true;
    if (value && typeof value === "object" && "not" in value) return row[key] !== (value as { not: unknown }).not;
    return row[key] === value;
  });
  const withPerson = (member: Row) => ({
    ...member,
    updatedAt: now,
    person: member.personId ? db.people.find((person) => person.id === member.personId) ?? null : null,
  });
  const client = {
    $executeRaw: async () => 0,
    $executeRawUnsafe: async () => 0,
    person: {
      create: async ({ data }: { data: Row }) => { const row = { ...data, id: `person-${++sequence}` }; db.people.push(row); return row; },
      update: async ({ where, data }: { where: Row; data: Row }) => Object.assign(db.people.find((person) => person.id === where.id)!, data),
      delete: async ({ where }: { where: Row }) => { db.people = db.people.filter((person) => person.id !== where.id); },
      findUnique: async ({ where }: { where: Row }) => {
        const person = db.people.find((row) => row.id === where.id);
        if (!person) return null;
        const referenced = db.otherReferences.has(person.id) ? 1 : 0;
        return {
          _count: {
            householdMembers: 0, heldRegistrations: 0, registrationEvents: referenced, externalIdentities: 0,
            notes: 0, attendeeAccountLinks: 0, userLinks: 0,
            clubOrderNeeds: db.needs.filter((need) => need.personId === person.id).length,
            memberClassCompletions: db.classCompletions.has(person.id) ? 1 : 0,
            clubRosterMemberships: db.members.filter((member) => member.personId === person.id).length,
          },
        };
      },
    },
    // Transfer records (#489) are blanked, never counted, when a person is erased.
    memberTransfer: {
      findMany: async () => [{ id: "transfer-1" }],
      updateMany: async (args: unknown) => { db.transferBlanks.push(args); return { count: 1 }; },
    },
    memberTransferEvent: {
      updateMany: async (args: unknown) => { db.transferBlanks.push(args); return { count: 1 }; },
    },
    memberTransferRegistrationMove: {
      updateMany: async (args: unknown) => { db.transferBlanks.push(args); return { count: 0 }; },
    },
    clubOrderNeed: {
      deleteMany: async ({ where }: { where: Row }) => {
        const before = db.needs.length;
        db.needs = db.needs.filter((need) => !(need.organizationId === where.organizationId && need.personId === where.personId && need.status === where.status));
        return { count: before - db.needs.length };
      },
    },
    memberHonorEntry: {
      deleteMany: async ({ where }: { where: { personId: string } }) => {
        const before = db.honorEntries.length;
        db.honorEntries = db.honorEntries.filter((entry) => entry.personId !== where.personId);
        return { count: before - db.honorEntries.length };
      },
    },
    clubRosterMember: {
      create: async ({ data }: { data: Row }) => { const row = { status: "ACTIVE", ...data, id: `member-${++sequence}` }; db.members.push(row); return row; },
      update: async ({ where, data }: { where: Row; data: Row }) => Object.assign(db.members.find((member) => member.id === where.id)!, data),
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const member = db.members.find((row) => matches(row, where));
        return member ? withPerson(member) : null;
      },
      findMany: async ({ where }: { where: Record<string, unknown> }) => db.members.filter((row) => matches(row, where)).map(withPerson),
    },
  };
  mocks.getPrisma.mockReturnValue({ ...client, $transaction: async (work: (tx: typeof client) => unknown) => work(client) });
  return db;
}

let db: ReturnType<typeof fakeDatabase>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getServerEnv.mockReturnValue({ SECRET_ENCRYPTION_KEY: "a-secret-encryption-key-of-adequate-length" });
  mocks.writeAuditLog.mockResolvedValue({});
  db = fakeDatabase();
});

describe("club roster storage", () => {
  it("stores the birth date only as ciphertext under its own key", async () => {
    await addRosterMember("club-1", "2026-27", youth, actor, { now });
    const stored = db.members[0];
    expect(stored.sealedBirthDate).toEqual(expect.any(String));
    expect(JSON.stringify(stored)).not.toContain("2014-12-06");
    expect(openSecret(stored.sealedBirthDate as string, "club-roster:birth-date")).toBe("2014-12-06");
    expect(() => openSecret(stored.sealedBirthDate as string, "attendee-mfa")).toThrow();
  });

  it("keeps names and birth dates out of every audit entry", async () => {
    const { memberId: id } = await addRosterMember("club-1", "2026-27", youth, actor, { now });
    await updateRosterMember("club-1", id, { birthDate: "2014-12-07", firstName: "Renamed" }, actor, now);
    await revealRosterBirthDates("club-1", "2026-27", actor);
    await removeRosterMember("club-1", id, actor, now);
    const entries = JSON.stringify(mocks.writeAuditLog.mock.calls.map(([entry]) => entry));
    for (const secret of ["Test", "Youth", "Renamed", "2014-12-06", "2014-12-07"]) expect(entries).not.toContain(secret);
    expect(mocks.writeAuditLog.mock.calls.map(([entry]) => entry.action)).toEqual([
      "CLUB_ROSTER_MEMBER_ADDED",
      "CLUB_ROSTER_MEMBER_UPDATED",
      "CLUB_ROSTER_BIRTH_DATES_REVEALED",
      "CLUB_ROSTER_MEMBER_REMOVED",
    ]);
  });

  it("lists ages, never birth dates, and computes age on an event date on the server", async () => {
    const { memberId: id } = await addRosterMember("club-1", "2026-27", youth, actor, { now });
    const [member] = await listRoster("club-1", "2026-27", now);
    expect(member).toMatchObject({ firstName: "Test", age: 11 });
    expect(JSON.stringify(member)).not.toContain("2014-12-06");
    expect((await rosterAgesOn("club-1", "2026-27", "2026-12-06")).get(id)).toBe(12);
  });

  it("refuses the same name and birth date twice on one roster, but not on another club's", async () => {
    await addRosterMember("club-1", "2026-27", youth, actor, { now });
    await expect(addRosterMember("club-1", "2026-27", { ...youth, firstName: " test " }, actor, { now }))
      .rejects.toMatchObject({ code: "DUPLICATE_MEMBER" });
    await addRosterMember("club-2", "2026-27", youth, actor, { now });
    expect(db.members).toHaveLength(2);
  });

  it("rejects impossible birth dates before writing", async () => {
    await expect(addRosterMember("club-1", "2026-27", { ...youth, birthDate: "2030-01-01" }, actor, { now }))
      .rejects.toMatchObject({ code: "BIRTH_DATE_INVALID" });
    expect(db.members).toHaveLength(0);
  });

  it("never reaches another club's roster row", async () => {
    const { memberId: id } = await addRosterMember("club-1", "2026-27", youth, actor, { now });
    await expect(updateRosterMember("club-2", id, { role: "Hijack" }, actor, now)).rejects.toMatchObject({ code: "MEMBER_NOT_FOUND" });
    await expect(removeRosterMember("club-2", id, actor, now)).rejects.toMatchObject({ code: "MEMBER_NOT_FOUND" });
    expect(db.members[0]).toMatchObject({ role: "Pathfinder", status: "ACTIVE" });
  });

  it("defaults a blank role on edit by the type the person ends up with, never replacing a typed one (#424)", async () => {
    const { memberId: staffId } = await addRosterMember("club-1", "2026-27", { ...youth, firstName: "Legacy", attendeeType: "STAFF", role: "" }, actor, { now });
    const { memberId: youthId } = await addRosterMember("club-1", "2026-27", { ...youth, role: "" }, actor, { now });
    const staff = () => db.members.find((member) => member.id === staffId)!;
    const kid = () => db.members.find((member) => member.id === youthId)!;

    // Editing a legacy staff member with an empty role keeps it empty.
    await updateRosterMember("club-1", staffId, { firstName: "Legacy", role: "", gender: "MALE" }, actor, now, { requireGender: true });
    expect(staff().role).toBe("");
    // A youth's blank role (type on file, or sent) becomes Pathfinder.
    await updateRosterMember("club-1", youthId, { role: "  " }, actor, now, { requireGender: true });
    expect(kid().role).toBe("Pathfinder");
    // Switching a staff member to youth with a blank role defaults by the new type.
    await updateRosterMember("club-1", staffId, { attendeeType: "YOUTH", role: "" }, actor, now);
    expect(staff().role).toBe("Pathfinder");
    // ...and back to staff, a blank role stays blank.
    await updateRosterMember("club-1", staffId, { attendeeType: "STAFF", role: "" }, actor, now);
    expect(staff().role).toBe("");
    // A typed role is kept as typed; an edit without role leaves it alone.
    await updateRosterMember("club-1", staffId, { role: "Counselor" }, actor, now);
    await updateRosterMember("club-1", staffId, { attendeeType: "YOUTH" }, actor, now);
    expect(staff().role).toBe("Counselor");
  });

  it("drops the old type's default role when a youth becomes staff, but keeps a typed role (#424)", async () => {
    const { memberId: formId } = await addRosterMember("club-1", "2026-27", { ...youth, firstName: "Form" }, actor, { now });
    const { memberId: csvId } = await addRosterMember("club-1", "2026-27", { ...youth, firstName: "Csv" }, actor, { now });
    const { memberId: typedId } = await addRosterMember("club-1", "2026-27", { ...youth, firstName: "Typed", role: "TLT" }, actor, { now });
    const roleOf = (id: string) => db.members.find((member) => member.id === id)!.role;
    // The form sends the pre-filled "Pathfinder" along with the new type.
    await updateRosterMember("club-1", formId, { attendeeType: "STAFF", role: "Pathfinder" }, actor, now);
    expect(roleOf(formId)).toBe("");
    // A CSV row that only changes the type.
    await updateRosterMember("club-1", csvId, { attendeeType: "STAFF" }, actor, now);
    expect(roleOf(csvId)).toBe("");
    // A role the director typed stays.
    await updateRosterMember("club-1", typedId, { attendeeType: "STAFF" }, actor, now);
    expect(roleOf(typedId)).toBe("TLT");
  });

  it("requires a gender on a details edit when none is on file, but not for status alone (#424)", async () => {
    const { memberId: id } = await addRosterMember("club-1", "2026-27", { ...youth, gender: null }, actor, { now });
    const stored = () => db.members.find((member) => member.id === id)!;

    await expect(updateRosterMember("club-1", id, { firstName: "Renamed", role: "TLT" }, actor, now, { requireGender: true }))
      .rejects.toMatchObject({ code: "GENDER_REQUIRED", message: "Choose Male or Female." });
    expect(stored()).toMatchObject({ role: "Pathfinder", gender: null });

    await updateRosterMember("club-1", id, { status: "INACTIVE" }, actor, now, { requireGender: true });
    expect(stored().status).toBe("INACTIVE");

    // The CSV import doesn't ask for it: an update there may leave gender unknown.
    await updateRosterMember("club-1", id, { role: "TLT" }, actor, now);
    expect(stored().role).toBe("TLT");

    await updateRosterMember("club-1", id, { role: "Pathfinder", gender: "FEMALE" }, actor, now, { requireGender: true });
    // Once one is on file, later details edits that leave gender out are fine.
    await updateRosterMember("club-1", id, { firstName: "Again" }, actor, now, { requireGender: true });
    expect(stored()).toMatchObject({ gender: "FEMALE" });
  });

  it("deactivating keeps the person and their history", async () => {
    const { memberId: id } = await addRosterMember("club-1", "2026-27", youth, actor, { now });
    await updateRosterMember("club-1", id, { status: "INACTIVE" }, actor, now);
    expect(db.members[0]).toMatchObject({ status: "INACTIVE", sealedBirthDate: expect.any(String) });
    expect(mocks.writeAuditLog.mock.calls.at(-1)?.[0]).toMatchObject({ action: "CLUB_ROSTER_MEMBER_DEACTIVATED" });
    expect(await listRoster("club-1", "2026-27", now)).toHaveLength(1);
  });

  it("removing erases the details and deletes the person only when nothing else uses them", async () => {
    const { memberId: lone } = await addRosterMember("club-1", "2026-27", youth, actor, { now });
    const { memberId: registered } = await addRosterMember("club-1", "2026-27", { ...youth, firstName: "Other" }, actor, { now });
    db.otherReferences.add(db.members[1].personId as string);

    await removeRosterMember("club-1", lone, actor, now);
    await removeRosterMember("club-1", registered, actor, now);

    for (const member of db.members) {
      expect(member).toMatchObject({ status: "REMOVED", sealedBirthDate: null, personId: null, gender: null, role: "", removedAt: now });
    }
    expect(db.people.map((person) => person.firstName)).toEqual(["Other"]);
    // A deleted person's transfer records (#489) keep no name; the kept person's are untouched.
    expect(db.transferBlanks).toEqual([
      { where: { id: { in: ["transfer-1"] } }, data: { requestedFirstName: "", requestedLastName: "", reason: "", staffNote: "" } },
      { where: { transferId: { in: ["transfer-1"] } }, data: { note: "" } },
      { where: { transferId: { in: ["transfer-1"] } }, data: { note: "" } },
    ]);
    expect(await listRoster("club-1", "2026-27", now)).toEqual([]);
    await expect(updateRosterMember("club-1", lone, { role: "Back" }, actor, now)).rejects.toMatchObject({ code: "MEMBER_REMOVED" });
  });

  it("removing a member with honor history deletes the person and their honor entries, and audits the count (#486)", async () => {
    const { memberId: id } = await addRosterMember("club-1", "2026-27", youth, actor, { now });
    const { memberId: otherId } = await addRosterMember("club-1", "2026-27", { ...youth, firstName: "Other" }, actor, { now });
    const { memberId: elsewhereId } = await addRosterMember("club-2", "2026-27", { ...youth, firstName: "Elsewhere" }, actor, { now });
    const personOf = (memberId: string) => db.members.find((member) => member.id === memberId)!.personId as string;
    const personId = personOf(id);
    const otherPersonId = personOf(otherId);
    const elsewherePersonId = personOf(elsewhereId);
    db.honorEntries.push(
      { id: "entry-1", personId, organizationId: "club-1" },
      { id: "entry-2", personId, organizationId: "club-2" },
      { id: "entry-3", personId: otherPersonId, organizationId: "club-1" },
      { id: "entry-4", personId: elsewherePersonId, organizationId: "club-2" },
    );

    await removeRosterMember("club-1", id, actor, now);

    expect(db.members.find((member) => member.id === id)).toMatchObject({ status: "REMOVED", sealedBirthDate: null, personId: null });
    expect(db.people.some((person) => person.id === personId)).toBe(false);
    // Every entry for that person goes, whichever club recorded it; nobody else's does.
    expect(db.honorEntries.map((entry) => entry.id)).toEqual(["entry-3", "entry-4"]);
    expect(db.people.some((person) => person.id === otherPersonId)).toBe(true);
    expect(db.people.some((person) => person.id === elsewherePersonId)).toBe(true);
    const removal = mocks.writeAuditLog.mock.calls.map(([entry]) => entry).find((entry) => entry.action === "CLUB_ROSTER_MEMBER_REMOVED");
    expect(removal.metadata).toMatchObject({ personDeleted: true, honorEntriesErased: 2 });
    expect(JSON.stringify(removal)).not.toContain("Test");
  });

  it("keeps the person and their honor history when something else still refers to them (#486)", async () => {
    const { memberId: id } = await addRosterMember("club-1", "2026-27", youth, actor, { now });
    const personId = db.members[0].personId as string;
    db.otherReferences.add(personId);
    db.honorEntries.push({ id: "entry-1", personId, organizationId: "club-1" });

    await removeRosterMember("club-1", id, actor, now);

    expect(db.people.some((person) => person.id === personId)).toBe(true);
    expect(db.honorEntries).toHaveLength(1);
    const removal = mocks.writeAuditLog.mock.calls.map(([entry]) => entry).find((entry) => entry.action === "CLUB_ROSTER_MEMBER_REMOVED");
    expect(removal.metadata).toMatchObject({ personDeleted: false, honorEntriesErased: 0 });
  });

  it("cancels an open order need, deletes the person, and audits the count (#566)", async () => {
    const { memberId: id } = await addRosterMember("club-1", "2026-27", youth, actor, { now });
    const personId = db.members[0].personId as string;
    db.needs.push({ id: "need-1", organizationId: "club-1", personId, status: "NEEDED" });

    await removeRosterMember("club-1", id, actor, now);

    expect(db.needs).toEqual([]);
    expect(db.people.some((person) => person.id === personId)).toBe(false);
    const audits = mocks.writeAuditLog.mock.calls.map(([entry]) => entry);
    expect(audits.find((entry) => entry.action === "CLUB_ORDER_NEEDS_CANCELLED_ON_REMOVAL").metadata).toMatchObject({ needCount: 1 });
    expect(audits.find((entry) => entry.action === "CLUB_ROSTER_MEMBER_REMOVED").metadata).toMatchObject({ personDeleted: true, ordersCancelled: 1 });
  });

  it("keeps the person and an already-ordered need, ending only the membership (#566)", async () => {
    const { memberId: id } = await addRosterMember("club-1", "2026-27", youth, actor, { now });
    const personId = db.members[0].personId as string;
    db.needs.push(
      { id: "need-open", organizationId: "club-1", personId, status: "NEEDED" },
      { id: "need-ordered", organizationId: "club-1", personId, status: "ORDERED" },
    );

    await removeRosterMember("club-1", id, actor, now);

    expect(db.needs.map((need) => need.id)).toEqual(["need-ordered"]);
    expect(db.people.some((person) => person.id === personId)).toBe(true);
    expect(db.members[0]).toMatchObject({ status: "REMOVED", personId: null });
    const removal = mocks.writeAuditLog.mock.calls.map(([entry]) => entry).find((entry) => entry.action === "CLUB_ROSTER_MEMBER_REMOVED");
    expect(removal.metadata).toMatchObject({ personDeleted: false, ordersCancelled: 1 });
  });

  it("keeps the person who has a class completion (#566)", async () => {
    const { memberId: id } = await addRosterMember("club-1", "2026-27", youth, actor, { now });
    const personId = db.members[0].personId as string;
    db.classCompletions.add(personId);

    await removeRosterMember("club-1", id, actor, now);

    expect(db.people.some((person) => person.id === personId)).toBe(true);
  });
});
