import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #167: the service's refusals and its drafting, against a small in-memory stand-in for the Prisma
 * calls it makes and mocked reconciliation and billing facts. What only a real database can prove
 * (one number under parallel requests, immutable finalized versions, the counter, receivables,
 * revisions end to end) is proved by scripts/verify-invoices.ts. Synthetic data only.
 */
vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  event: { id: "event-1", name: "Spring Camporee 2027", startsAt: new Date("2027-04-01T12:00:00Z"), timezone: "America/Chicago", billingMode: "DEFERRED_ORGANIZATION_INVOICE", invoiceGrouping: "PER_CHURCH", invoiceCode: null } as Row,
  approved: null as Row | null,
  facts: { fingerprint: "fp-1", blockers: [] as unknown[] },
  billing: { groups: [] as unknown[] },
  invoices: [] as Row[],
  versions: [] as Row[],
  audits: [] as Row[],
  counters: [] as Row[],
  ids: 0,
}));

const nextId = (prefix: string) => `${prefix}-${++state.ids}`;

const tx = {
  event: { findUnique: vi.fn(async () => state.event), update: vi.fn(async () => state.event) },
  attendanceReconciliationVersion: { findFirst: vi.fn(async () => state.approved) },
  invoice: {
    findMany: vi.fn(async () => state.invoices.map((invoice) => ({ ...invoice, versions: state.versions.filter((version) => version.invoiceId === invoice.id).sort((a, b) => (b.revision as number) - (a.revision as number)) }))),
    create: vi.fn(async ({ data }: { data: Row }) => { const row = { id: nextId("inv"), baseNumber: null, ...data }; state.invoices.push(row); return row; }),
  },
  invoiceVersion: {
    create: vi.fn(async ({ data }: { data: Row }) => { const row = { id: nextId("ver"), status: "DRAFT", regenerationCount: 0, ...data }; state.versions.push(row); return row; }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
      const row = state.versions.find((version) => version.id === where.id)!;
      for (const [key, value] of Object.entries(data)) {
        row[key] = value && typeof value === "object" && "increment" in (value as Row) ? (row[key] as number) + ((value as Row).increment as number) : value;
      }
      return row;
    }),
    findFirst: vi.fn(async ({ where }: { where: Row }) => state.versions.find((version) => version.id === where.id && (!where.eventId || version.eventId === where.eventId)) ?? null),
    findUnique: vi.fn(async ({ where }: { where: Row }) => state.versions.find((version) => version.finalizeIdempotencyKey === where.finalizeIdempotencyKey) ?? null),
  },
  invoiceNumberCounter: { count: vi.fn(async () => state.counters.length) },
  $queryRaw: vi.fn(async () => []),
};

const prismaMock = { ...tx, $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)) };

vi.mock("@/lib/prisma", () => ({ getPrisma: () => prismaMock }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: vi.fn(async (entry: Row) => { state.audits.push(entry); }) }));
vi.mock("@/modules/attendance-reconciliation/repository", () => ({
  LONG_TRANSACTION: { timeout: 30_000, maxWait: 10_000 },
  lockEvent: vi.fn(async () => undefined),
  loadReconciliationFacts: vi.fn(async () => state.facts),
}));
vi.mock("@/modules/billing-responsibility/repository", () => ({ getBillingResponsibilityView: vi.fn(async () => state.billing) }));

import { InvoiceError, createInvoiceDrafts, finalizeInvoiceVersion, reviseInvoice, setEventInvoiceCode } from "@/modules/invoices/repository";
import { reconcileEvent, type GroupSource, type PersonSource } from "@/modules/attendance-reconciliation/domain";

const person = (id: string, checkedIn: boolean): PersonSource => ({ attendeeId: id, name: `Person ${id}`, checkedIn, correction: null, addedAfterSubmission: false, substituted: false, chargeCents: 2500, lateRate: false, adjustmentCents: 0 });
const registration = (id: string, club: string, people: PersonSource[]) => ({
  registrationId: id, confirmationCode: `C-${id}`, status: "CONFIRMED" as const, label: club, clubId: `club-${club}`, locationId: null, locationName: null,
  estimatedCents: people.length * 2500, people, registrationCharges: [], credits: [], promo: null, review: null, registrationAdjustmentCents: 0, hasPriceLines: true,
});
const group = (key: string, title: string, registrations: ReturnType<typeof registration>[], clubId: string | null = null): GroupSource => ({ key, title, partyKind: "ORGANIZATION", partyId: "church-1", partyName: "Church One", clubId, registrations });

