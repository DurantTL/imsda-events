import { beforeEach, describe, expect, it, vi } from "vitest";

/** Synthetic data only. The roster side of "Add to roster" from a club form (#721): duplicate detection and the in-transaction add. */

const mocks = vi.hoisted(() => ({ getPrisma: vi.fn(), writeAuditLog: vi.fn(), getServerEnv: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ getServerEnv: mocks.getServerEnv }));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));

import { openSecret } from "@/lib/secret-box";
import { sealBirthDate } from "@/modules/club-rosters/birth-dates";
import { addRosterMember, addRosterMemberInTransaction, listRosterDuplicates } from "@/modules/club-rosters/repository";

type Row = Record<string, unknown> & { id: string };

const now = new Date("2026-10-05T15:00:00Z");
const actor = { accountId: "director-1" };
const input = {
  firstName: "Jordan",
  lastName: "Sample",
  birthDate: "2013-04-09",
  attendeeType: "YOUTH" as const,
  role: "Pathfinder",
  classLevel: "EXPLORER" as const,
  gender: "FEMALE" as const,
};

function fakeDatabase() {
  let sequence = 0;
  const db = { people: [] as Row[], members: [] as Row[] };
  const client = {
    person: {
      create: async ({ data }: { data: Row }) => { const row = { ...data, id: `person-${++sequence}` }; db.people.push(row); return row; },
    },
    clubRosterMember: {
      findMany: async ({ where }: { where: { organizationId: string; clubYear: string; status: { not: string }; id?: { not: string } | undefined } }) =>
        db.members
          .filter((member) => member.organizationId === where.organizationId && member.clubYear === where.clubYear && member.status !== where.status.not)
          .map((member) => ({ ...member, updatedAt: now, person: db.people.find((person) => person.id === member.personId) ?? null })),
      create: async ({ data }: { data: Row }) => { const row = { ...data, id: `member-${++sequence}`, status: "ACTIVE" }; db.members.push(row); return row; },
    },
    $transaction: async (work: (tx: unknown) => unknown) => work(client),
  };
  mocks.getPrisma.mockReturnValue(client);
  return { db, client };
}

function seedMember(db: ReturnType<typeof fakeDatabase>["db"], overrides: Partial<Row> = {}, person: Partial<Row> = {}) {
  const personRow = { id: `p-${db.people.length + 1}`, firstName: "Jordan", lastName: "Sample", ...person };
  db.people.push(personRow);
  const row = {
    id: `m-${db.members.length + 1}`, organizationId: "club-a", clubYear: "2026-27", personId: personRow.id, attendeeType: "YOUTH", status: "ACTIVE",
    sealedBirthDate: sealBirthDate("2013-04-09"), ...overrides,
  };
  db.members.push(row);
  return row;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getServerEnv.mockReturnValue({ SECRET_ENCRYPTION_KEY: "a-synthetic-encryption-key-for-roster-tests" });
  mocks.writeAuditLog.mockResolvedValue({});
});

describe("finding who is already on the roster (#721)", () => {
  it("matches the same name (case and spacing aside) and birth date in this club and year", async () => {
    const { db } = fakeDatabase();
    const match = seedMember(db);
    seedMember(db, {}, { firstName: "  jordan ", lastName: "SAMPLE" });
    const found = await listRosterDuplicates("club-a", "2026-27", "Jordan", "Sample", "2013-04-09");
    expect(found.map((member) => member.id)).toContain(match.id);
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ firstName: "Jordan", lastName: "Sample", attendeeType: "YOUTH", status: "ACTIVE" });
    // Never the birth date, sealed or open.
    expect(JSON.stringify(found)).not.toMatch(/2013|sealed|v1\./i);
  });

  it("ignores a different birth date, another club, another year and removed members", async () => {
    const { db } = fakeDatabase();
    seedMember(db, { sealedBirthDate: sealBirthDate("2013-04-10") });
    seedMember(db, { organizationId: "club-b" });
    seedMember(db, { clubYear: "2025-26" });
    seedMember(db, { status: "REMOVED" });
    // Erased rows have no birth date and no person.
    seedMember(db, { sealedBirthDate: null });
    expect(await listRosterDuplicates("club-a", "2026-27", "Jordan", "Sample", "2013-04-09")).toEqual([]);
  });

  it("finds nothing without a name and a birth date", async () => {
    const { db } = fakeDatabase();
    seedMember(db);
    expect(await listRosterDuplicates("club-a", "2026-27", "", "Sample", "2013-04-09")).toEqual([]);
    expect(await listRosterDuplicates("club-a", "2026-27", "Jordan", "Sample", "")).toEqual([]);
  });
});

describe("adding inside the caller's transaction (#721)", () => {
  it("seals the birth date, writes the audit row, and returns the ids", async () => {
    const { db, client } = fakeDatabase();
    const result = await addRosterMemberInTransaction(client as never, "club-a", "2026-27", input, actor, { now });
    expect(result).toMatchObject({ memberId: expect.any(String), personId: expect.any(String) });
    const stored = db.members[0];
    expect(stored).toMatchObject({ organizationId: "club-a", clubYear: "2026-27", source: "DIRECTOR", attendeeType: "YOUTH", createdByAccountId: "director-1" });
    expect(String(stored.sealedBirthDate)).not.toContain("2013");
    expect(openSecret(String(stored.sealedBirthDate), "club-roster:birth-date")).toBe("2013-04-09");
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "CLUB_ROSTER_MEMBER_ADDED", metadata: expect.objectContaining({ organizationId: "club-a", clubYear: "2026-27" }) }),
      client,
    );
    expect(JSON.stringify(mocks.writeAuditLog.mock.calls[0][0])).not.toMatch(/Jordan|Sample|2013/);
  });

  it("refuses a duplicate with the roster's own error, creating nothing", async () => {
    const { db, client } = fakeDatabase();
    seedMember(db);
    const before = db.members.length;
    await expect(addRosterMemberInTransaction(client as never, "club-a", "2026-27", input, actor, { now })).rejects.toMatchObject({ code: "DUPLICATE_MEMBER" });
    expect(db.members).toHaveLength(before);
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("applies the roster's birth date rules", async () => {
    const { client } = fakeDatabase();
    await expect(addRosterMemberInTransaction(client as never, "club-a", "2026-27", { ...input, birthDate: "2030-01-01" }, actor, { now })).rejects.toMatchObject({ code: "BIRTH_DATE_INVALID" });
  });

  it("is what the roster screen's add runs, in its own transaction", async () => {
    const { db } = fakeDatabase();
    await addRosterMember("club-a", "2026-27", input, actor, { now });
    expect(db.members).toHaveLength(1);
    await expect(addRosterMember("club-a", "2026-27", { ...input, birthDate: "2030-01-01" }, actor, { now })).rejects.toMatchObject({ code: "BIRTH_DATE_INVALID" });
  });
});
