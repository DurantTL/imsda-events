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
type SourcePerson = { id: string; name: string; createdAt?: Date; position?: number };
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
  /** A whole-registration promo code: the redemption and the discount recorded in the pricing snapshot. */
  promo?: { code: string; type: "FIXED_CENTS" | "PERCENT_BPS"; value: number; max?: number | null; discountCents: number };
  /** A later pricing snapshot, as an amendment records one. */
  amendment?: { lines: Row[]; discountCents?: number; createdAt?: Date; attendees?: Array<{ id: string; position: number }> };
  /** Line labels name the person priced at that place. */
  responsibility?: { recorded?: boolean; outdated?: boolean; unresolved?: boolean };
};

const state = vi.hoisted(() => ({
  event: { id: "event-1", billingMode: "DEFERRED_ORGANIZATION_INVOICE", invoiceGrouping: "PER_CHURCH" } as Row,
  registrations: [] as unknown[],
  checkIns: [] as Row[],
  corrections: [] as Row[],
  acknowledgements: [] as Row[],
  moves: [] as Row[],
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
    attendees: source.people.map((person, index) => ({
      id: person.id,
      position: person.position ?? index,
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
      createdAt: new Date("2026-09-01T10:00:00Z"),
      pricingSnapshot: { lineItems: source.lines ?? [], discountAmountCents: source.promo?.discountCents ?? 0 },
      formVersion: { definition: source.definition ?? {} },
    },
    operations: source.amendment
      ? [{ createdAt: source.amendment.createdAt ?? new Date("2026-09-15T10:00:00Z"), afterSnapshot: { attendees: source.amendment.attendees ?? [], pricingSnapshot: { lineItems: source.amendment.lines, discountAmountCents: source.amendment.discountCents ?? 0 } } }]
      : [],
    promoCodeRedemption: source.promo
      ? { codeSnapshot: source.promo.code, discountTypeSnapshot: source.promo.type, discountValueSnapshot: source.promo.value, maximumDiscountCentsSnapshot: source.promo.max ?? null, discountAmountCents: source.promo.discountCents }
      : null,
  };
}

const uniqueError = () => new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "test" });

const fakeDb = {
  event: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (where.id === state.event.id ? state.event : where.id === "event-2" ? { ...state.event, id: "event-2" } : null)) },
  registration: {
    findMany: vi.fn(async ({ where }: { where: { status: { in: string[] } } }) =>
      sources().filter((source) => where.status.in.includes(source.status ?? "CONFIRMED")).map(registrationRow)),
  },
  registrationOperation: { findMany: vi.fn(async () => []) },
  memberTransferRegistrationMove: {
    findMany: vi.fn(async () => state.moves.filter((move) => move.status === "APPROVED")),
  },
  attendanceReviewAcknowledgement: {
    findMany: vi.fn(async ({ where }: { where?: Row } = {}) => state.acknowledgements.filter((entry) => matches(entry, where ?? {}))),
    findFirst: vi.fn(async ({ where }: { where: Row }) => state.acknowledgements.find((entry) => matches(entry, where)) ?? null),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const hit = state.acknowledgements.filter((entry) => matches(entry, where));
      hit.forEach((entry) => Object.assign(entry, data));
      return { count: hit.length };
    }),
    create: vi.fn(async ({ data }: { data: Row }) => {
      if (state.acknowledgements.some((entry) => entry.registrationId === data.registrationId && entry.reviewKey === data.reviewKey && entry.supersededAt === null)) throw uniqueError();
      state.idCounter += 1;
      const row = { id: `ack-${state.idCounter}`, supersededAt: null, supersededById: null, createdAt: new Date("2026-10-04T12:00:00Z"), actor: { displayName: "Finance Staff" }, ...data };
      state.acknowledgements.push(row);
      return row;
    }),
  },
  registrationAttendee: {
    findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
      sources().flatMap((source) => source.people.map((entry, position) => ({
        id: entry.id,
        position,
        createdAt: entry.createdAt ?? new Date("2026-09-01T10:00:00Z"),
        profileSnapshot: { firstName: entry.name, lastName: "Synthetic" },
        person: { firstName: entry.name, lastName: "Synthetic" },
      }))).filter((entry) => where.id.in.includes(entry.id))),
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
    findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
      state.corrections.filter((entry) => where.id.in.includes(entry.id as string)).map((entry) => ({ ...entry, actor: { displayName: "Finance Staff" } }))),
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
  $executeRaw: vi.fn(async () => 1),
  $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(fakeDb)),
};
vi.mock("@/lib/prisma", () => ({ getPrisma: () => fakeDb }));

