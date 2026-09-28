import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  writeAuditLog: vi.fn(),
  personIdForActor: vi.fn(),
  uncachedChecksForRosterMembers: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/background-checks/repository", async () => {
  const actual = await vi.importActual<typeof import("@/modules/background-checks/repository")>("@/modules/background-checks/repository");
  return { ...actual, uncachedChecksForRosterMembers: mocks.uncachedChecksForRosterMembers };
});
vi.mock("@/modules/driver-verification/access", async () => {
  const actual = await vi.importActual<typeof import("@/modules/driver-verification/access")>("@/modules/driver-verification/access");
  return { ...actual, personIdForActor: mocks.personIdForActor };
});

import {
  clubDriverEntries,
  clubDriverLabels,
  listDriverExceptions,
  recordDriverClearance,
  type DriverVerificationError,
} from "@/modules/driver-verification/repository";

const now = new Date("2026-10-01T15:00:00Z");

type Row = Record<string, unknown>;

function fakeDatabase() {
  const members: Row[] = [];
  const verifications = new Map<string, Row>();
  const client = {
    clubRosterMember: {
      findMany: async ({ where }: { where: Row }) => members.filter((member) => matches(member, where)),
    },
    driverVerification: {
      upsert: vi.fn(async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
        const existing = verifications.get(where.personId as string);
        const row = existing ? { ...existing, ...update } : { ...create };
        verifications.set(where.personId as string, row);
        return row;
      }),
    },
  };
  mocks.getPrisma.mockReturnValue({ ...client, $transaction: async (work: (tx: typeof client) => unknown) => work(client) });
  return { members, verifications, client };
}

function matches(row: Row, where: Row) {
  return Object.entries(where).every(([key, value]) => {
    if (value === undefined) return true;
    if (value && typeof value === "object" && "in" in (value as Row)) return (value as { in: unknown[] }).in.includes(row[key]);
    return row[key] === value;
  });
}

type Entry = { complianceStatus: string | null; expiresOn: string | null; issuesNote: string | null };

function member(overrides: Row = {}, entry: Entry | null = { complianceStatus: "CLEAR", expiresOn: null, issuesNote: null }, verification: Row | null = null): Row {
  return {
    id: "member-1",
    personId: "person-1",
    organizationId: "club-1",
    clubYear: "2026-27",
    status: "ACTIVE",
    willingToDrive: true,
    attendeeType: "STAFF",
    organization: { name: "Club One" },
    person: {
      firstName: "Dana",
      lastName: "Driver",
      backgroundCheckMatch: entry ? { entry } : null,
      driverVerification: verification,
    },
    ...overrides,
  };
}

const withCheck = (id: string, entry: Entry, extra: Row = {}) =>
  member({ id: `member-${id}`, personId: `person-${id}`, ...extra }, entry);

let db: ReturnType<typeof fakeDatabase>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.writeAuditLog.mockResolvedValue({});
  mocks.personIdForActor.mockResolvedValue(null);
  mocks.uncachedChecksForRosterMembers.mockResolvedValue(new Map());
  db = fakeDatabase();
});