function approve(groups: GroupSource[], grouping: "PER_CHURCH" | "PER_CLUB" = "PER_CHURCH") {
  const result = reconcileEvent(groups, grouping);
  state.approved = { id: "recon-1", versionNumber: 1, status: "APPROVED", fingerprint: "fp-1", ruleVersion: result.ruleVersion, invoiceGrouping: grouping, billableCents: result.totals.billableCents, approvedAt: new Date("2026-10-04T10:00:00Z"), snapshot: result };
  state.billing = {
    groups: groups.map((entry) => ({ key: entry.key, title: entry.title, party: { kind: "ORGANIZATION", id: "church-1", name: "Church One" }, clubId: entry.clubId, readiness: "READY", contact: { name: "Tina Treasurer", email: "tina@contact.test", roleLabel: "Treasurer", effectiveFrom: "2026-01-01T00:00:00Z", verifiedAt: "2026-02-01T00:00:00Z" } })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.event = { id: "event-1", name: "Spring Camporee 2027", startsAt: new Date("2027-04-01T12:00:00Z"), timezone: "America/Chicago", billingMode: "DEFERRED_ORGANIZATION_INVOICE", invoiceGrouping: "PER_CHURCH", invoiceCode: null };
  state.approved = null;
  state.facts = { fingerprint: "fp-1", blockers: [] };
  state.billing = { groups: [] };
  state.invoices = [];
  state.versions = [];
  state.audits = [];
  state.counters = [];
  state.ids = 0;
});

const actor = "user-1";
/** How many times a number was taken from the counter. */
const numberAllocations = () => (tx.$queryRaw.mock.calls as unknown as Array<[string[]]>).filter((call) => call[0].join("").includes("InvoiceNumberCounter")).length;
const code = async (promise: Promise<unknown>) => promise.then(() => "ok", (error: unknown) => (error instanceof InvoiceError ? error.code : `other:${String(error)}`));

describe("creating drafts is refused without a current approved reconciliation", () => {
  it("no approved version", async () => {
    expect(await code(createInvoiceDrafts({ eventId: "event-1", actorUserId: actor }))).toBe("NO_APPROVED_RECONCILIATION");
    expect(state.invoices).toHaveLength(0);
    expect(state.audits).toHaveLength(0);
  });

  it("an approval whose facts changed (FACTS_CHANGED)", async () => {
    approve([group("organization:church-1", "Church One", [registration("r1", "Alpha", [person("a1", true)])])]);
    state.facts = { fingerprint: "fp-2", blockers: [] };
    expect(await code(createInvoiceDrafts({ eventId: "event-1", actorUserId: actor }))).toBe("FACTS_CHANGED");
    expect(state.invoices).toHaveLength(0);
  });

  it("billing-responsibility blockers", async () => {
    approve([group("organization:church-1", "Church One", [registration("r1", "Alpha", [person("a1", true)])])]);
    state.facts = { fingerprint: "fp-1", blockers: [{ registrationId: "r9", confirmationCode: "C-9", label: "Club", reason: "UNRECORDED" }] };
    const error = await createInvoiceDrafts({ eventId: "event-1", actorUserId: actor }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InvoiceError);
    expect((error as InvoiceError).code).toBe("RESPONSIBILITY_NOT_READY");
    expect((error as InvoiceError).blockers).toHaveLength(1);
    expect(state.invoices).toHaveLength(0);
  });

  it("an event not billed to organizations, and an unknown event", async () => {
    state.event = { ...state.event, billingMode: "ATTENDEE_PAY" };
    expect(await code(createInvoiceDrafts({ eventId: "event-1", actorUserId: actor }))).toBe("NOT_DEFERRED_EVENT");
    tx.event.findUnique.mockResolvedValueOnce(null as never);
    expect(await code(createInvoiceDrafts({ eventId: "nope", actorUserId: actor }))).toBe("EVENT_NOT_FOUND");
  });
});

describe("creating drafts from an approved reconciliation", () => {
  it("a draft whose manual lines would bring the rebuilt total below $0 is left as it was and reported, and the other churches carry on (#780)", async () => {
    const groups = (attended: boolean) => [
      group("organization:church-1", "Church One", [registration("r1", "Alpha", [person("a1", true), person("a2", attended)])]),
      group("organization:church-2", "Church Two", [registration("r2", "Beta", [person("b1", attended)])]),
    ];
    approve(groups(true));
    await createInvoiceDrafts({ eventId: "event-1", actorUserId: actor });
    // Church One's draft carries a $-40 credit line (total $50 - $40 = $10 now); Church Two's carries none.
    const one = state.versions.find((version) => state.invoices.find((invoice) => invoice.id === version.invoiceId)?.groupKey === "organization:church-1")!;
    one.manualLines = [{ id: "m1", item: "Credit", description: "", quantity: 1, rateCents: -4000, amountCents: -4000 }];
    one.amountDueCents = 1000;
    // The reconciliation is approved again with fewer people attending: Church One would be $25 - $40 < $0.
    state.approved = null;
    approve(groups(false).map((entry, index) => (index === 0 ? group("organization:church-1", "Church One", [registration("r1", "Alpha", [person("a1", true), person("a2", false)])]) : entry)));
    state.approved!.id = "recon-2";
    const run = await createInvoiceDrafts({ eventId: "event-1", actorUserId: actor });
    expect(run.negativeTotal).toEqual(["Church One"]);
    expect(one.amountDueCents).toBe(1000);
    expect(one.regenerationCount).toBe(0);
    expect(state.audits.at(-1)?.metadata).toMatchObject({ negativeTotal: 1 });
  });

  it("makes one invoice per church with a line per club, tracing to the reconciliation and snapshotting the contact", async () => {
    approve([
      group("organization:church-1", "Church One", [registration("r1", "Alpha", [person("a1", true), person("a2", false)]), registration("r2", "Beta", [person("b1", true)])]),
      group("organization:church-2", "Church Two", [registration("r3", "Gamma", [person("c1", false)])]),
    ]);
    const run = await createInvoiceDrafts({ eventId: "event-1", actorUserId: actor });
    expect(run).toMatchObject({ created: 2, regenerated: 0, unchanged: 0, finalized: 0 });
    expect(state.invoices.map((invoice) => invoice.groupKey)).toEqual(["organization:church-1", "organization:church-2"]);
    const [one, two] = state.versions;
    expect(one).toMatchObject({ status: "DRAFT", revision: 0, basis: "RECONCILIATION", reconciliationVersionId: "recon-1", amountDueCents: 5000, billableCount: 2, registeredCount: 3, contactName: "Tina Treasurer", contactEmail: "tina@contact.test", createdByUserId: actor });
    expect((one!.snapshot as { lines: unknown[] }).lines).toHaveLength(2);
    expect(two).toMatchObject({ amountDueCents: 0, billableCount: 0 });
    expect(state.audits.map((entry) => entry.action)).toEqual(["INVOICE_DRAFTS_CREATED"]);
    expect(JSON.stringify(state.audits)).not.toContain("tina@contact.test");
  });

  it("makes one invoice per club under per-club grouping", async () => {
    state.event = { ...state.event, invoiceGrouping: "PER_CLUB" };
    approve([
      group("organization:church-1|club:club-Alpha", "Alpha", [registration("r1", "Alpha", [person("a1", true)])], "club-Alpha"),
      group("organization:church-1|club:club-Beta", "Beta", [registration("r2", "Beta", [person("b1", true)])], "club-Beta"),
    ], "PER_CLUB");
    expect((await createInvoiceDrafts({ eventId: "event-1", actorUserId: actor })).created).toBe(2);
    expect(state.invoices.map((invoice) => [invoice.groupKey, invoice.invoiceGrouping, invoice.clubId])).toEqual([
      ["organization:church-1|club:club-Alpha", "PER_CLUB", "club-Alpha"],
      ["organization:church-1|club:club-Beta", "PER_CLUB", "club-Beta"],
    ]);
  });

  it("creating again changes nothing; a changed contact or amount regenerates the draft only", async () => {
    approve([group("organization:church-1", "Church One", [registration("r1", "Alpha", [person("a1", true)])])]);
    await createInvoiceDrafts({ eventId: "event-1", actorUserId: actor });
    expect(await createInvoiceDrafts({ eventId: "event-1", actorUserId: actor })).toMatchObject({ created: 0, unchanged: 1, regenerated: 0 });
    expect(state.versions).toHaveLength(1);
    (state.billing.groups[0] as { contact: { name: string } }).contact.name = "Sam Successor";
    expect(await createInvoiceDrafts({ eventId: "event-1", actorUserId: actor })).toMatchObject({ created: 0, regenerated: 1 });
    expect(state.versions[0]).toMatchObject({ contactName: "Sam Successor", regenerationCount: 1 });
    approve([group("organization:church-1", "Church One", [registration("r1", "Alpha", [person("a1", true), person("a2", true)])])]);
    expect(await createInvoiceDrafts({ eventId: "event-1", actorUserId: actor })).toMatchObject({ regenerated: 1 });
    expect(state.versions[0]).toMatchObject({ amountDueCents: 5000, regenerationCount: 2 });
  });

  it("never touches a finalized invoice, and flags it when it no longer matches", async () => {
    approve([group("organization:church-1", "Church One", [registration("r1", "Alpha", [person("a1", true)])])]);
    await createInvoiceDrafts({ eventId: "event-1", actorUserId: actor });
    state.versions[0]!.status = "FINALIZED";
    state.invoices[0]!.baseNumber = "SC27-0001";
    expect(await createInvoiceDrafts({ eventId: "event-1", actorUserId: actor })).toMatchObject({ finalized: 1, needRevision: 0 });
    approve([group("organization:church-1", "Church One", [registration("r1", "Alpha", [person("a1", true), person("a2", true)])])]);
    expect(await createInvoiceDrafts({ eventId: "event-1", actorUserId: actor })).toMatchObject({ finalized: 1, needRevision: 1, regenerated: 0, created: 0 });
    expect(state.versions).toHaveLength(1);
    expect(state.versions[0]!.amountDueCents).toBe(2500);
  });

  it("refuses drafting under a different grouping than the finalized invoices", async () => {
    approve([group("organization:church-1", "Church One", [registration("r1", "Alpha", [person("a1", true)])])]);
    await createInvoiceDrafts({ eventId: "event-1", actorUserId: actor });
    state.versions[0]!.status = "FINALIZED";
    state.invoices[0]!.baseNumber = "SC27-0001";
    approve([group("organization:church-1|club:club-Alpha", "Alpha", [registration("r1", "Alpha", [person("a1", true)])], "club-Alpha")], "PER_CLUB");
    expect(await code(createInvoiceDrafts({ eventId: "event-1", actorUserId: actor }))).toBe("GROUPING_CONFLICT");
  });
});

describe("finalizing and revising are refused before anything changes", () => {
  const base = { eventId: "event-1", actorUserId: actor, idempotencyKey: "key-0123456789abcdef" };

  it("needs an explicit confirmation", async () => {
    expect(await code(finalizeInvoiceVersion({ ...base, versionId: "ver-1", confirm: false, canFinalizeInvoices: true }))).toBe("CONFIRMATION_REQUIRED");
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("needs the permission for an original invoice, and a version of another event is not found", async () => {
    approve([group("organization:church-1", "Church One", [registration("r1", "Alpha", [person("a1", true)])])]);
    await createInvoiceDrafts({ eventId: "event-1", actorUserId: actor });
    state.versions[0]!.invoice = { id: "inv-1", groupKey: "organization:church-1", partyKind: "ORGANIZATION", partyId: "church-1", clubId: null, baseNumber: null };
    expect(await code(finalizeInvoiceVersion({ ...base, versionId: state.versions[0]!.id as string, confirm: true, canFinalizeInvoices: false }))).toBe("FINALIZE_PERMISSION_REQUIRED");
    expect(await code(finalizeInvoiceVersion({ ...base, eventId: "event-2", versionId: state.versions[0]!.id as string, confirm: true, canFinalizeInvoices: true }))).toBe("VERSION_NOT_FOUND");
    expect(state.counters).toHaveLength(0);
    expect(numberAllocations()).toBe(0);
  });

  it("cannot finalize an original from an approval whose facts changed", async () => {
    approve([group("organization:church-1", "Church One", [registration("r1", "Alpha", [person("a1", true)])])]);
    await createInvoiceDrafts({ eventId: "event-1", actorUserId: actor });
    state.versions[0]!.invoice = { id: "inv-1", groupKey: "organization:church-1", partyKind: "ORGANIZATION", partyId: "church-1", clubId: null, baseNumber: null };
    state.facts = { fingerprint: "fp-2", blockers: [] };
    expect(await code(finalizeInvoiceVersion({ ...base, versionId: state.versions[0]!.id as string, confirm: true, canFinalizeInvoices: true }))).toBe("FACTS_CHANGED");
    expect(numberAllocations()).toBe(0);
  });

  it("a key already used by another invoice cannot be reused", async () => {
    state.versions.push({ id: "ver-9", eventId: "event-1", status: "FINALIZED", finalizeIdempotencyKey: base.idempotencyKey, number: "SC27-0001" });
    state.versions.push({ id: "ver-8", eventId: "event-1", status: "DRAFT", invoiceId: "inv-8" });
    expect(await code(finalizeInvoiceVersion({ ...base, versionId: "ver-8", confirm: true, canFinalizeInvoices: true }))).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("revising needs a finalized invoice of this event", async () => {
    tx.invoice.findMany.mockClear();
    const findFirst = vi.fn(async () => null);
    (tx as unknown as { invoice: Row }).invoice.findFirst = findFirst;
    expect(await code(reviseInvoice({ eventId: "event-1", invoiceId: "inv-other", mode: "CONTACT_ONLY", reason: "x", actorUserId: actor }))).toBe("INVOICE_NOT_FOUND");
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "inv-other", eventId: "event-1" } }));
  });
});

describe("the event's invoice code", () => {
  it("is refused when invalid and when numbers were already issued", async () => {
    expect(await code(setEventInvoiceCode({ eventId: "event-1", code: "S1", actorUserId: actor }))).toBe("CODE_INVALID");
    state.counters.push({ code: "SC", year: 2027 });
    expect(await code(setEventInvoiceCode({ eventId: "event-1", code: "SC", actorUserId: actor }))).toBe("CODE_LOCKED");
    expect(tx.event.update).not.toHaveBeenCalled();
  });
});