const billing = vi.hoisted(() => ({ getBillingResponsibilityView: vi.fn() }));
vi.mock("@/modules/billing-responsibility/repository", () => billing);

import {
  AttendanceReconciliationError,
  acknowledgeRosterReview,
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
const person = (id: string, name: string, createdAt?: Date): SourcePerson => ({ id, name, ...(createdAt ? { createdAt } : {}) });
const checkIn = (attendeeId: string) => state.checkIns.push({ id: `ci-${attendeeId}`, registrationAttendeeId: attendeeId, undoneAt: null });
const rateLines = (count: number, cents = 2500) => Array.from({ length: count }, (_, index) => ({ key: `attendees.${index}.fee`, label: "Fee", amountCents: cents, attendeeIndex: index }));

beforeEach(() => {
  vi.clearAllMocks();
  state.registrations = [];
  state.checkIns = [];
  state.corrections = [];
  state.acknowledgements = [];
  state.moves = [];
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
    await expect(recordAttendanceCorrection({ eventId: "other-event", attendeeId: "a3", kind: "MARK_ATTENDED", reason: "x", actorUserId: actor })).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
    await expect(recordAttendanceCorrection({ eventId: "event-2", attendeeId: "a3", kind: "MARK_ATTENDED", reason: "x", actorUserId: actor })).rejects.toMatchObject({ code: "ATTENDEE_NOT_FOUND" });
    await expect(recordAttendanceCorrection({ eventId: "event-1", attendeeId: "nobody", kind: "MARK_ATTENDED", reason: "x", actorUserId: actor })).rejects.toMatchObject({ code: "ATTENDEE_NOT_FOUND" });
    (sources()[0] as SourceRegistration).status = "CANCELLED";
    await expect(recordAttendanceCorrection({ eventId: "event-1", attendeeId: "a3", kind: "MARK_ATTENDED", reason: "x", actorUserId: actor })).rejects.toMatchObject({ code: "ATTENDEE_NOT_FOUND" });
  });
});

describe("whole-registration promo codes, from the stored redemption and the latest snapshot", () => {
  const tenPeople = Array.from({ length: 10 }, (_, index) => person(`t${index}`, `Tee${index}`));
  const tenLines = (cents = 5000) => Array.from({ length: 10 }, (_, index) => ({ key: `attendees.${index}.fee`, label: "Fee", amountCents: cents, attendeeIndex: index, attendeeLabel: `Tee${index} Synthetic` }));

  function ten(overrides: Partial<SourceRegistration>) {
    state.registrations = [{ id: "reg-1", code: "CAM-1", club: "Alpha", people: tenPeople, lines: tenLines(), totalCents: 40000, ...overrides } satisfies SourceRegistration];
  }

  it("a fixed code: 10 x $50 with $100 off bills $400 when everyone attends, not $500", async () => {
    ten({ promo: { code: "SAVE100", type: "FIXED_CENTS", value: 10000, discountCents: 10000 } });
    tenPeople.forEach((entry) => checkIn(entry.id));
    await prepareReconciliation({ eventId: "event-1", actorUserId: actor });
    expect(state.versions[0]).toMatchObject({ estimatedCents: 40000, billableCents: 40000 });
    const registrationResult = (state.versions[0]!.snapshot as { groups: Array<{ registrations: Array<{ promo: unknown }> }> }).groups[0]!.registrations[0]!;
    expect(registrationResult.promo).toEqual({ code: "SAVE100", appliedCents: -10000 });
  });

  it("a fixed code with partial attendance is applied in full, capped at what the attended people owe", async () => {
    ten({ promo: { code: "SAVE100", type: "FIXED_CENTS", value: 10000, discountCents: 10000 } });
    tenPeople.slice(0, 6).forEach((entry) => checkIn(entry.id));
    await prepareReconciliation({ eventId: "event-1", actorUserId: actor });
    expect(state.versions[0]).toMatchObject({ billableCents: 30000 - 10000 });
  });

  it("a percentage code gives the same percentage of the attended people's charges", async () => {
    ten({ totalCents: 45000, promo: { code: "TEN", type: "PERCENT_BPS", value: 1000, discountCents: 5000 } });
    tenPeople.slice(0, 6).forEach((entry) => checkIn(entry.id));
    await prepareReconciliation({ eventId: "event-1", actorUserId: actor });
    expect(state.versions[0]).toMatchObject({ estimatedCents: 45000, billableCents: 27000 });
  });

  it("reads the discount from the latest amendment's snapshot when there is one", async () => {
    // Amended down to 8 people at $50 = $400, with the percentage code now worth $40.
    ten({
      totalCents: 36000,
      promo: { code: "TEN", type: "PERCENT_BPS", value: 1000, discountCents: 5000 },
      amendment: { lines: tenLines().slice(0, 8), discountCents: 4000 },
      people: tenPeople.slice(0, 8),
    });
    tenPeople.slice(0, 8).forEach((entry) => checkIn(entry.id));
    await prepareReconciliation({ eventId: "event-1", actorUserId: actor });
    expect(state.versions[0]).toMatchObject({ billableCents: 36000 });
  });

  it("never bills more than the estimate when everyone attends", async () => {
    ten({ promo: { code: "SAVE100", type: "FIXED_CENTS", value: 10000, discountCents: 10000 } });
    tenPeople.forEach((entry) => checkIn(entry.id));
    await prepareReconciliation({ eventId: "event-1", actorUserId: actor });
    const stored = state.versions[0]!;
    expect(stored.billableCents as number).toBeLessThanOrEqual(stored.estimatedCents as number);
  });
});