describe("the staff driver exceptions (#544)", () => {
  it("clears a willing driver with a current y and no issues, with no staff action", async () => {
    db.members.push(member());
    expect(await listDriverExceptions(now)).toEqual([]);
  });

  it("lists only exceptions: needs review, not cleared, and expiring within 30 days", async () => {
    db.members.push(
      withCheck("1", { complianceStatus: "CLEAR", expiresOn: null, issuesNote: null }),
      withCheck("2", { complianceStatus: "NOT_COMPLIANT", expiresOn: null, issuesNote: "BGC" }),
      withCheck("3", { complianceStatus: "FLAGGED", expiresOn: null, issuesNote: "Training (10/04/26)" }),
      withCheck("4", { complianceStatus: "CLEAR", expiresOn: null, issuesNote: "Non-Driver" }),
      withCheck("5", { complianceStatus: "CLEAR", expiresOn: null, issuesNote: "BGC (10/20/26)" }),
      withCheck("6", { complianceStatus: "CLEAR", expiresOn: null, issuesNote: "BGC (12/20/26)" }),
      member({ id: "member-7", personId: "person-7" }, null),
    );
    const entries = await listDriverExceptions(now);
    expect(entries.map((entry) => [entry.personId, entry.clearance.status])).toEqual([
      ["person-2", "NOT_CLEARED"],
      ["person-3", "NEEDS_REVIEW"],
      ["person-4", "NOT_CLEARED"],
      ["person-5", "EXPIRING"],
      ["person-7", "NEEDS_REVIEW"],
    ]);
    expect(entries.find((entry) => entry.personId === "person-5")!.clearance).toMatchObject({ expiresOn: "2026-10-20", warnStaff: true });
  });

  it("gives staff the issues text exactly as written", async () => {
    db.members.push(withCheck("1", { complianceStatus: "NOT_COMPLIANT", expiresOn: null, issuesNote: "Training (10/04/26),  bgc" }));
    const [entry] = await listDriverExceptions(now);
    expect(entry!.issuesText).toBe("Training (10/04/26),  bgc");
    expect(entry).toMatchObject({ organizationName: "Club One", firstName: "Dana", override: null });
  });

  it("uses the same read-time lookup as the club roster for a driver the cache hasn't matched yet (#527)", async () => {
    db.members.push(member({}, null));
    mocks.uncachedChecksForRosterMembers.mockResolvedValue(new Map([["person-1", { complianceStatus: "CLEAR", expiresOn: null, issuesNote: "Non-Driver" }]]));
    const [entry] = await listDriverExceptions(now);
    expect(entry).toMatchObject({ personId: "person-1", issuesText: "Non-Driver" });
    expect(entry!.clearance.status).toBe("NOT_CLEARED");
    expect(mocks.uncachedChecksForRosterMembers).toHaveBeenCalledWith([expect.objectContaining({ personId: "person-1" })]);
  });

  it("re-derives on every read: a newer list changes the result with no staff action", async () => {
    const row = member({}, { complianceStatus: "NOT_COMPLIANT", expiresOn: null, issuesNote: "BGC" });
    db.members.push(row);
    expect(await listDriverExceptions(now)).toHaveLength(1);
    (row.person as Row).backgroundCheckMatch = { entry: { complianceStatus: "CLEAR", expiresOn: null, issuesNote: null } };
    expect(await listDriverExceptions(now)).toEqual([]);
  });

  it("shows a staff override on the row, and the override doesn't hide the derived result", async () => {
    db.members.push(member({}, { complianceStatus: "NOT_COMPLIANT", expiresOn: null, issuesNote: "BGC" }, {
      clearedToTransport: true,
      note: "Confirmed by phone.",
      reviewedAt: new Date("2026-09-30T12:00:00Z"),
      reviewedBy: null,
      reviewedByUser: { displayName: "Test Admin" },
    }));
    const [entry] = await listDriverExceptions(now);
    expect(entry!.clearance.status).toBe("NOT_CLEARED");
    expect(entry!.override).toEqual({
      clearedToTransport: true,
      note: "Confirmed by phone.",
      reviewedAt: "2026-09-30T12:00:00.000Z",
      reviewerName: "Test Admin",
    });
  });

  it("never lists a youth, an inactive row, or someone not willing", async () => {
    const bad = { complianceStatus: "NOT_COMPLIANT", expiresOn: null, issuesNote: "BGC" };
    db.members.push(
      withCheck("2", bad, { attendeeType: "YOUTH" }),
      withCheck("3", bad, { status: "INACTIVE" }),
      withCheck("4", bad, { willingToDrive: false }),
    );
    expect(await listDriverExceptions(now)).toEqual([]);
  });
});

