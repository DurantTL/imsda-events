import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getPrisma: vi.fn(), writeAuditLog: vi.fn(), transactionOptions: [] as unknown[] }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));

import {
  auditClubHonorsExport,
  listActiveHonorOptions,
  listClubHonorsPage,
  listMemberHonorHistory,
  recordMemberHonorEntries,
  voidMemberHonorEntry,
  voidMemberHonorEntryAsStaff,
} from "@/modules/honors/member-honor-repository";

type Row = Record<string, unknown> & { id: string };

const now = new Date("2026-09-28T12:00:00Z");
const actor = { accountId: "account-director" };

/** A small in-memory stand-in for the Prisma calls the member-honor module makes. */
function fakeDatabase() {
  let sequence = 0;
  let seq = 0;
  const db = {
    people: [] as Row[],
    members: [] as Row[],
    honors: [{ id: "honor-1", code: "AR-011", name: "Basic Rescue", isActive: true }] as Row[],
    entries: [] as Row[],
    voids: [] as Row[],
    accounts: [{ id: "account-director", displayName: "Dana Director" }] as Row[],
  };
  const id = (prefix: string) => `${prefix}-${++sequence}`;
  const withPerson = (member: Row) => ({ ...member, person: db.people.find((person) => person.id === member.personId) ?? null });
  const withRelations = (entry: Row) => ({
    ...entry,
    honor: db.honors.find((honor) => honor.id === entry.honorId),
    recordedByAccount: entry.recordedByAccountId ? db.accounts.find((account) => account.id === entry.recordedByAccountId) ?? null : null,
    recordedByUser: null,
    organization: { name: `Club ${entry.organizationId}` },
    void: withVoid(entry.id),
  });
  const withVoid = (entryId: string) => {
    const row = db.voids.find((voidRow) => voidRow.entryId === entryId);
    return row
      ? {
        reason: row.reason,
        createdAt: row.createdAt,
        voidedByAccount: row.voidedByAccountId ? db.accounts.find((account) => account.id === row.voidedByAccountId) ?? null : null,
        voidedByUser: null,
      }
      : null;
  };
  const client = {
    memberHonorEntryVoid: {
      create: async ({ data }: { data: Row }) => {
        if (db.voids.some((row) => row.entryId === data.entryId)) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        const row = { ...data, id: id("void"), createdAt: now };
        db.voids.push(row);
        return { id: row.id };
      },
    },
    honor: {
      findUnique: async ({ where }: { where: Row }) => db.honors.find((honor) => honor.id === where.id) ?? null,
      findMany: async () => db.honors
        .filter((honor) => honor.isActive)
        .map((honor) => ({ id: honor.id, code: honor.code, name: honor.name })),
    },
    clubRosterMember: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        const ids = (where.id as { in: string[] } | undefined)?.in;
        const statusOk = (status: unknown) => {
          if (where.status === undefined) return true;
          if (where.status && typeof where.status === "object" && "not" in (where.status as object)) {
            return status !== (where.status as { not: unknown }).not;
          }
          return status === where.status;
        };
        return db.members
          .filter((member) => member.organizationId === where.organizationId
            && (!ids || ids.includes(member.id))
            && (where.clubYear === undefined || member.clubYear === where.clubYear)
            && statusOk(member.status)
            && member.personId !== null)
          .map(withPerson);
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const member = db.members.find((row) => row.id === where.id && row.organizationId === where.organizationId && row.status !== "REMOVED");
        return member ? withPerson(member) : null;
      },
    },
    memberHonorEntry: {
      create: async ({ data }: { data: Row }) => {
        const row = { ...data, id: id("entry"), seq: ++seq, createdAt: now };
        db.entries.push(row);
        return { id: row.id };
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = db.entries.find((entry) => entry.id === where.id);
        return row ? { ...row, honor: db.honors.find((honor) => honor.id === row.honorId), void: db.voids.some((v) => v.entryId === row.id) ? { id: "void" } : null } : null;
      },
      findFirst: async ({ where }: { where: { id: string; personId: string } }) => {
        const row = db.entries.find((entry) => entry.id === where.id && entry.personId === where.personId);
        return row ? { ...row, honor: db.honors.find((honor) => honor.id === row.honorId), void: db.voids.some((v) => v.entryId === row.id) ? { id: "void" } : null } : null;
      },
      findMany: async ({ where }: { where: { personId: string | { in: string[] } } }) => {
        const personId = where.personId;
        const matches = typeof personId === "string"
          ? (row: Row) => row.personId === personId
          : (row: Row) => (personId as { in: string[] }).in.includes(row.personId as string);
        return db.entries.filter(matches).sort((a, b) => (b.seq as number) - (a.seq as number)).map(withRelations);
      },
    },
  };
  mocks.getPrisma.mockReturnValue({
    ...client,
    $transaction: async (work: (tx: typeof client) => unknown, options?: unknown) => {
      mocks.transactionOptions.push(options);
      return work(client);
    },
  });
  return { ...db, client };
}