type TransferRegistration = { people: Array<{ id: string; name: string; position: number }>; prices: number[]; amended?: Array<{ id: string; position: number }>; total?: number };

describe("member transfers after pricing: prices follow the stored places, never the listing or creation order", () => {
  const priced = (prices: number[]) => prices.map((cents, index) => ({ key: `attendees.${index}.fee`, label: "Fee", amountCents: cents, attendeeIndex: index }));
  const place = (id: string, name: string, position: number) => ({ id, name, position });
  const move = (id: string, attendeeId: string, from: string, to: string, decidedAt = "2026-09-30T10:00:00Z") => ({ id, status: "APPROVED", registrationAttendeeId: attendeeId, fromRegistrationId: from, toRegistrationId: to, decidedAt: new Date(decidedAt) });
  const build = (id: string, code: string, club: string, spec: TransferRegistration): SourceRegistration => ({
    id, code, club,
    people: spec.people.map((entry) => ({ id: entry.id, name: entry.name, position: entry.position })),
    lines: priced(spec.prices),
    totalCents: spec.total ?? spec.prices.reduce((total, cents) => total + cents, 0),
    ...(spec.amended ? { amendment: { lines: priced(spec.prices), attendees: spec.amended, createdAt: new Date("2026-09-15T10:00:00Z") } } : {}),
  });
  type Snapshot = { groups: Array<{ registrations: Array<{ confirmationCode: string; billableCents: number; basis: string; review: { reasons: string[]; notes: string[] } | null; alternatives: { perPersonCents: number; proratedCents: number } | null; people: Array<{ attendeeId: string; chargeCents: number; transferredFrom: string | null }> }> }> };
  const registrations = () => (state.versions[0]!.snapshot as Snapshot).groups.flatMap((group) => group.registrations);
  const byCode = (code: string) => registrations().find((entry) => entry.confirmationCode === code)!;

  // Adams (created t1), Baker (created t9, added by an amendment), Clark (t2): priced [0, 1, 2] at $10, $20, $30.
  const trio = (amended: boolean, leaver: "baker" | "clark") => {
    const all = [place("adams", "Adams", 0), place("baker", "Baker", 1), place("clark", "Clark", 2)];
    const stayed = all.filter((entry) => entry.id !== leaver);
    const gone = all.find((entry) => entry.id === leaver)!;
    state.registrations = [
      build("reg-1", "CAM-1", "Alpha", { people: stayed, prices: [1000, 2000, 3000], ...(amended ? { amended: all.map(({ id, position }) => ({ id, position })) } : {}) }),
      // The receiver was priced for one person (Zed, place 0); the arrival holds the last place there.
      build("reg-2", "CAM-2", "Beta", { people: [place("zed", "Zed", 0), place(gone.id, gone.name, 1)], prices: [7000] }),
    ];
    state.moves = [move("move-1", leaver, "reg-1", "reg-2")];
    state.checkIns = [];
    ["adams", "baker", "clark"].forEach(checkIn);
  };

  for (const amended of [true, false]) {
    it(`Baker leaves (${amended ? "amended" : "original"} pricing): the sender bills Adams and Clark at their own lines, the receiver bills Baker at Baker's`, async () => {
      trio(amended, "baker");
      await prepareReconciliation({ eventId: "event-1", actorUserId: actor });
      expect(byCode("CAM-1")).toMatchObject({ billableCents: 4000, review: null, basis: "PER_PERSON_LINES" });
      expect(byCode("CAM-2")).toMatchObject({ billableCents: 2000, review: null });
      expect(byCode("CAM-2").people.find((entry) => entry.attendeeId === "baker")).toMatchObject({ chargeCents: 2000, transferredFrom: "Club Alpha" });
    });

    it(`Clark leaves (${amended ? "amended" : "original"} pricing): Clark's own line follows Clark`, async () => {
      trio(amended, "clark");
      await prepareReconciliation({ eventId: "event-1", actorUserId: actor });
      expect(byCode("CAM-1")).toMatchObject({ billableCents: 3000, review: null });
      expect(byCode("CAM-2").people.find((entry) => entry.attendeeId === "clark")?.chargeCents).toBe(3000);
    });
  }

  const quad = (amended: boolean) => {
    const all = [place("a", "Ann", 0), place("b", "Bo", 1), place("c", "Cy", 2), place("d", "Di", 3)];
    state.registrations = [
      build("reg-1", "CAM-1", "Alpha", { people: [all[0]!, all[2]!], prices: [1000, 2000, 3000, 4000], ...(amended ? { amended: all.map(({ id, position }) => ({ id, position })) } : {}) }),
      build("reg-2", "CAM-2", "Beta", { people: [place("zed", "Zed", 0), place("b", "Bo", 1), place("d", "Di", 2)], prices: [7000], total: 10000 }),
    ];
    state.moves = [move("move-1", "b", "reg-1", "reg-2"), move("move-2", "d", "reg-1", "reg-2")];
    state.checkIns = [];
    ["a", "b", "c", "d", "zed"].forEach(checkIn);
  };

  it("two leavers from an amended registration: each is resolved from the amendment's recorded places", async () => {
    quad(true);
    await prepareReconciliation({ eventId: "event-1", actorUserId: actor });
    expect(byCode("CAM-1")).toMatchObject({ billableCents: 4000, review: null });
    expect(byCode("CAM-2")).toMatchObject({ billableCents: 7000 + 2000 + 4000, review: null });
  });

  it("two leavers from a non-amended submission: the arrivals get no price and the receiver goes to review; the sender is fine", async () => {
    quad(false);
    await prepareReconciliation({ eventId: "event-1", actorUserId: actor });
    expect(byCode("CAM-1")).toMatchObject({ billableCents: 4000, review: null });
    const receiver = byCode("CAM-2");
    expect(receiver.review?.reasons).toContain("ARRIVAL_PRICE_UNMATCHED");
    expect(receiver.review?.notes).toEqual(expect.arrayContaining(["Price for Bo Synthetic couldn't be matched after the transfer.", "Price for Di Synthetic couldn't be matched after the transfer."]));
    // Never a guess from the arrival's current place: both arrivals are $0 in the per-person figure.
    expect(receiver.people.filter((entry) => entry.attendeeId !== "zed").map((entry) => entry.chargeCents)).toEqual([0, 0]);
    expect(receiver.alternatives).toEqual({ perPersonCents: 7000, proratedCents: 10000 });
    expect(receiver.basis).toBe("PRORATED_ESTIMATE");
  });

  it("the receiver also lost someone: the arrival never takes the line of the person who left", async () => {
    // Y was priced for Zed (place 0) and Wren (place 1). Wren moved out first, then Ann arrived and was given place 1.
    state.registrations = [
      build("reg-1", "CAM-1", "Alpha", { people: [place("bea", "Bea", 0)], prices: [1000, 2000] }),
      build("reg-2", "CAM-2", "Beta", { people: [place("zed", "Zed", 0), place("ann", "Ann", 1)], prices: [7000, 8000] }),
    ];
    state.moves = [move("move-w", "wren", "reg-2", "reg-9", "2026-09-20T10:00:00Z"), move("move-a", "ann", "reg-1", "reg-2", "2026-09-25T10:00:00Z")];
    state.checkIns = [];
    ["bea", "zed", "ann"].forEach(checkIn);
    await prepareReconciliation({ eventId: "event-1", actorUserId: actor });
    // Ann was Alpha's second person ($20), not Wren's $80 line.
    expect(byCode("CAM-2").people.find((entry) => entry.attendeeId === "ann")?.chargeCents).toBe(2000);
    expect(byCode("CAM-2")).toMatchObject({ billableCents: 7000 + 2000, review: null });
    expect(byCode("CAM-1")).toMatchObject({ billableCents: 1000, review: null });
  });

  it("a person who did not attend after being transferred is not billed to either registration", async () => {
    trio(true, "baker");
    state.checkIns = [];
    ["adams", "clark"].forEach(checkIn);
    await prepareReconciliation({ eventId: "event-1", actorUserId: actor });
    expect(byCode("CAM-1").billableCents).toBe(4000);
    expect(byCode("CAM-2").billableCents).toBe(0);
  });

  it("a registration with no transfer is priced by stored place even when the listing order differs", async () => {
    state.registrations = [build("reg-1", "CAM-1", "Alpha", { people: [place("c", "Cy", 2), place("a", "Ann", 0), place("b", "Bo", 1)], prices: [100, 200, 300] })];
    state.checkIns = [];
    ["a", "b", "c"].forEach(checkIn);
    await prepareReconciliation({ eventId: "event-1", actorUserId: actor });
    const [registration] = registrations();
    expect(registration).toMatchObject({ billableCents: 600, review: null });
    expect(Object.fromEntries(registration!.people.map((entry) => [entry.attendeeId, entry.chargeCents]))).toEqual({ a: 100, b: 200, c: 300 });
  });

  it("places that cannot be the priced indexes are sent to review rather than guessed", async () => {
    state.registrations = [build("reg-1", "CAM-1", "Alpha", { people: [place("a", "Ann", 0), place("b", "Bo", 0)], prices: [100, 200] })];
    state.checkIns = [];
    ["a", "b"].forEach(checkIn);
    await prepareReconciliation({ eventId: "event-1", actorUserId: actor });
    expect(registrations()[0]!.review?.reasons).toContain("ROSTER_POSITIONS");
  });
});

