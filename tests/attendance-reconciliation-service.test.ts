import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #166: preparing, approving and correcting, against an in-memory stand-in for the few Prisma calls
 * the service makes. The real database guarantees (immutable approved versions, one active
 * correction per person, one approved version per event, parallel prepares and approvals) are
 * proved by scripts/verify-attendance-reconciliation.ts. Synthetic data only.
 */
vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;
type SourcePerson = { id: string; name: string; createdAt?: Date };
type SourceRegistration = {
  id: string;
  code: string;
  status?: string;
  club: string;
  people: SourcePerson[];
  lines?: Row[];
  responses?: Row;
  definition?: Row;
  totalCents?: number;
  responsibility?: { recorded?: boolean; outdated?: boolean; unresolved?: boolean };
};

const state = vi.hoisted(() => ({
  event: { id: "event-1", billingMode: "DEFERRED_ORGANIZATION_INVOICE", invoiceGrouping: "PER_CHURCH" } as Row,
  registrations: [] as unknown[],
  checkIns: [] as Row[],
  corrections: [] as Row[],
  versions: [] as Row[],
  audits: [] as Row[],
  idCounter: 0,
}));

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, expected]) => {
    const actual = row[key];
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      const condition = expected as Row;
      if ("not" in condition) return actual !== condition.not;
      if ("in" in condition) return (condition.in as unknown[]).includes(actual);
    }
    return actual === expected;
  });
}

function sources() {
  return state.registrations as SourceRegistration[];
}

function registrationRow(source: SourceRegistration) {
  const created = new Date("2026-09-01T10:00:00Z");
  return {
    id: source.id,
    confirmationCode: source.code,
    status: source.status ?? "CONFIRMED",
    totalAmount: { toString: () => ((source.totalCents ?? 0) / 100).toFixed(2) },
    submittedAt: created,
    createdAt: created,
    locationId: null,
    location: null,
    accountHolderPerson: { firstName: "Pat", lastName: "Example" },
    clubRegistration: { organization: { id: `club-${source.club}`, name: `Club ${source.club}` } },
    attendees: source.people.map((person) => ({
      id: person.id,
      createdAt: person.createdAt ?? created,
      profileSnapshot: { firstName: person.name, lastName: "Synthetic" },
      person: { firstName: person.name, lastName: "Synthetic" },
      checkIns: state.checkIns.filter((entry) => entry.registrationAttendeeId === person.id && entry.undoneAt === null),
      attendanceCorrections: state.corrections
        .filter((entry) => entry.registrationAttendeeId === person.id && entry.supersededAt === null)
        .map((entry) => ({ ...entry, actor: { displayName: "Finance Staff" } })),
    })),
    adjustments: [],
    publicFormSubmission: {
      responses: source.responses ?? {},
      pricingSnapshot: { lineItems: source.lines ?? [] },
      formVersion: { definition: source.definition ?? {} },
    },
    operations: [],
  };
}

const uniqueError = () => new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "test" });

