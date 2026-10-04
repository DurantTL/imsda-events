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
  const db = { guardians: [] as Row[], people: [] as Row[], members: [] as Row[], otherReferences: new Set<string>(), guardianReferences: new Set<string>(), honorEntries: [] as Row[], needs: [] as Row[], blankedTransferWhere: [] as unknown[], classCompletions: [] as Row[], attendanceErased: [] as string[], calls: [] as string[], transferBlanks: [] as unknown[] };
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
    $executeRaw: async () => { db.calls.push("lock"); return 0; },
    $queryRaw: async () => { db.calls.push("person-row-lock"); return []; },
    $executeRawUnsafe: async () => 0,
    person: {
      create: async ({ data }: { data: Row }) => { const row = { ...data, id: `person-${++sequence}` }; db.people.push(row); return row; },
      update: async ({ where, data }: { where: Row; data: Row }) => Object.assign(db.people.find((person) => person.id === where.id)!, data),
      delete: async ({ where }: { where: Row }) => { db.people = db.people.filter((person) => person.id !== where.id); },
      findUnique: async ({ where, select }: { where: Row; select?: { _count?: { select?: Record<string, boolean> } } }) => {
        const person = db.people.find((row) => row.id === where.id);
        if (!person) return null;
        const referenced = db.otherReferences.has(person.id) ? 1 : 0;
        // Declared guardian authority (#131) points at the Person with `onDelete: Restrict`; the count only exists if the
        // removal asked for it, so a missing relation in the guard shows up as the person being deleted anyway.
        const guardian = db.guardianReferences.has(person.id) ? 1 : 0;
        const requested = select?._count?.select ?? {};
        const guardianCounts = Object.fromEntries(
          ["guardianAuthoritiesAsMinor", "guardianAuthoritiesAsAdult", "guardianAuthoritiesDeclared", "guardianConflictsAsMinor", "guardianConflictsAsAdult"]
            .filter((key) => requested[key]).map((key) => [key, guardian]),
        );
        return {
          _count: {
            householdMembers: 0, heldRegistrations: 0, registrationEvents: referenced, externalIdentities: 0,
            notes: 0, attendeeAccountLinks: 0, userLinks: 0,
            memberClassCompletions: db.classCompletions.filter((row) => row.personId === person.id).length,
            clubRosterMemberships: db.members.filter((member) => member.personId === person.id).length,
            ...guardianCounts,
          },
        };
      },
    },
    // Transfer records (#489) are blanked, never counted, when a person is erased.
    memberTransfer: {
      findMany: async ({ where }: { where: { status?: unknown } }) => { if (where.status) db.blankedTransferWhere.push({ status: where.status }); return [{ id: "transfer-1" }]; },
      updateMany: async (args: unknown) => { db.transferBlanks.push(args); return { count: 1 }; },
    },
    memberTransferEvent: {
      updateMany: async (args: unknown) => { db.transferBlanks.push(args); return { count: 1 }; },
    },
    memberTransferRegistrationMove: {
      updateMany: async (args: unknown) => { db.transferBlanks.push(args); return { count: 0 }; },
    },
    clubRosterGuardian: {
      upsert: async ({ where, create, update }: { where: { rosterMemberId_position: { rosterMemberId: string; position: number } }; create: Row; update: Row }) => {
        const key = where.rosterMemberId_position;
        const found = db.guardians.find((row) => row.rosterMemberId === key.rosterMemberId && row.position === key.position);
        if (found) return Object.assign(found, update);
        const row = { ...create, id: `guardian-${++sequence}` };
        db.guardians.push(row);
        return row;
      },
      deleteMany: async ({ where }: { where: { rosterMemberId: string; position?: { in: number[] } } }) => {
        const before = db.guardians.length;
        db.guardians = db.guardians.filter((row) => !(row.rosterMemberId === where.rosterMemberId
          && (where.position === undefined || where.position.in.includes(row.position as number))));
        return { count: before - db.guardians.length };
      },
    },
    healthRecord: { deleteMany: async () => ({ count: 0 }) },
    healthRecordLink: { updateMany: async () => ({ count: 0 }) },
    clubMeetingAttendance: {
      deleteMany: async ({ where }: { where: { rosterMemberId: string } }) => { db.attendanceErased.push(where.rosterMemberId); return { count: 1 }; },
    },
    memberClassCompletion: {
      deleteMany: async ({ where }: { where: Row }) => {
        db.calls.push("erase-completions");
        const before = db.classCompletions.length;
        db.classCompletions = db.classCompletions.filter((row) => !(row.organizationId === where.organizationId && row.personId === where.personId));
        return { count: before - db.classCompletions.length };
      },
    },
    clubOrderNeed: {
      count: async ({ where }: { where: Row }) => db.needs.filter((need) => matches(need, where)).length,
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
      update: async ({ where, data }: { where: Row; data: Row }) => { db.calls.push("erase-row"); return Object.assign(db.members.find((member) => member.id === where.id)!, data); },
      findUnique: async ({ where }: { where: Row }) => db.members.find((member) => member.id === where.id) ?? null,
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        db.calls.push("find-member");
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

  describe("guardian contacts (#510)", () => {
    const first = { name: "Synthetic Guardian One", relationship: "Mother", email: "guardian.one@example.test", phone: "(555) 010-0101" };
    const second = { name: "Synthetic Guardian Two", relationship: "Uncle", email: "", phone: "555-010-0202" };
    const blank = { name: "", relationship: "", email: "", phone: "" };
    const onFile = (id: string) => db.guardians.filter((row) => row.rosterMemberId === id).map((row) => ({ position: row.position, name: row.name }));

    it("keeps up to two guardians under positions 1 and 2 when a member is added", async () => {
      const { memberId } = await addRosterMember("club-1", "2026-27", { ...youth, guardians: [first, second] }, actor, { now });
      expect(onFile(memberId)).toEqual([{ position: 1, name: first.name }, { position: 2, name: second.name }]);
      expect(db.guardians[0]).toMatchObject({ relationship: "Mother", email: first.email, phone: first.phone });
    });

    it("leaves guardians alone when an edit does not send them", async () => {
      const { memberId } = await addRosterMember("club-1", "2026-27", { ...youth, guardians: [first] }, actor, { now });
      await updateRosterMember("club-1", memberId, { role: "TLT" }, actor, now);
      expect(onFile(memberId)).toEqual([{ position: 1, name: first.name }]);
    });

    it("replaces the whole set on an edit: a blank or missing slot removes that guardian", async () => {
      const { memberId } = await addRosterMember("club-1", "2026-27", { ...youth, guardians: [first, second] }, actor, { now });
      await updateRosterMember("club-1", memberId, { guardians: [{ ...first, name: "Renamed Guardian" }, blank] }, actor, now);
      expect(onFile(memberId)).toEqual([{ position: 1, name: "Renamed Guardian" }]);
      await updateRosterMember("club-1", memberId, { guardians: [] }, actor, now);
      expect(onFile(memberId)).toEqual([]);
    });

    it("deletes every guardian when the member is removed, and only that member's", async () => {
      const { memberId } = await addRosterMember("club-1", "2026-27", { ...youth, guardians: [first, second] }, actor, { now });
      const { memberId: other } = await addRosterMember("club-1", "2026-27", { ...youth, firstName: "Other", guardians: [first] }, actor, { now });
      await removeRosterMember("club-1", memberId, actor, now);
      expect(onFile(memberId)).toEqual([]);
      expect(onFile(other)).toHaveLength(1);
      const removedAudit = mocks.writeAuditLog.mock.calls.map(([entry]) => entry).find((entry) => entry.action === "CLUB_ROSTER_MEMBER_REMOVED");
      expect(removedAudit.metadata).toMatchObject({ guardiansErased: 2 });
    });

    it("refuses guardian writes on a row from another club year, and writes nothing", async () => {
      const { memberId } = await addRosterMember("club-1", "2026-27", { ...youth, guardians: [first] }, actor, { now });
      db.members.find((row) => row.id === memberId)!.clubYear = "2025-26";
      await expect(updateRosterMember("club-1", memberId, { guardians: [second] }, actor, now))
        .rejects.toMatchObject({ code: "GUARDIANS_PRIOR_YEAR" });
      await expect(updateRosterMember("club-1", memberId, { guardians: [] }, actor, now))
        .rejects.toMatchObject({ code: "GUARDIANS_PRIOR_YEAR" });
      expect(onFile(memberId)).toEqual([{ position: 1, name: first.name }]);
      // Other edits to that row still work.
      await expect(updateRosterMember("club-1", memberId, { role: "TLT" }, actor, now)).resolves.toBeDefined();
    });

    it("keeps guardian values out of every audit entry: field names and counts only", async () => {
      const { memberId } = await addRosterMember("club-1", "2026-27", { ...youth, guardians: [first, second] }, actor, { now });
      await updateRosterMember("club-1", memberId, { guardians: [second, blank] }, actor, now);
      await removeRosterMember("club-1", memberId, actor, now);
      const entries = mocks.writeAuditLog.mock.calls.map(([entry]) => entry);
      const text = JSON.stringify(entries);
      for (const value of [first.name, second.name, first.email, first.phone, second.phone, "Mother", "Uncle"]) expect(text).not.toContain(value);
      expect(entries.find((entry) => entry.action === "CLUB_ROSTER_MEMBER_ADDED").metadata).toMatchObject({ guardiansStored: 2 });
      expect(entries.find((entry) => entry.action === "CLUB_ROSTER_MEMBER_UPDATED").metadata).toMatchObject({ fields: ["guardians"], guardiansStored: 1, guardiansCleared: 1 });
    });
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
    Object.assign(db.people[1], { normalizedEmail: "other@example.test", phone: "555-0103" });

    await removeRosterMember("club-1", lone, actor, now);
    await removeRosterMember("club-1", registered, actor, now);

    for (const member of db.members) {
      expect(member).toMatchObject({ status: "REMOVED", sealedBirthDate: null, personId: null, gender: null, role: "", removedAt: now });
    }
    expect(db.people.map((person) => person.firstName)).toEqual(["Other"]);
    // Meeting attendance (#653) names the member by roster row, so it goes with them.
    expect(db.attendanceErased).toEqual([lone, registered]);
    // Contact fields are registration data (claiming, dedupe, matching): a registered person keeps them.
    expect(db.people[0]).toMatchObject({ normalizedEmail: "other@example.test", phone: "555-0103" });
    // A deleted person's transfer records (#489) keep no free text; a kept, registered person's are untouched.
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

  it("keeps the person when a responsible-adult declaration or review item refers to them (#131)", async () => {
    const { memberId: id } = await addRosterMember("club-1", "2026-27", youth, actor, { now });
    const personId = db.members[0].personId as string;
    db.guardianReferences.add(personId);

    await removeRosterMember("club-1", id, actor, now);

    // The foreign keys are `onDelete: Restrict`, so deleting the person would fail; the guard keeps them instead.
    expect(db.people.some((person) => person.id === personId)).toBe(true);
    const removal = mocks.writeAuditLog.mock.calls.map(([entry]) => entry).find((entry) => entry.action === "CLUB_ROSTER_MEMBER_REMOVED");
    expect(removal.metadata).toMatchObject({ personDeleted: false });
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

  it("deletes this club's class completion with the person (#566)", async () => {
    const { memberId: id } = await addRosterMember("club-1", "2026-27", youth, actor, { now });
    const personId = db.members[0].personId as string;
    db.classCompletions.push({ id: "c1", organizationId: "club-1", personId });

    await removeRosterMember("club-1", id, actor, now);

    expect(db.classCompletions).toEqual([]);
    expect(db.people.some((person) => person.id === personId)).toBe(false);
  });

  it("keeps the person when another club has a class completion for them (#566)", async () => {
    const { memberId: id } = await addRosterMember("club-1", "2026-27", youth, actor, { now });
    const personId = db.members[0].personId as string;
    db.classCompletions.push({ id: "c2", organizationId: "club-2", personId });

    await removeRosterMember("club-1", id, actor, now);

    expect(db.people.some((person) => person.id === personId)).toBe(true);
    expect(db.classCompletions).toHaveLength(1);
  });

  it("keeps only the name when an ordered need remains: email and phone erased (#566)", async () => {
    const { memberId: id } = await addRosterMember("club-1", "2026-27", youth, actor, { now });
    const personId = db.members[0].personId as string;
    Object.assign(db.people.find((person) => person.id === personId)!, { normalizedEmail: "test.youth@example.test", phone: "555-0100" });
    db.needs.push({ id: "need-ordered", organizationId: "club-1", personId, status: "ORDERED" });

    const removed = await removeRosterMember("club-1", id, actor, now);

    expect(removed).toEqual({ personId, nameKept: true });
    expect(db.blankedTransferWhere).toEqual([{ status: { not: "PENDING" } }]);
    expect(db.people.find((person) => person.id === personId)).toMatchObject({ firstName: "Test", lastName: "Youth", normalizedEmail: null, phone: null });
    expect(db.transferBlanks.length).toBeGreaterThan(0);
    expect(db.members[0]).toMatchObject({ status: "REMOVED", personId: null, sealedBirthDate: null });
  });

  it("leaves another club's open need alone and keeps the person whole (#566)", async () => {
    const { memberId: id } = await addRosterMember("club-1", "2026-27", youth, actor, { now });
    const personId = db.members[0].personId as string;
    Object.assign(db.people.find((person) => person.id === personId)!, { normalizedEmail: "test.youth@example.test" });
    db.needs.push({ id: "need-mine", organizationId: "club-1", personId, status: "NEEDED" }, { id: "need-other", organizationId: "club-2", personId, status: "NEEDED" });

    const removed = await removeRosterMember("club-1", id, actor, now);

    expect(db.needs.map((need) => need.id)).toEqual(["need-other"]);
    expect(removed.nameKept).toBe(false);
    expect(db.people.find((person) => person.id === personId)).toMatchObject({ normalizedEmail: "test.youth@example.test" });
  });

  it("takes the club lock before reading the member or erasing anything (#566)", async () => {
    const { memberId: id } = await addRosterMember("club-1", "2026-27", youth, actor, { now });
    db.calls.length = 0;

    await removeRosterMember("club-1", id, actor, now);

    expect(db.calls.slice(0, 4)).toEqual(["lock", "find-member", "person-row-lock", "erase-row"]);
  });

  it("keeps a registered person's email and phone even with an ordered need, and says the name stays (#566)", async () => {
    const { memberId: id } = await addRosterMember("club-1", "2026-27", youth, actor, { now });
    const personId = db.members[0].personId as string;
    Object.assign(db.people.find((person) => person.id === personId)!, { normalizedEmail: "reg@example.test", phone: "555-0104" });
    db.otherReferences.add(personId);
    db.needs.push({ id: "need-ordered", organizationId: "club-1", personId, status: "ORDERED" });

    const removed = await removeRosterMember("club-1", id, actor, now);

    expect(removed.nameKept).toBe(true);
    expect(db.people.find((person) => person.id === personId)).toMatchObject({ normalizedEmail: "reg@example.test", phone: "555-0104" });
    expect(db.blankedTransferWhere).toEqual([]);
  });

  it("does not say the name stays when the person was kept for another reason (#566)", async () => {
    const { memberId: id } = await addRosterMember("club-1", "2026-27", youth, actor, { now });
    db.otherReferences.add(db.members[0].personId as string);

    expect((await removeRosterMember("club-1", id, actor, now)).nameKept).toBe(false);
  });
});