function addMember(db: ReturnType<typeof fakeDatabase>, overrides: Partial<Row> = {}) {
  const personId = overrides.personId as string ?? `person-${db.people.length + 1}`;
  if (!db.people.some((person) => person.id === personId)) {
    db.people.push({ id: personId, firstName: "Test", lastName: `Member${db.people.length + 1}` });
  }
  const member: Row = {
    id: `member-${db.members.length + 1}`,
    organizationId: "club-1",
    clubYear: "2026-27",
    status: "ACTIVE",
    classLevel: "EXPLORER",
    personId,
    ...overrides,
  };
  db.members.push(member);
  return member;
}

let db: ReturnType<typeof fakeDatabase>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transactionOptions.length = 0;
  mocks.writeAuditLog.mockResolvedValue({});
  db = fakeDatabase();
});

describe("recordMemberHonorEntries", () => {
  it("bulk-marks the same honor for 20+ members in one call, one entry each", async () => {
    const members = Array.from({ length: 24 }, () => addMember(db));
    await recordMemberHonorEntries(
      "club-1",
      members.map((member) => member.id as string),
      { honorId: "honor-1", status: "IN_PROGRESS", completionDate: "", note: "" },
      actor,
      now,
    );
    expect(db.entries).toHaveLength(24);
    expect(new Set(db.entries.map((entry) => entry.personId)).size).toBe(24);
    expect(mocks.writeAuditLog).toHaveBeenCalledTimes(24);
  });

  it("handles a 500-member batch in one transaction with an explicit timeout, auditing inside it", async () => {
    const members = Array.from({ length: 500 }, () => addMember(db));
    await recordMemberHonorEntries(
      "club-1",
      members.map((member) => member.id as string),
      { honorId: "honor-1", status: "COMPLETED", completionDate: "2026-09-27", note: "" },
      actor,
      now,
    );
    expect(db.entries).toHaveLength(500);
    expect(mocks.transactionOptions).toEqual([expect.objectContaining({ timeout: 60_000, maxWait: 10_000 })]);
    // Every audit row is written on the transaction client, so it rolls back with the entries.
    expect(mocks.writeAuditLog).toHaveBeenCalledTimes(500);
    for (const [, client] of mocks.writeAuditLog.mock.calls) expect(client).toBe(db.client);
  });

  it("refuses a completion date that isn't a real calendar day, writing nothing", async () => {
    const member = addMember(db);
    await expect(recordMemberHonorEntries("club-1", [member.id as string], {
      honorId: "honor-1", status: "COMPLETED", completionDate: "2026-13-45", note: "",
    }, actor, now)).rejects.toMatchObject({ code: "ENTRY_INVALID" });
    expect(db.entries).toHaveLength(0);
  });

  it("refuses a completed honor with no completion date, writing nothing", async () => {
    const member = addMember(db);
    await expect(recordMemberHonorEntries("club-1", [member.id as string], {
      honorId: "honor-1", status: "COMPLETED", completionDate: "", note: "",
    }, actor, now)).rejects.toMatchObject({ code: "ENTRY_INVALID" });
    expect(db.entries).toHaveLength(0);
  });

  it("refuses an honor that doesn't exist", async () => {
    const member = addMember(db);
    await expect(recordMemberHonorEntries("club-1", [member.id as string], {
      honorId: "missing", status: "IN_PROGRESS", completionDate: "", note: "",
    }, actor, now)).rejects.toMatchObject({ code: "HONOR_NOT_FOUND" });
  });

  it("refuses a member who isn't on this club's roster", async () => {
    const other = addMember(db, { organizationId: "club-2" });
    await expect(recordMemberHonorEntries("club-1", [other.id as string], {
      honorId: "honor-1", status: "IN_PROGRESS", completionDate: "", note: "",
    }, actor, now)).rejects.toMatchObject({ code: "MEMBER_NOT_FOUND" });
  });

  it("appends a correction as a new entry, never editing history in place", async () => {
    const member = addMember(db);
    await recordMemberHonorEntries("club-1", [member.id as string], {
      honorId: "honor-1", status: "COMPLETED", completionDate: "2026-09-01", note: "First pass",
    }, actor, now);
    await recordMemberHonorEntries("club-1", [member.id as string], {
      honorId: "honor-1", status: "IN_PROGRESS", completionDate: "", note: "Reopened: missed a requirement",
    }, actor, now);

    expect(db.entries).toHaveLength(2);
    const history = await listMemberHonorHistory("club-1", member.id as string);
    expect(history.history).toHaveLength(2);
    // Newest first, and the older entry is untouched.
    expect(history.history[0]).toMatchObject({ status: "IN_PROGRESS", note: "Reopened: missed a requirement" });
    expect(history.history[1]).toMatchObject({ status: "COMPLETED", note: "First pass" });
    // The current status (what the roster card and Honors page show) is the latest entry only.
    expect(history.current).toEqual([expect.objectContaining({ status: "IN_PROGRESS" })]);
  });
});

