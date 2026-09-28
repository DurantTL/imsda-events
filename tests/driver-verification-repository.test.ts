import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  writeAuditLog: vi.fn(),
  personIdForActor: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/driver-verification/access", async () => {
  const actual = await vi.importActual<typeof import("@/modules/driver-verification/access")>("@/modules/driver-verification/access");
  return { ...actual, personIdForActor: mocks.personIdForActor };
});

import {
  DriverVerificationError,
  listWillingDrivers,
  recordDriverClearance,
} from "@/modules/driver-verification/repository";

const now = new Date("2026-10-01T15:00:00Z");

type Row = Record<string, unknown>;

function fakeDatabase() {
  const members: Row[] = [];
  const verifications = new Map<string, Row>();
  const client = {
    clubRosterMember: {
      findMany: async ({ where }: { where: Row }) => members.filter((member) => matches(member, where)),
      findFirst: async ({ where }: { where: Row }) => members.find((member) => matches(member, where)) ?? null,
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

function member(overrides: Row = {}): Row {
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
      backgroundCheck: { complianceStatus: "CLEAR", expiresOn: null, issuesNote: null },
      driverVerification: null,
    },
    ...overrides,
  };
}

let db: ReturnType<typeof fakeDatabase>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.writeAuditLog.mockResolvedValue({});
  mocks.personIdForActor.mockResolvedValue(null);
  db = fakeDatabase();
});

describe("driver verification queue (#491)", () => {
  it("lists every willing driver with their background-check status and note", async () => {
    db.members.push(member());
    const entries = await listWillingDrivers({ kind: "GLOBAL" }, now);
    expect(entries).toEqual([
      expect.objectContaining({
        personId: "person-1",
        firstName: "Dana",
        lastName: "Driver",
        organizationName: "Club One",
        backgroundCheck: { state: "CLEAR", note: null },
        verification: null,
      }),
    ]);
  });

  it("scopes a club's queue to its own organization", async () => {
    db.members.push(member(), member({ id: "member-2", personId: "person-2", organizationId: "club-2" }));
    const entries = await listWillingDrivers({ kind: "CLUB", organizationId: "club-1" }, now);
    expect(entries.map((entry) => entry.personId)).toEqual(["person-1"]);
  });

  it("never lists a youth or an inactive row, willing or not", async () => {
    db.members.push(
      member({ id: "member-2", personId: "person-2", attendeeType: "YOUTH" }),
      member({ id: "member-3", personId: "person-3", status: "INACTIVE" }),
      member({ id: "member-4", personId: "person-4", willingToDrive: false }),
    );
    const entries = await listWillingDrivers({ kind: "GLOBAL" }, now);
    expect(entries).toHaveLength(0);
  });

  it("refuses self-nomination before touching the database, whatever the actor's role", async () => {
    db.members.push(member());
    mocks.personIdForActor.mockResolvedValue("person-1");
    await expect(recordDriverClearance(
      "person-1",
      { kind: "GLOBAL" },
      { clearedToTransport: true, note: "" },
      { userId: "user-1" },
      now,
    )).rejects.toMatchObject({ code: "SELF_REVIEW" satisfies DriverVerificationError["code"] });
    expect(db.client.driverVerification.upsert).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("refuses a person outside the reviewer's club scope", async () => {
    db.members.push(member({ organizationId: "club-2" }));
    await expect(recordDriverClearance(
      "person-1",
      { kind: "CLUB", organizationId: "club-1" },
      { clearedToTransport: true, note: "" },
      { kind: "ATTENDEE", accountId: "director-1", sessionId: "session-1" },
      now,
    )).rejects.toMatchObject({ code: "PERSON_NOT_FOUND" });
  });

  it("refuses someone who never checked the willing-to-drive box", async () => {
    db.members.push(member({ willingToDrive: false }));
    await expect(recordDriverClearance(
      "person-1",
      { kind: "GLOBAL" },
      { clearedToTransport: true, note: "" },
      { userId: "user-1" },
      now,
    )).rejects.toMatchObject({ code: "PERSON_NOT_FOUND" });
  });

  it("records a system administrator's decision, and audits it", async () => {
    db.members.push(member());
    await recordDriverClearance(
      "person-1",
      { kind: "GLOBAL" },
      { clearedToTransport: true, note: "Reviewed in person." },
      { userId: "admin-1" },
      now,
    );
    expect(db.client.driverVerification.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { personId: "person-1" },
      create: expect.objectContaining({
        personId: "person-1",
        clearedToTransport: true,
        note: "Reviewed in person.",
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
        metadata: expect.objectContaining({ clearedToTransport: true }),
      }),
      expect.anything(),
    );
    // Only the reviewer, the date, and the outcome are ever stored or audited
    // (#491) — never a field for a license or insurance number or file.
    const storedKeys = new Set(Object.keys(db.client.driverVerification.upsert.mock.calls[0]![0].create));
    for (const forbidden of ["licenseNumber", "insuranceNumber", "license", "insurance"]) {
      expect(storedKeys.has(forbidden)).toBe(false);
    }
    const auditedKeys = new Set(Object.keys(mocks.writeAuditLog.mock.calls[0]![0].metadata));
    for (const forbidden of ["licenseNumber", "insuranceNumber", "license", "insurance"]) {
      expect(auditedKeys.has(forbidden)).toBe(false);
    }
  });

  it("records a club director's decision by their attendee account, not a staff user id", async () => {
    db.members.push(member());
    await recordDriverClearance(
      "person-1",
      { kind: "CLUB", organizationId: "club-1" },
      { clearedToTransport: false, note: "License expired." },
      { kind: "ATTENDEE", accountId: "director-1", sessionId: "session-1" },
      now,
    );
    expect(db.client.driverVerification.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ reviewedByAccountId: "director-1", clearedToTransport: false }),
    }));
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ actorAttendeeAccountId: "director-1", scope: "CLUB", organizationId: "club-1" }) }),
      expect.anything(),
    );
  });
});