describe("roster review: acknowledgements", () => {
  const flagged = async () => {
    // Two leavers from a non-amended registration: the receiver cannot price its arrivals.
    const prices = [1000, 2000, 3000, 4000].map((cents, index) => ({ key: `attendees.${index}.fee`, label: "Fee", amountCents: cents, attendeeIndex: index }));
    state.registrations = [
      { id: "reg-1", code: "CAM-1", club: "Alpha", people: [{ id: "a", name: "Ann", position: 0 }, { id: "c", name: "Cy", position: 2 }], lines: prices, totalCents: 10000 },
      { id: "reg-2", code: "CAM-2", club: "Beta", people: [{ id: "zed", name: "Zed", position: 0 }, { id: "b", name: "Bo", position: 1 }, { id: "d", name: "Di", position: 2 }], lines: [{ key: "attendees.0.fee", label: "Fee", amountCents: 7000, attendeeIndex: 0 }], totalCents: 10000 },
    ];
    state.moves = [
      { id: "move-1", status: "APPROVED", registrationAttendeeId: "b", fromRegistrationId: "reg-1", toRegistrationId: "reg-2", decidedAt: new Date("2026-09-30T10:00:00Z") },
      { id: "move-2", status: "APPROVED", registrationAttendeeId: "d", fromRegistrationId: "reg-1", toRegistrationId: "reg-2", decidedAt: new Date("2026-09-30T10:00:00Z") },
    ];
    state.checkIns = [];
    ["a", "c", "b", "d", "zed"].forEach(checkIn);
    return prepareReconciliation({ eventId: "event-1", actorUserId: actor });
  };

  it("blocks approval until acknowledged, and a registration with no issue needs none", async () => {
    const prepared = await flagged();
    await expect(approveReconciliation({ eventId: "event-1", versionId: prepared.versionId, actorUserId: actor })).rejects.toMatchObject({ code: "REVIEW_REQUIRED" });
    await expect(acknowledgeRosterReview({ eventId: "event-1", registrationId: "reg-1", choice: "PRORATED", reason: "x", actorUserId: actor })).rejects.toMatchObject({ code: "NO_REVIEW_NEEDED" });
  });

  it("an acknowledgement needs a reason, is audited without it, and lets the next draft be approved", async () => {
    await flagged();
    await expect(acknowledgeRosterReview({ eventId: "event-1", registrationId: "reg-2", choice: "PRORATED", reason: "  ", actorUserId: actor })).rejects.toThrow("Say why you chose this figure.");
    await expect(acknowledgeRosterReview({ eventId: "event-1", registrationId: "reg-9", choice: "PRORATED", reason: "x", actorUserId: actor })).rejects.toMatchObject({ code: "REGISTRATION_NOT_FOUND" });
    expect(await acknowledgeRosterReview({ eventId: "event-1", registrationId: "reg-2", choice: "PRORATED", reason: "Arrivals were priced elsewhere", actorUserId: actor })).toMatchObject({ changed: true });
    expect(await acknowledgeRosterReview({ eventId: "event-1", registrationId: "reg-2", choice: "PRORATED", reason: "Arrivals were priced elsewhere", actorUserId: actor })).toMatchObject({ changed: false });
    expect(state.acknowledgements).toHaveLength(1);
    expect(JSON.stringify(state.audits)).not.toContain("Arrivals were priced");
    const next = await prepareReconciliation({ eventId: "event-1", actorUserId: actor });
    expect(next.created).toBe(true);
    expect(await approveReconciliation({ eventId: "event-1", versionId: next.versionId, actorUserId: actor })).toMatchObject({ changed: true });
  });

  it("changing PRORATED to PER_PERSON supersedes the earlier acknowledgement, which is kept; the latest wins", async () => {
    await flagged();
    await acknowledgeRosterReview({ eventId: "event-1", registrationId: "reg-2", choice: "PRORATED", reason: "First thought", actorUserId: actor });
    await acknowledgeRosterReview({ eventId: "event-1", registrationId: "reg-2", choice: "PER_PERSON", reason: "Second thought", actorUserId: actor });
    expect(state.acknowledgements).toHaveLength(2);
    expect(state.acknowledgements.filter((entry) => entry.supersededAt === null)).toHaveLength(1);
    expect(state.acknowledgements[0]?.supersededById).toBe(state.acknowledgements[1]?.id);
    const view = await getAttendanceReconciliationView("event-1");
    const receiver = view.isDeferred ? view.result.groups.flatMap((group) => group.registrations).find((entry) => entry.registrationId === "reg-2") : undefined;
    expect(receiver?.review).toMatchObject({ acknowledged: true, choice: "PER_PERSON" });
    expect(receiver?.basis).toBe("PER_PERSON_LINES");
  });

  it("a new stray price line needs a new acknowledgement: the key names exactly what was reviewed", async () => {
    state.registrations = [{
      id: "reg-1", code: "CAM-1", club: "Alpha", people: [person("a1", "Ann"), person("a2", "Bo")],
      lines: [0, 1, 5].map((index) => ({ key: `attendees.${index}.fee`, label: "Fee", amountCents: 100, attendeeIndex: index })), totalCents: 300,
    }];
    state.checkIns = [];
    checkIn("a1");
    await prepareReconciliation({ eventId: "event-1", actorUserId: actor });
    await acknowledgeRosterReview({ eventId: "event-1", registrationId: "reg-1", choice: "PRORATED", reason: "ok", actorUserId: actor });
    let view = await getAttendanceReconciliationView("event-1");
    expect(view.isDeferred && view.reviewPending.map((entry) => entry.registrationId)).not.toContain("reg-1");
    (sources()[0] as SourceRegistration).lines = [...(sources()[0] as SourceRegistration).lines!, { key: "attendees.6.fee", label: "Fee", amountCents: 100, attendeeIndex: 6 }];
    view = await getAttendanceReconciliationView("event-1");
    expect(view.isDeferred && view.reviewPending.map((entry) => entry.registrationId)).toContain("reg-1");
  });
});