describe("voidMemberHonorEntry (#591)", () => {
  const record = (member: Row, status: "IN_PROGRESS" | "COMPLETED", note = "") => recordMemberHonorEntries("club-1", [member.id as string], {
    honorId: "honor-1", status, completionDate: status === "COMPLETED" ? "2026-09-01" : "", note,
  }, actor, now);

  it("voiding the latest entry makes the previous non-voided entry current, keeping every row", async () => {
    const member = addMember(db);
    await record(member, "IN_PROGRESS", "Started");
    await record(member, "COMPLETED", "Marked by mistake");
    const mistaken = db.entries[1];

    await voidMemberHonorEntry("club-1", member.id as string, mistaken.id, "  Marked completed by mistake  ", actor);

    expect(db.entries).toHaveLength(2);
    expect(db.voids).toEqual([expect.objectContaining({ entryId: mistaken.id, reason: "Marked completed by mistake", voidedByAccountId: "account-director" })]);
    const history = await listMemberHonorHistory("club-1", member.id as string);
    expect(history.history).toHaveLength(2);
    expect(history.history[0]).toMatchObject({
      id: mistaken.id,
      voided: { reason: "Marked completed by mistake", voidedByName: "Dana Director" },
    });
    expect(history.current).toEqual([expect.objectContaining({ status: "IN_PROGRESS" })]);
    const rows = await listClubHonorsPage("club-1", "2026-27");
    expect(rows[0].honors).toEqual([expect.objectContaining({ status: "IN_PROGRESS" })]);
  });

  it("leaves no status when every entry is voided, and audits each void inside the transaction", async () => {
    const member = addMember(db);
    await record(member, "COMPLETED");
    await voidMemberHonorEntry("club-1", member.id as string, db.entries[0].id, "Wrong person", actor);
    expect((await listMemberHonorHistory("club-1", member.id as string)).current).toEqual([]);
    expect((await listClubHonorsPage("club-1", "2026-27"))[0].honors).toEqual([]);
    expect(mocks.writeAuditLog).toHaveBeenLastCalledWith(expect.objectContaining({
      action: "MEMBER_HONOR_VOIDED",
      entityId: db.entries[0].id,
      metadata: expect.objectContaining({ organizationId: "club-1", voidId: db.voids[0].id }),
    }), db.client);
  });

  it("attributes a staff act-as void to the staff user", async () => {
    const member = addMember(db);
    await record(member, "COMPLETED");
    await voidMemberHonorEntry("club-1", member.id as string, db.entries[0].id, "Wrong honor", { userId: "user-9", actAsId: "actas-1" });
    expect(db.voids[0]).toMatchObject({ voidedByUserId: "user-9" });
    expect(db.voids[0]).not.toHaveProperty("voidedByAccountId");
  });

  it("refuses a second void of the same entry (409 path), writing no second row", async () => {
    const member = addMember(db);
    await record(member, "COMPLETED");
    await voidMemberHonorEntry("club-1", member.id as string, db.entries[0].id, "Wrong person", actor);
    await expect(voidMemberHonorEntry("club-1", member.id as string, db.entries[0].id, "Again", actor))
      .rejects.toMatchObject({ code: "ENTRY_ALREADY_VOIDED" });
    expect(db.voids).toHaveLength(1);
  });

  it("turns a racing duplicate (unique entryId violation) into the same already-voided error", async () => {
    const member = addMember(db);
    await record(member, "COMPLETED");
    db.voids.push({ id: "void-race", entryId: db.entries[0].id, reason: "Racer" });
    // The pre-check reads the entry as not yet voided; the unique key still catches it.
    const original = db.client.memberHonorEntry as unknown as { findFirst: (args: never) => Promise<unknown> };
    const realFindFirst = original.findFirst;
    original.findFirst = async (args: never) => ({ ...(await realFindFirst(args) as object), void: null });
    await expect(voidMemberHonorEntry("club-1", member.id as string, db.entries[0].id, "Wrong person", actor))
      .rejects.toMatchObject({ code: "ENTRY_ALREADY_VOIDED" });
    original.findFirst = realFindFirst;
  });

  it("refuses an entry another club recorded, and an entry that isn't this person's", async () => {
    const member = addMember(db);
    const other = addMember(db, { organizationId: "club-2" });
    db.entries.push({ id: "entry-other", seq: 99, personId: member.personId, honorId: "honor-1", status: "COMPLETED", organizationId: "club-2" });
    await expect(voidMemberHonorEntry("club-1", member.id as string, "entry-other", "Not ours to void", actor))
      .rejects.toMatchObject({ code: "VOID_NOT_ALLOWED" });
    await expect(voidMemberHonorEntry("club-1", member.id as string, "missing", "No such entry", actor))
      .rejects.toMatchObject({ code: "ENTRY_NOT_FOUND" });
    await expect(voidMemberHonorEntry("club-1", other.id as string, "entry-other", "Other club's member", actor))
      .rejects.toMatchObject({ code: "MEMBER_NOT_FOUND" });
    expect(db.voids).toHaveLength(0);
  });

  it("requires a 3 to 500 character reason", async () => {
    const member = addMember(db);
    await record(member, "COMPLETED");
    for (const reason of ["", "  ok ", "x".repeat(501)]) {
      await expect(voidMemberHonorEntry("club-1", member.id as string, db.entries[0].id, reason, actor))
        .rejects.toMatchObject({ code: "ENTRY_INVALID" });
    }
    expect(db.voids).toHaveLength(0);
  });
});