const fakeDb = {
  event: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (where.id === state.event.id ? state.event : null)) },
  registration: {
    findMany: vi.fn(async ({ where }: { where: { status: { in: string[] } } }) =>
      sources().filter((source) => where.status.in.includes(source.status ?? "CONFIRMED")).map(registrationRow)),
  },
  registrationOperation: { findMany: vi.fn(async () => []) },
  registrationAttendee: {
    findFirst: vi.fn(async ({ where }: { where: { id: string; eventId: string } }) => {
      if (where.eventId !== state.event.id) return null;
      const owner = sources().find((source) => (source.status ?? "CONFIRMED") !== "CANCELLED" && source.people.some((person) => person.id === where.id));
      return owner ? { id: where.id, registrationId: owner.id } : null;
    }),
  },
  checkIn: {
    findFirst: vi.fn(async ({ where }: { where: Row }) => state.checkIns.find((entry) => matches(entry, where)) ?? null),
  },
  attendanceCorrection: {
    findFirst: vi.fn(async ({ where }: { where: Row }) => state.corrections.find((entry) => matches(entry, where)) ?? null),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const hit = state.corrections.filter((entry) => matches(entry, where));
      hit.forEach((entry) => Object.assign(entry, data));
      return { count: hit.length };
    }),
    create: vi.fn(async ({ data }: { data: Row }) => {
      if (state.corrections.some((entry) => entry.registrationAttendeeId === data.registrationAttendeeId && entry.supersededAt === null)) throw uniqueError();
      state.corrections.push({ supersededAt: null, supersededByCorrectionId: null, ...data });
      return data;
    }),
  },
  attendanceReconciliationVersion: {
    findFirst: vi.fn(async ({ where, orderBy }: { where: Row; orderBy?: Row }) => {
      const hit = state.versions.filter((entry) => matches(entry, where));
      if (orderBy) hit.sort((left, right) => (right.versionNumber as number) - (left.versionNumber as number));
      return hit[0] ?? null;
    }),
    findMany: vi.fn(async ({ where }: { where: Row }) =>
      state.versions
        .filter((entry) => matches(entry, where))
        .sort((left, right) => (right.versionNumber as number) - (left.versionNumber as number))
        .map((entry) => ({ createdAt: new Date("2026-10-04T12:00:00Z"), approvedAt: null, supersededAt: null, preparedBy: { displayName: "Finance Staff" }, approvedBy: null, ...entry }))),
    create: vi.fn(async ({ data }: { data: Row }) => {
      const live = (entry: Row) => entry.status !== "SUPERSEDED";
      if (state.versions.some((entry) => entry.versionNumber === data.versionNumber)) throw uniqueError();
      if (state.versions.some((entry) => live(entry) && entry.fingerprint === data.fingerprint)) throw uniqueError();
      state.idCounter += 1;
      const row = { id: `version-${state.idCounter}`, status: "DRAFT", approvedAt: null, supersededAt: null, supersededByVersionId: null, approvedByUserId: null, ...data };
      state.versions.push(row);
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const hit = state.versions.filter((entry) => matches(entry, where));
      if (data.status === "APPROVED" && state.versions.some((entry) => entry.status === "APPROVED" && !hit.includes(entry))) throw uniqueError();
      hit.forEach((entry) => {
        // The database triggers: an approved or superseded version is never rewritten except to supersede it.
        if (entry.status === "SUPERSEDED") throw new Error("A reconciliation version is an immutable snapshot.");
        Object.assign(entry, data);
      });
      return { count: hit.length };
    }),
  },
  auditLog: { create: vi.fn(async ({ data }: { data: Row }) => { state.audits.push({ ...data }); }) },
  $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(fakeDb)),
};
vi.mock("@/lib/prisma", () => ({ getPrisma: () => fakeDb }));

const billing = vi.hoisted(() => ({ getBillingResponsibilityView: vi.fn() }));
vi.mock("@/modules/billing-responsibility/repository", () => billing);

import {
  AttendanceReconciliationError,
  approveReconciliation,
  getAttendanceReconciliationView,
  prepareReconciliation,
  recordAttendanceCorrection,
} from "@/modules/attendance-reconciliation/repository";

function billingView() {
  const lines = sources().map((source) => ({
    registrationId: source.id,
    confirmationCode: source.code,
    status: source.status ?? "CONFIRMED",
    clubId: `club-${source.club}`,
    clubName: `Club ${source.club}`,
    registrantName: "Pat Example",
    recorded: source.responsibility?.recorded ?? true,
    outdated: source.responsibility?.outdated ?? false,
    unresolved: source.responsibility?.unresolved ?? false,
  }));
  const resolvedLines = lines.filter((line) => !line.unresolved);
  const unresolvedLines = lines.filter((line) => line.unresolved);
  const groups = [
    ...(resolvedLines.length > 0 ? [{ key: "organization:church-1", title: "Church One", party: { kind: "ORGANIZATION", id: "church-1", name: "Church One" }, clubId: null, lines: resolvedLines }] : []),
    ...(unresolvedLines.length > 0 ? [{ key: "unresolved", title: "Unresolved", party: { kind: "UNRESOLVED" }, clubId: null, lines: unresolvedLines }] : []),
  ];
  return { groups };
}

const actor = "user-finance";
const person = (id: string, name: string): SourcePerson => ({ id, name });
const checkIn = (attendeeId: string) => state.checkIns.push({ id: `ci-${attendeeId}`, registrationAttendeeId: attendeeId, undoneAt: null });
const rateLines = (count: number, cents = 2500) => Array.from({ length: count }, (_, index) => ({ key: `attendees.${index}.fee`, label: "Fee", amountCents: cents, attendeeIndex: index }));