describe("price lines are never doubted because of names", () => {
  it("a staff name edit after pricing, and generic labels, do not flag or change anything", async () => {
    state.registrations = [{
      id: "reg-1", code: "CAM-1", club: "Alpha",
      people: [person("a1", "Ann"), person("a2", "Bo"), person("a3", "Cy")],
      lines: [
        { key: "attendees.0.fee", label: "Fee", amountCents: 2500, attendeeIndex: 0, attendeeLabel: "Old Name Synthetic" },
        { key: "attendees.1.fee", label: "Fee", amountCents: 2500, attendeeIndex: 1, attendeeLabel: "Attendee 2" },
        { key: "attendees.2.fee", label: "Fee", amountCents: 2500, attendeeIndex: 2, attendeeLabel: "Camper 3" },
      ],
      totalCents: 7500,
    } satisfies SourceRegistration];
    state.checkIns = [];
    checkIn("a1"); checkIn("a2"); checkIn("a3");
    await prepareReconciliation({ eventId: "event-1", actorUserId: actor });
    const registration = (state.versions[0]!.snapshot as { groups: Array<{ registrations: Array<{ review: unknown; basis: string; billableCents: number }> }> }).groups[0]!.registrations[0]!;
    expect(registration).toMatchObject({ review: null, basis: "PER_PERSON_LINES", billableCents: 7500 });
  });
});