describe("voidMemberHonorEntryAsStaff (#591)", () => {
  it("voids an entry recorded by a deactivated club that no longer has the member, with no roster or club check", async () => {
    // Club 2 is gone from the roster fake entirely: no member rows, no organization row.
    db.entries.push({ id: "entry-old", seq: 5, personId: "person-gone", honorId: "honor-1", status: "COMPLETED", completionDate: "2026-05-01", organizationId: "club-2-deactivated" });
    await voidMemberHonorEntryAsStaff("entry-old", "  Entered for the wrong honor  ", "staff-1");
    expect(db.entries).toHaveLength(1);
    expect(db.voids).toEqual([expect.objectContaining({ entryId: "entry-old", reason: "Entered for the wrong honor", voidedByUserId: "staff-1" })]);
    expect(db.voids[0]).not.toHaveProperty("voidedByAccountId");
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: "staff-1",
      action: "MEMBER_HONOR_VOIDED",
      entityId: "entry-old",
      metadata: expect.objectContaining({ organizationId: "club-2-deactivated", staffVoid: true }),
    }), db.client);
  });

  it("refuses a double void and writes no second row", async () => {
    db.entries.push({ id: "entry-old", seq: 5, personId: "person-gone", honorId: "honor-1", status: "COMPLETED", organizationId: "club-2" });
    await voidMemberHonorEntryAsStaff("entry-old", "Wrong honor", "staff-1");
    await expect(voidMemberHonorEntryAsStaff("entry-old", "Again", "staff-2")).rejects.toMatchObject({ code: "ENTRY_ALREADY_VOIDED" });
    expect(db.voids).toHaveLength(1);
  });

  it("refuses a missing entry and a reason outside 3 to 500 characters", async () => {
    db.entries.push({ id: "entry-old", seq: 5, personId: "person-gone", honorId: "honor-1", status: "COMPLETED", organizationId: "club-2" });
    await expect(voidMemberHonorEntryAsStaff("missing", "No such entry", "staff-1")).rejects.toMatchObject({ code: "ENTRY_NOT_FOUND" });
    for (const reason of ["", "ab", "x".repeat(501)]) {
      await expect(voidMemberHonorEntryAsStaff("entry-old", reason, "staff-1")).rejects.toMatchObject({ code: "ENTRY_INVALID" });
    }
    expect(db.voids).toHaveLength(0);
  });

  it("turns a racing duplicate (unique entryId violation) into already voided", async () => {
    db.entries.push({ id: "entry-old", seq: 5, personId: "person-gone", honorId: "honor-1", status: "COMPLETED", organizationId: "club-2" });
    db.voids.push({ id: "void-race", entryId: "entry-old", reason: "Racer" });
    const entries = db.client.memberHonorEntry as unknown as { findUnique: (args: never) => Promise<unknown> };
    const real = entries.findUnique;
    entries.findUnique = async (args: never) => ({ ...(await real(args) as object), void: null });
    await expect(voidMemberHonorEntryAsStaff("entry-old", "Wrong honor", "staff-1")).rejects.toMatchObject({ code: "ENTRY_ALREADY_VOIDED" });
    entries.findUnique = real;
  });
});