describe("what a club sees of its drivers (#427, #544)", () => {
  const noted = { complianceStatus: "NOT_COMPLIANT", expiresOn: null, issuesNote: "Synthetic note: Non-Driver, BGC (10/04/26)" };

  it("is a label per driver, never the issues text, a reason, or an override note", async () => {
    db.members.push(
      withCheck("1", noted),
      withCheck("2", { complianceStatus: "CLEAR", expiresOn: null, issuesNote: null }),
      withCheck("3", { complianceStatus: "CLEAR", expiresOn: null, issuesNote: "BGC (10/20/26)" }),
      withCheck("4", { complianceStatus: "FLAGGED", expiresOn: null, issuesNote: "Synthetic pending note" }),
    );
    const entries = await clubDriverEntries("club-1", "2026-27", now);
    expect(entries.map((entry) => entry.label)).toEqual(["Not cleared", "Cleared to drive", "Expiring (10/20/2026)", "Pending"]);
    const json = JSON.stringify(entries);
    for (const leaked of ["Synthetic", "Non-Driver", "BGC", "issuesText", "reasons", "note"]) {
      expect(json).not.toContain(leaked);
    }
  });

  it("scopes to the club and the year asked for", async () => {
    db.members.push(
      member(),
      member({ id: "member-2", personId: "person-2", organizationId: "club-2" }),
      member({ id: "member-3", personId: "person-3", clubYear: "2025-26" }),
    );
    const entries = await clubDriverEntries("club-1", "2026-27", now);
    expect(entries.map((entry) => entry.rosterMemberId)).toEqual(["member-1"]);
  });

  it("lets a staff override decide the label, and keeps the override's note off it", async () => {
    db.members.push(member({}, noted, {
      clearedToTransport: true,
      note: "Synthetic override reason.",
      reviewedAt: new Date("2026-09-30T12:00:00Z"),
      reviewedBy: null,
      reviewedByUser: { displayName: "Test Admin" },
    }));
    const [entry] = await clubDriverEntries("club-1", "2026-27", now);
    expect(entry!.label).toBe("Cleared to drive");
    expect(JSON.stringify(entry)).not.toContain("Synthetic");
  });

  it("keys the roster chip labels by roster member id", async () => {
    db.members.push(member());
    await expect(clubDriverLabels("club-1", "2026-27", now)).resolves.toEqual({
      "member-1": { status: "CLEARED", label: "Cleared to drive" },
    });
  });
});

describe("a staff override (#544)", () => {
  it("refuses self-nomination before touching the database", async () => {
    db.members.push(member());
    mocks.personIdForActor.mockResolvedValue("person-1");
    await expect(recordDriverClearance("person-1", { clearedToTransport: true, note: "Test." }, { userId: "user-1" }, now))
      .rejects.toMatchObject({ code: "SELF_REVIEW" satisfies DriverVerificationError["code"] });
    expect(db.client.driverVerification.upsert).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("refuses someone who isn't a willing driver on a current roster", async () => {
    db.members.push(member({ willingToDrive: false }));
    await expect(recordDriverClearance("person-1", { clearedToTransport: true, note: "Test." }, { userId: "user-1" }, now))
      .rejects.toMatchObject({ code: "PERSON_NOT_FOUND" });
    expect(db.client.driverVerification.upsert).not.toHaveBeenCalled();
  });

  it("records the override with its note and audits it, including what the list said", async () => {
    db.members.push(member({}, { complianceStatus: "NOT_COMPLIANT", expiresOn: null, issuesNote: "Synthetic BGC issue" }));
    await recordDriverClearance("person-1", { clearedToTransport: true, note: "Confirmed by phone." }, { userId: "admin-1" }, now);
    expect(db.client.driverVerification.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { personId: "person-1" },
      create: expect.objectContaining({
        personId: "person-1",
        clearedToTransport: true,
        note: "Confirmed by phone.",
        reviewedAt: now,
        reviewedByUserId: "admin-1",
      }),
    }));
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: "admin-1",
        action: "DRIVER_VERIFICATION_REVIEWED",
        entityType: "DriverVerification",
        entityId: "person-1",
        metadata: { personId: "person-1", clearedToTransport: true, derivedStatus: "NOT_CLEARED", hasNote: true },
      }),
      expect.anything(),
    );
    // No issues text, and nothing about a license or insurance, in what is stored or audited.
    expect(JSON.stringify(mocks.writeAuditLog.mock.calls[0]![0])).not.toContain("Synthetic");
    for (const forbidden of ["licenseNumber", "insuranceNumber", "license", "insurance"]) {
      expect(Object.keys(db.client.driverVerification.upsert.mock.calls[0]![0].create)).not.toContain(forbidden);
      expect(Object.keys(mocks.writeAuditLog.mock.calls[0]![0].metadata)).not.toContain(forbidden);
    }
  });

  it("replaces an earlier override rather than stacking", async () => {
    db.members.push(member());
    await recordDriverClearance("person-1", { clearedToTransport: true, note: "First." }, { userId: "admin-1" }, now);
    await recordDriverClearance("person-1", { clearedToTransport: false, note: "Second." }, { userId: "admin-2" }, now);
    expect(db.verifications.size).toBe(1);
    expect(db.verifications.get("person-1")).toMatchObject({ clearedToTransport: false, note: "Second.", reviewedByUserId: "admin-2" });
    expect(mocks.writeAuditLog).toHaveBeenCalledTimes(2);
  });
});