describe("what is saved, and when facts are read", () => {
  it("reads the billing view through the same transaction client as the locked work", async () => {
    await prepareReconciliation({ eventId: "event-1", actorUserId: actor });
    expect(billing.getBillingResponsibilityView).toHaveBeenCalledWith("event-1", {}, fakeDb);
    const prepared = state.versions[0]!;
    billing.getBillingResponsibilityView.mockClear();
    await approveReconciliation({ eventId: "event-1", versionId: prepared.id as string, actorUserId: actor });
    expect(billing.getBillingResponsibilityView).toHaveBeenCalledWith("event-1", {}, fakeDb);
  });

  it("keeps no reason text in a saved version or its fingerprint; the view reads it live from the correction", async () => {
    await recordAttendanceCorrection({ eventId: "event-1", attendeeId: "a3", kind: "MARK_ATTENDED", reason: "Missed at check-in, saw them on site", actorUserId: actor });
    await prepareReconciliation({ eventId: "event-1", actorUserId: actor });
    const stored = state.versions[0]!;
    expect(JSON.stringify(stored)).not.toContain("Missed at check-in");
    expect(JSON.stringify(stored)).not.toContain("Finance Staff");
    const view = await getAttendanceReconciliationView("event-1", { versionId: stored.id as string });
    expect(view.isDeferred && Object.values(view.correctionDetails)[0]).toMatchObject({ reason: "Missed at check-in, saw them on site", actorName: "Finance Staff" });
  });

  it("a withdrawn and re-entered identical correction leaves the draft valid (same fingerprint)", async () => {
    await recordAttendanceCorrection({ eventId: "event-1", attendeeId: "a3", kind: "MARK_ATTENDED", reason: "Came", actorUserId: actor });
    const prepared = await prepareReconciliation({ eventId: "event-1", actorUserId: actor });
    await recordAttendanceCorrection({ eventId: "event-1", attendeeId: "a3", kind: "CLEAR", reason: "Oops", actorUserId: actor });
    await recordAttendanceCorrection({ eventId: "event-1", attendeeId: "a3", kind: "MARK_ATTENDED", reason: "Came, as before", actorUserId: actor });
    const again = await prepareReconciliation({ eventId: "event-1", actorUserId: actor });
    expect(again).toMatchObject({ created: false, versionId: prepared.versionId });
  });

  it("prepares, approves and corrects under the event's lock, reading the facts inside the locked transaction", async () => {
    const locks = () => fakeDb.$executeRaw.mock.calls.length;
    await recordAttendanceCorrection({ eventId: "event-1", attendeeId: "a3", kind: "MARK_ATTENDED", reason: "Came", actorUserId: actor });
    expect(locks()).toBe(1);
    const prepared = await prepareReconciliation({ eventId: "event-1", actorUserId: actor });
    expect(locks()).toBe(2);
    await approveReconciliation({ eventId: "event-1", versionId: prepared.versionId, actorUserId: actor });
    expect(locks()).toBe(3);
  });

  it("refuses an approval when the facts changed between preparing and approving", async () => {
    const prepared = await prepareReconciliation({ eventId: "event-1", actorUserId: actor });
    await recordAttendanceCorrection({ eventId: "event-1", attendeeId: "a4", kind: "MARK_ATTENDED", reason: "Came", actorUserId: actor });
    await expect(approveReconciliation({ eventId: "event-1", versionId: prepared.versionId, actorUserId: actor })).rejects.toMatchObject({ code: "FACTS_CHANGED" });
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