describe("listClubHonorsPage and rollover", () => {
  it("shows a member's honor after a rollover carries them to a new club-year roster row, without duplicating the entry", async () => {
    const lastYear = addMember(db, { clubYear: "2025-26" });
    await recordMemberHonorEntries("club-1", [lastYear.id as string], {
      honorId: "honor-1", status: "COMPLETED", completionDate: "2026-05-01", note: "",
    }, actor, now);

    // #414's planned rollover: a new roster row for the new club year, same
    // person, last year's row left as read-only history (never removed).
    const thisYear = addMember(db, { clubYear: "2026-27", personId: lastYear.personId });

    const rows = await listClubHonorsPage("club-1", "2026-27");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ memberId: thisYear.id, honors: [expect.objectContaining({ status: "COMPLETED" })] });
    // Still exactly one entry on file — rollover reads the same row, it never copies it.
    expect(db.entries).toHaveLength(1);

    // Last year's roster row still resolves to the very same entry — the
    // record was never copied, just found again by the same personId.
    const lastYearRows = await listClubHonorsPage("club-1", "2025-26");
    expect(lastYearRows).toEqual([
      expect.objectContaining({ memberId: lastYear.id, honors: [expect.objectContaining({ status: "COMPLETED" })] }),
    ]);
  });
});

describe("auditClubHonorsExport", () => {
  it("records the club, year, and row count, with no names", async () => {
    await auditClubHonorsExport("club-1", "2026-27", 12, actor, false);
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "CLUB_HONORS_EXPORTED",
      entityType: "Organization",
      entityId: "club-1",
      metadata: { organizationId: "club-1", clubYear: "2026-27", rowCount: 12, readOnly: false, actorAttendeeAccountId: "account-director" },
    }));
  });

  it("attributes a staff act-as viewer to the staff user", async () => {
    await auditClubHonorsExport("club-1", "2026-27", 3, { userId: "user-9", actAsId: "actas-1" }, true);
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: "user-9",
      metadata: expect.objectContaining({ actAsId: "actas-1", readOnly: true }),
    }));
  });
});

describe("listActiveHonorOptions", () => {
  it("lists only active catalog honors", async () => {
    db.honors.push({ id: "honor-2", code: "AR-020", name: "Retired Honor", isActive: false });
    expect(await listActiveHonorOptions()).toEqual([{ id: "honor-1", code: "AR-011", name: "Basic Rescue" }]);
  });
});