beforeEach(() => {
  vi.clearAllMocks();
  state.registrations = [];
  state.checkIns = [];
  state.corrections = [];
  state.versions = [];
  state.audits = [];
  state.idCounter = 0;
  state.event.billingMode = "DEFERRED_ORGANIZATION_INVOICE";
  billing.getBillingResponsibilityView.mockImplementation(async () => billingView());
  state.registrations = [
    {
      id: "reg-1",
      code: "CAM-1",
      club: "Alpha",
      people: [person("a1", "Ann"), person("a2", "Bo"), person("a3", "Cy"), person("a4", "Di")],
      lines: rateLines(4),
      totalCents: 10000,
    } satisfies SourceRegistration,
  ];
  checkIn("a1");
  checkIn("a2");
});

describe("preparing a reconciliation", () => {
  it("creates an immutable draft of the attended people: no-shows are counted, not billed", async () => {
    const outcome = await prepareReconciliation({ eventId: "event-1", actorUserId: actor });
    expect(outcome).toMatchObject({ created: true, versionNumber: 1, status: "DRAFT" });
    const stored = state.versions[0]!;
    expect(stored).toMatchObject({ registeredCount: 4, checkedInCount: 2, noShowCount: 2, addedByStaffCount: 0, removedByStaffCount: 0, billableCount: 2, estimatedCents: 10000, billableCents: 5000, ruleVersion: "attended-v1" });
    expect((stored.snapshot as { groups: unknown[] }).groups).toHaveLength(1);
    expect(state.audits.map((entry) => entry.action)).toEqual(["ATTENDANCE_RECONCILIATION_PREPARED"]);
  });

  it("is idempotent: preparing again with unchanged facts writes nothing", async () => {
    const first = await prepareReconciliation({ eventId: "event-1", actorUserId: actor });
    const second = await prepareReconciliation({ eventId: "event-1", actorUserId: actor });
    expect(second).toMatchObject({ created: false, versionId: first.versionId });
    expect(state.versions).toHaveLength(1);
    expect(state.audits).toHaveLength(1);
  });

  it("makes a new draft, superseding the old one, when a fact changes", async () => {
    const first = await prepareReconciliation({ eventId: "event-1", actorUserId: actor });
    checkIn("a3");
    const second = await prepareReconciliation({ eventId: "event-1", actorUserId: actor });
    expect(second).toMatchObject({ created: true, versionNumber: 2 });
    expect(state.versions.find((entry) => entry.id === first.versionId)?.status).toBe("SUPERSEDED");
    expect(state.versions[1]).toMatchObject({ checkedInCount: 3, billableCents: 7500 });
  });

  it("two staff preparing at once end with one version", async () => {
    const [left, right] = await Promise.all([
      prepareReconciliation({ eventId: "event-1", actorUserId: actor }),
      prepareReconciliation({ eventId: "event-1", actorUserId: "user-other" }),
    ]);
    expect(state.versions).toHaveLength(1);
    expect(left.versionId).toBe(right.versionId);
    expect([left.created, right.created].filter(Boolean)).toHaveLength(1);
  });

  it("is blocked, with the reasons, while billing responsibility is unrecorded, out of date or unresolved", async () => {
    for (const responsibility of [{ recorded: false }, { outdated: true }, { unresolved: true }]) {
      (sources()[0] as SourceRegistration).responsibility = responsibility;
      const error = await prepareReconciliation({ eventId: "event-1", actorUserId: actor }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AttendanceReconciliationError);
      expect(error).toMatchObject({ code: "RESPONSIBILITY_NOT_READY" });
      expect((error as AttendanceReconciliationError).blockers).toHaveLength(1);
    }
    expect(state.versions).toHaveLength(0);
  });

  it("refuses an event that is not billed to organizations, and one with nothing to reconcile", async () => {
    state.registrations = [];
    await expect(prepareReconciliation({ eventId: "event-1", actorUserId: actor })).rejects.toMatchObject({ code: "NOTHING_TO_RECONCILE" });
    state.event.billingMode = "ATTENDEE_PAY";
    await expect(prepareReconciliation({ eventId: "event-1", actorUserId: actor })).rejects.toMatchObject({ code: "NOT_DEFERRED_EVENT" });
    await expect(prepareReconciliation({ eventId: "other-event", actorUserId: actor })).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("applies the credit to the people who attended, from the form's own credit field", async () => {
    state.registrations = [{
      id: "reg-1",
      code: "CAM-1",
      club: "Alpha",
      people: [person("a1", "Ann"), person("a2", "Bo"), person("a3", "Cy"), person("a4", "Di")],
      lines: [...rateLines(4), { key: "meal_sponsorship_count", label: "Meal sponsorship credit", amountCents: -2000 }],
      responses: { meal_sponsorship_count: 4 },
      definition: { sections: [{ fields: [{ key: "meal_sponsorship_count", creditCentsPerUnit: -500, capUnitsAtAttendeeCount: true }] }] },
      totalCents: 8000,
    } satisfies SourceRegistration];
    await prepareReconciliation({ eventId: "event-1", actorUserId: actor });
    // 2 attended: 2 x $25 less a credit for 2 people ($10), not for 4.
    expect(state.versions[0]).toMatchObject({ estimatedCents: 8000, billableCents: 4000 });
  });
});

describe("approving a reconciliation", () => {
  it("approves a current draft, records the approver, and audits it", async () => {
    const { versionId } = await prepareReconciliation({ eventId: "event-1", actorUserId: actor });
    const result = await approveReconciliation({ eventId: "event-1", versionId, actorUserId: actor });
    expect(result).toMatchObject({ changed: true, versionNumber: 1 });
    expect(state.versions[0]).toMatchObject({ status: "APPROVED", approvedByUserId: actor });
    expect(state.versions[0]?.approvedAt).toBeInstanceOf(Date);
    expect(state.audits.map((entry) => entry.action)).toEqual(["ATTENDANCE_RECONCILIATION_PREPARED", "ATTENDANCE_RECONCILIATION_APPROVED"]);
  });

  it("approving twice, or two staff at once, approves it once", async () => {
    const { versionId } = await prepareReconciliation({ eventId: "event-1", actorUserId: actor });
    const results = await Promise.all([
      approveReconciliation({ eventId: "event-1", versionId, actorUserId: actor }),
      approveReconciliation({ eventId: "event-1", versionId, actorUserId: "user-other" }),
    ]);
    expect(results.filter((entry) => entry.changed)).toHaveLength(1);
    expect(state.versions.filter((entry) => entry.status === "APPROVED")).toHaveLength(1);
    expect(state.audits.filter((entry) => entry.action === "ATTENDANCE_RECONCILIATION_APPROVED")).toHaveLength(1);
    expect(await approveReconciliation({ eventId: "event-1", versionId, actorUserId: actor })).toMatchObject({ changed: false });
  });

  it("refuses a draft whose facts changed since it was prepared", async () => {
    const { versionId } = await prepareReconciliation({ eventId: "event-1", actorUserId: actor });
    checkIn("a3");
    await expect(approveReconciliation({ eventId: "event-1", versionId, actorUserId: actor })).rejects.toMatchObject({ code: "FACTS_CHANGED" });
    expect(state.versions[0]?.status).toBe("DRAFT");
  });

  it("refuses a version of another event, and a superseded draft", async () => {
    const { versionId } = await prepareReconciliation({ eventId: "event-1", actorUserId: actor });
    await expect(approveReconciliation({ eventId: "event-2", versionId, actorUserId: actor })).rejects.toMatchObject({ code: "VERSION_NOT_FOUND" });
    checkIn("a3");
    await prepareReconciliation({ eventId: "event-1", actorUserId: actor });
    await expect(approveReconciliation({ eventId: "event-1", versionId, actorUserId: actor })).rejects.toMatchObject({ code: "VERSION_SUPERSEDED" });
  });

  it("is blocked while billing responsibility is not ready", async () => {
    const { versionId } = await prepareReconciliation({ eventId: "event-1", actorUserId: actor });
    (sources()[0] as SourceRegistration).responsibility = { unresolved: true };
    await expect(approveReconciliation({ eventId: "event-1", versionId, actorUserId: actor })).rejects.toMatchObject({ code: "RESPONSIBILITY_NOT_READY" });
  });

  it("a later approval supersedes the earlier one; the earlier is never altered otherwise", async () => {
    const first = await prepareReconciliation({ eventId: "event-1", actorUserId: actor });
    await approveReconciliation({ eventId: "event-1", versionId: first.versionId, actorUserId: actor });
    const snapshotBefore = JSON.stringify(state.versions[0]?.snapshot);
    checkIn("a3");
    const second = await prepareReconciliation({ eventId: "event-1", actorUserId: actor });
    expect(second.versionNumber).toBe(2);
    await approveReconciliation({ eventId: "event-1", versionId: second.versionId, actorUserId: actor });
    expect(state.versions.map((entry) => entry.status)).toEqual(["SUPERSEDED", "APPROVED"]);
    expect(JSON.stringify(state.versions[0]?.snapshot)).toBe(snapshotBefore);
    expect(state.versions[0]?.supersededByVersionId).toBe(second.versionId);
  });
});

describe("attendance changed after approval", () => {
  it("leaves the approved version unchanged and flags that the facts changed; a new draft can be prepared", async () => {
    const { versionId } = await prepareReconciliation({ eventId: "event-1", actorUserId: actor });
    await approveReconciliation({ eventId: "event-1", versionId, actorUserId: actor });
    const approvedBefore = JSON.stringify(state.versions[0]);

    let view = await getAttendanceReconciliationView("event-1");
    expect(view.isDeferred && view.approvedFreshness).toBe("CURRENT");

    await recordAttendanceCorrection({ eventId: "event-1", attendeeId: "a3", kind: "MARK_ATTENDED", reason: "Arrived late and missed the desk", actorUserId: actor });
    view = await getAttendanceReconciliationView("event-1");
    expect(view.isDeferred && view.approvedFreshness).toBe("FACTS_CHANGED");
    expect(view.isDeferred && view.liveTotals.billable).toBe(3);
    expect(view.isDeferred && view.approved?.counts.billable).toBe(2);
    expect(JSON.stringify(state.versions[0])).toBe(approvedBefore);

    const next = await prepareReconciliation({ eventId: "event-1", actorUserId: actor });
    expect(next).toMatchObject({ created: true, versionNumber: 2 });
    expect(state.versions[0]?.status).toBe("APPROVED");
  });

  it("shows a saved version's snapshot, only for this event's own versions", async () => {
    const { versionId } = await prepareReconciliation({ eventId: "event-1", actorUserId: actor });
    checkIn("a3");
    const view = await getAttendanceReconciliationView("event-1", { versionId });
    expect(view.isDeferred && view.shown.kind).toBe("VERSION");
    expect(view.isDeferred && view.result.totals.billable).toBe(2);
    const stranger = await getAttendanceReconciliationView("event-1", { versionId: "version-of-another-event" });
    expect(stranger.isDeferred && stranger.shown.kind).toBe("LIVE");
  });
});

describe("staff corrections", () => {
  it("marks a missed person attended with a reason, audited, and counts them as adjusted", async () => {
    await recordAttendanceCorrection({ eventId: "event-1", attendeeId: "a3", kind: "MARK_ATTENDED", reason: "  Came in after the desk closed  ", actorUserId: actor });
    expect(state.corrections[0]).toMatchObject({ registrationAttendeeId: "a3", kind: "MARK_ATTENDED", reason: "Came in after the desk closed", actorUserId: actor, supersededAt: null });
    expect(state.audits[0]).toMatchObject({ action: "ATTENDANCE_CORRECTED", eventId: "event-1", actorUserId: actor });
    expect(JSON.stringify(state.audits[0])).not.toContain("Came in after");
    const view = await getAttendanceReconciliationView("event-1");
    expect(view.isDeferred && view.liveTotals).toMatchObject({ checkedIn: 2, addedByStaff: 1, billable: 3 });
  });

  it("removes a person who was checked in by mistake", async () => {
    await recordAttendanceCorrection({ eventId: "event-1", attendeeId: "a1", kind: "MARK_NOT_ATTENDED", reason: "Checked in by mistake: not on the trip", actorUserId: actor });
    const view = await getAttendanceReconciliationView("event-1");
    expect(view.isDeferred && view.liveTotals).toMatchObject({ checkedIn: 2, removedByStaff: 1, billable: 1, billableCents: 2500 });
  });

  it("requires a reason", async () => {
    await expect(recordAttendanceCorrection({ eventId: "event-1", attendeeId: "a3", kind: "MARK_ATTENDED", reason: "   ", actorUserId: actor })).rejects.toBeInstanceOf(AttendanceReconciliationError);
    expect(state.corrections).toHaveLength(0);
  });

  it("refuses a correction that changes nothing", async () => {
    await expect(recordAttendanceCorrection({ eventId: "event-1", attendeeId: "a1", kind: "MARK_ATTENDED", reason: "Already in", actorUserId: actor })).rejects.toMatchObject({ code: "NO_CHANGE" });
    await expect(recordAttendanceCorrection({ eventId: "event-1", attendeeId: "a3", kind: "MARK_NOT_ATTENDED", reason: "Already out", actorUserId: actor })).rejects.toMatchObject({ code: "NO_CHANGE" });
    await expect(recordAttendanceCorrection({ eventId: "event-1", attendeeId: "a3", kind: "CLEAR", reason: "Nothing to clear", actorUserId: actor })).rejects.toMatchObject({ code: "NOTHING_TO_CLEAR" });
  });

  it("a later correction supersedes the earlier one, which is kept; withdrawing returns to the check-in record", async () => {
    await recordAttendanceCorrection({ eventId: "event-1", attendeeId: "a3", kind: "MARK_ATTENDED", reason: "Came", actorUserId: actor });
    await recordAttendanceCorrection({ eventId: "event-1", attendeeId: "a3", kind: "MARK_NOT_ATTENDED", reason: "Actually went home sick", actorUserId: actor });
    expect(state.corrections).toHaveLength(2);
    expect(state.corrections.filter((entry) => entry.supersededAt === null)).toHaveLength(1);
    expect(state.corrections[0]?.supersededByCorrectionId).toBe(state.corrections[1]?.id);
    await recordAttendanceCorrection({ eventId: "event-1", attendeeId: "a3", kind: "CLEAR", reason: "Back to the record", actorUserId: actor });
    const view = await getAttendanceReconciliationView("event-1");
    expect(view.isDeferred && view.liveTotals).toMatchObject({ addedByStaff: 0, removedByStaff: 0, billable: 2 });
  });

  it("two staff correcting the same person at once leaves one active correction", async () => {
    const outcomes = await Promise.allSettled([
      recordAttendanceCorrection({ eventId: "event-1", attendeeId: "a3", kind: "MARK_ATTENDED", reason: "One", actorUserId: actor }),
      recordAttendanceCorrection({ eventId: "event-1", attendeeId: "a3", kind: "MARK_ATTENDED", reason: "Two", actorUserId: "user-other" }),
    ]);
    expect(state.corrections.filter((entry) => entry.supersededAt === null)).toHaveLength(1);
    expect(outcomes.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
  });

  it("refuses a person from another event or on a cancelled registration", async () => {
    await expect(recordAttendanceCorrection({ eventId: "event-2", attendeeId: "a3", kind: "MARK_ATTENDED", reason: "x", actorUserId: actor })).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
    await expect(recordAttendanceCorrection({ eventId: "event-1", attendeeId: "nobody", kind: "MARK_ATTENDED", reason: "x", actorUserId: actor })).rejects.toMatchObject({ code: "ATTENDEE_NOT_FOUND" });
    (sources()[0] as SourceRegistration).status = "CANCELLED";
    await expect(recordAttendanceCorrection({ eventId: "event-1", attendeeId: "a3", kind: "MARK_ATTENDED", reason: "x", actorUserId: actor })).rejects.toMatchObject({ code: "ATTENDEE_NOT_FOUND" });
  });
});

describe("roster changes after submission", () => {
  it("flags a late addition and bills only the people who were checked in, whoever is on the roster now", async () => {
    // One person was removed and another added (a substitution at the registration level): the roster now
    // holds Ann, Bo, and the newcomer; the newcomer arrived and was checked in.
    state.registrations = [{
      id: "reg-1",
      code: "CAM-1",
      club: "Alpha",
      people: [person("a1", "Ann"), person("a2", "Bo"), { id: "a5", name: "Newcomer", createdAt: new Date("2026-09-20T10:00:00Z") }],
      lines: rateLines(3),
      totalCents: 7500,
    } satisfies SourceRegistration];
    checkIn("a5");
    await prepareReconciliation({ eventId: "event-1", actorUserId: actor });
    expect(state.versions[0]).toMatchObject({ registeredCount: 3, checkedInCount: 3, billableCount: 3, billableCents: 7500 });
    const people = (state.versions[0]?.snapshot as { groups: Array<{ registrations: Array<{ people: Array<{ name: string; addedAfterSubmission: boolean }> }> }> }).groups[0]!.registrations[0]!.people;
    expect(people.find((entry) => entry.name === "Newcomer Synthetic")?.addedAfterSubmission).toBe(true);
    expect(people.find((entry) => entry.name === "Ann Synthetic")?.addedAfterSubmission).toBe(false);
  });
});
