import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #780: manual invoice lines. The rules (validation, totals, fingerprint), the service's permission and draft-only
 * refusals against an in-memory stand-in for the Prisma calls it makes, and the migration that lets a draft's lines
 * change while a finalized version stays frozen. What only a real database proves (the trigger itself) is proved by
 * scripts/verify-invoices.ts. Synthetic data only.
 */
vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  event: { id: "event-1", name: "Spring Camporee 2027", startsAt: new Date("2027-04-01T12:00:00Z"), timezone: "America/Chicago", billingMode: "DEFERRED_ORGANIZATION_INVOICE", invoiceGrouping: "PER_CHURCH", invoiceCode: null, invoiceClubType: null } as Row,
  invoice: null as Row | null,
  versions: [] as Row[],
  audits: [] as Row[],
  updates: [] as Row[],
  ids: 0,
}));

const tx = {
  event: { findUnique: vi.fn(async () => state.event), update: vi.fn(async ({ data }: { data: Row }) => { Object.assign(state.event, data); return state.event; }) },
  invoice: {
    findFirst: vi.fn(async ({ where }: { where: Row }) => (state.invoice && state.invoice.id === where.id && state.invoice.eventId === where.eventId
      ? { ...state.invoice, versions: state.versions.filter((version) => version.status !== "DISCARDED").sort((a, b) => (b.revision as number) - (a.revision as number)) }
      : null)),
  },
  invoiceVersion: {
    findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => state.versions.find((version) => version.id === where.id)!),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
      const row = state.versions.find((version) => version.id === where.id)!;
      state.updates.push({ id: where.id, ...data });
      Object.assign(row, data);
      return row;
    }),
  },
  $queryRaw: vi.fn(async () => []),
};
const prismaMock = { ...tx, $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)) };

vi.mock("@/lib/prisma", () => ({ getPrisma: () => prismaMock }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: vi.fn(async (entry: Row) => { state.audits.push(entry); }) }));
vi.mock("@/modules/attendance-reconciliation/repository", () => ({
  LONG_TRANSACTION: { timeout: 30_000, maxWait: 10_000 },
  lockEvent: vi.fn(async () => undefined),
  loadReconciliationFacts: vi.fn(async () => ({ fingerprint: "fp", blockers: [] })),
}));
vi.mock("@/modules/billing-responsibility/repository", () => ({ getBillingResponsibilityView: vi.fn(async () => ({ groups: [] })) }));

import { reconcileEvent, type GroupSource, type PersonSource, type RegistrationSource } from "@/modules/attendance-reconciliation/domain";
import { amountsFingerprintOf, buildInvoiceFigures } from "@/modules/invoices/domain";
import {
  MANUAL_LINES_MAX,
  fingerprintWithManualLines,
  manualLinesTotal,
  normalizeManualLine,
  parseManualLines,
  withManualLines,
  type ManualInvoiceLine,
} from "@/modules/invoices/manual-lines";
import { InvoiceError, addManualInvoiceLine, removeManualInvoiceLine } from "@/modules/invoices/repository";
import { invoiceActionSchema } from "@/modules/invoices/schemas";

const person = (id: string): PersonSource => ({ attendeeId: id, name: `Person ${id}`, checkedIn: true, correction: null, addedAfterSubmission: false, substituted: false, chargeCents: 2500, lateRate: false, adjustmentCents: 0 });
const registration = (id: string, club: string, people: PersonSource[]): RegistrationSource => ({
  registrationId: id, confirmationCode: `C-${id}`, status: "CONFIRMED", label: club, clubId: `club-${club}`, locationId: null, locationName: null,
  estimatedCents: people.length * 2500, people, registrationCharges: [], credits: [], promo: null, review: null, registrationAdjustmentCents: 0, hasPriceLines: true,
});

function figures() {
  const source: GroupSource = { key: "church:church-1", title: "Church One", partyKind: "ORGANIZATION", partyId: "church-1", partyName: "Church One", clubId: null, registrations: [registration("r1", "Eagles", [person("a"), person("b")])] };
  const result = reconcileEvent([source], "PER_CHURCH");
  return buildInvoiceFigures({
    event: { id: "event-1", name: "Spring Camporee 2027" }, groupKey: result.groups[0]!.key, groupTitle: "Church One", invoiceGrouping: "PER_CHURCH",
    party: { kind: "ORGANIZATION", id: "church-1", name: "Church One" }, clubId: null, reconciliation: { versionId: "recon-1", versionNumber: 1, ruleVersion: result.ruleVersion }, group: result.groups[0]!,
  });
}

const line = (overrides: Partial<ManualInvoiceLine> = {}): ManualInvoiceLine => ({ id: "m1", item: "Patch order", description: "Camporee patches", quantity: 10, rateCents: 450, amountCents: 4500, ...overrides });

describe("manual line rules", () => {
  it("accepts item, description, quantity and rate, and computes the amount", () => {
    const result = normalizeManualLine({ item: "  Patch   order ", description: " Camporee patches ", quantity: 12, rateCents: 450 }, "id-1");
    expect(result).toEqual({ ok: true, line: { id: "id-1", item: "Patch order", description: "Camporee patches", quantity: 12, rateCents: 450, amountCents: 5400 } });
  });

  it("allows a negative rate (a credit) and an empty description", () => {
    expect(normalizeManualLine({ item: "Credit", quantity: 1, rateCents: -500 }, "x")).toMatchObject({ ok: true, line: { amountCents: -500, description: "" } });
  });

  it("refuses a missing item, a bad quantity and a zero or fractional rate", () => {
    expect(normalizeManualLine({ item: " ", quantity: 1, rateCents: 100 }, "x")).toMatchObject({ ok: false });
    expect(normalizeManualLine({ item: "A", quantity: 0, rateCents: 100 }, "x")).toMatchObject({ ok: false });
    expect(normalizeManualLine({ item: "A", quantity: 1.5, rateCents: 100 }, "x")).toMatchObject({ ok: false });
    expect(normalizeManualLine({ item: "A", quantity: 1, rateCents: 0 }, "x")).toMatchObject({ ok: false });
    expect(normalizeManualLine({ item: "A", quantity: 1, rateCents: 10.5 }, "x")).toMatchObject({ ok: false });
    expect(normalizeManualLine({ item: "A".repeat(61), quantity: 1, rateCents: 100 }, "x")).toMatchObject({ ok: false });
    expect(normalizeManualLine({ item: "A", description: "D".repeat(201), quantity: 1, rateCents: 100 }, "x")).toMatchObject({ ok: false });
  });

  it("includes the lines in the total and the fingerprint, and leaves both unchanged with none", () => {
    const base = figures();
    expect(withManualLines(base, [])).toEqual(base);
    const withLines = withManualLines(base, [line()]);
    expect(withLines.amountDueCents).toBe(base.amountDueCents + 4500);
    expect(withLines.amountsFingerprint).not.toBe(base.amountsFingerprint);
    expect(withLines.amountsFingerprint).toBe(fingerprintWithManualLines(base.amountsFingerprint, [line()]));
    // The snapshot itself is untouched: the lines live beside it.
    expect(withLines.snapshot).toBe(base.snapshot);
    expect(manualLinesTotal([line(), line({ id: "m2", amountCents: -100, quantity: 1, rateCents: -100 })])).toBe(4400);
    // Changing a line changes the fingerprint (so a revision that changes a manual line needs the Finalize invoices permission).
    expect(fingerprintWithManualLines(base.amountsFingerprint, [line({ quantity: 11, amountCents: 4950 })])).not.toBe(withLines.amountsFingerprint);
  });

  it("reads stored lines back and drops malformed entries", () => {
    expect(parseManualLines([line(), { id: 1 }, null, "x", { ...line({ id: "m3" }), quantity: "2" }])).toEqual([line()]);
    expect(parseManualLines(null)).toEqual([]);
  });

  it("the action schema reads the rate in dollars, including a negative one", () => {
    const base = { action: "add-manual-line", invoiceId: "i1", item: "Patches", quantity: 3 };
    expect(invoiceActionSchema.parse({ ...base, rate: "4.50" })).toMatchObject({ rate: 450 });
    expect(invoiceActionSchema.parse({ ...base, rate: "$1,200.00" })).toMatchObject({ rate: 120000 });
    expect(invoiceActionSchema.parse({ ...base, rate: "-5" })).toMatchObject({ rate: -500 });
    expect(() => invoiceActionSchema.parse({ ...base, rate: "abc" })).toThrow();
    expect(() => invoiceActionSchema.parse({ ...base, rate: "4.555" })).toThrow();
  });
});

function seed(status: "DRAFT" | "FINALIZED" = "DRAFT", basis: "RECONCILIATION" | "CONTACT_ONLY_COPY" = "RECONCILIATION", manual: ManualInvoiceLine[] = []) {
  const base = figures();
  const withLines = withManualLines(base, manual);
  state.invoice = { id: "inv-1", eventId: "event-1", groupKey: "church:church-1", invoiceGrouping: "PER_CHURCH", partyKind: "ORGANIZATION", partyId: "church-1", clubId: null, baseNumber: null };
  state.versions = [{
    id: "ver-1", invoiceId: "inv-1", revision: 0, status, basis, reconciliationVersionId: "recon-1", amountsFingerprint: withLines.amountsFingerprint, manualLines: manual,
    contactName: "Tina Treasurer", contactEmail: "tina@contact.test", supersedesVersionId: null, snapshot: base.snapshot, amountDueCents: withLines.amountDueCents,
  }];
}

const code = async (promise: Promise<unknown>) => promise.then(() => "ok", (error: unknown) => (error instanceof InvoiceError ? error.code : `other:${String(error)}`));
const newLine = { item: "Patch order", description: "Camporee patches", quantity: 10, rateCents: 450 };

beforeEach(() => {
  vi.clearAllMocks();
  state.audits = [];
  state.updates = [];
  seed();
});

describe("adding and removing manual lines needs Finalize invoices for the event", () => {
  it("refuses a user without the permission, before touching the database", async () => {
    expect(await code(addManualInvoiceLine({ eventId: "event-1", invoiceId: "inv-1", line: newLine, actorUserId: "u1", canFinalizeInvoices: false }))).toBe("FINALIZE_PERMISSION_REQUIRED");
    expect(await code(removeManualInvoiceLine({ eventId: "event-1", invoiceId: "inv-1", lineId: "m1", actorUserId: "u1", canFinalizeInvoices: false }))).toBe("FINALIZE_PERMISSION_REQUIRED");
    expect(tx.invoiceVersion.update).not.toHaveBeenCalled();
    expect(state.audits).toHaveLength(0);
  });

  it("a permitted user adds a line: it is stored with the total and fingerprint that include it, and audited", async () => {
    const base = figures();
    const result = await addManualInvoiceLine({ eventId: "event-1", invoiceId: "inv-1", line: newLine, actorUserId: "u1", canFinalizeInvoices: true });
    expect(result.amountDueCents).toBe(base.amountDueCents + 4500);
    const stored = state.versions[0]!;
    const lines = parseManualLines(stored.manualLines);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ item: "Patch order", quantity: 10, rateCents: 450, amountCents: 4500 });
    expect(stored.amountDueCents).toBe(base.amountDueCents + 4500);
    expect(stored.amountsFingerprint).toBe(fingerprintWithManualLines(amountsFingerprintOf(base.snapshot.lines, base.snapshot.totals.amountDueCents), lines));
    // Only the lines and the figures that include them are written: nothing else about the draft.
    expect(Object.keys(state.updates[0]!).sort()).toEqual(["amountDueCents", "amountsFingerprint", "id", "manualLines"]);
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0]).toMatchObject({ action: "INVOICE_MANUAL_LINE_ADDED", entityId: "ver-1", actorUserId: "u1" });
    expect(JSON.stringify(state.audits[0])).not.toContain("Camporee patches");
  });

  it("removing a line restores the reconciliation total and fingerprint", async () => {
    const base = figures();
    const added = await addManualInvoiceLine({ eventId: "event-1", invoiceId: "inv-1", line: newLine, actorUserId: "u1", canFinalizeInvoices: true });
    const removed = await removeManualInvoiceLine({ eventId: "event-1", invoiceId: "inv-1", lineId: added.lineId, actorUserId: "u1", canFinalizeInvoices: true });
    expect(removed.amountDueCents).toBe(base.amountDueCents);
    expect(state.versions[0]!.amountsFingerprint).toBe(base.amountsFingerprint);
    expect(parseManualLines(state.versions[0]!.manualLines)).toEqual([]);
    expect(state.audits.map((entry) => entry.action)).toEqual(["INVOICE_MANUAL_LINE_ADDED", "INVOICE_MANUAL_LINE_REMOVED"]);
  });

  it("refuses to remove a line that is not on the draft", async () => {
    expect(await code(removeManualInvoiceLine({ eventId: "event-1", invoiceId: "inv-1", lineId: "nope", actorUserId: "u1", canFinalizeInvoices: true }))).toBe("NO_CHANGE");
  });

  it("refuses a finalized invoice: the lines are frozen with it", async () => {
    seed("FINALIZED");
    expect(await code(addManualInvoiceLine({ eventId: "event-1", invoiceId: "inv-1", line: newLine, actorUserId: "u1", canFinalizeInvoices: true }))).toBe("NOT_A_DRAFT");
    seed("FINALIZED", "RECONCILIATION", [line()]);
    expect(await code(removeManualInvoiceLine({ eventId: "event-1", invoiceId: "inv-1", lineId: "m1", actorUserId: "u1", canFinalizeInvoices: true }))).toBe("NOT_A_DRAFT");
    expect(tx.invoiceVersion.update).not.toHaveBeenCalled();
  });

  it("refuses an invoice of another event", async () => {
    expect(await code(addManualInvoiceLine({ eventId: "event-2", invoiceId: "inv-1", line: newLine, actorUserId: "u1", canFinalizeInvoices: true }))).toBe("INVOICE_NOT_FOUND");
  });

  it("refuses a contact-only copy and a draft with no invoice", async () => {
    seed("DRAFT", "CONTACT_ONLY_COPY");
    expect(await code(addManualInvoiceLine({ eventId: "event-1", invoiceId: "inv-1", line: newLine, actorUserId: "u1", canFinalizeInvoices: true }))).toBe("NOT_A_DRAFT");
    state.versions = [];
    expect(await code(addManualInvoiceLine({ eventId: "event-1", invoiceId: "inv-1", line: newLine, actorUserId: "u1", canFinalizeInvoices: true }))).toBe("NOT_A_DRAFT");
  });

  it("refuses an invalid line, a total below zero, and too many lines", async () => {
    expect(await code(addManualInvoiceLine({ eventId: "event-1", invoiceId: "inv-1", line: { ...newLine, quantity: 0 }, actorUserId: "u1", canFinalizeInvoices: true }))).toBe("INVALID_INPUT");
    expect(await code(addManualInvoiceLine({ eventId: "event-1", invoiceId: "inv-1", line: { item: "Big credit", quantity: 1, rateCents: -9_000_000 }, actorUserId: "u1", canFinalizeInvoices: true }))).toBe("NEGATIVE_TOTAL");
    expect(state.versions[0]!.manualLines).toEqual([]);
    seed("DRAFT", "RECONCILIATION", Array.from({ length: MANUAL_LINES_MAX }, (_, index) => line({ id: `m${index}` })));
    expect(await code(addManualInvoiceLine({ eventId: "event-1", invoiceId: "inv-1", line: newLine, actorUserId: "u1", canFinalizeInvoices: true }))).toBe("INVALID_INPUT");
  });
});

const migration = readFileSync(new URL("../prisma/migrations/20261005120000_invoice_pdf_sample_layout/migration.sql", import.meta.url), "utf8");
const sql = migration.split("\n").filter((entry) => !entry.trimStart().startsWith("--")).join("\n");
const initial = readFileSync(new URL("../prisma/migrations/20261004150000_invoices/migration.sql", import.meta.url), "utf8");
const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");

describe("the migration (#780)", () => {
  it("adds the columns the schema declares", () => {
    for (const column of ["invoiceHeaderDepartment", "invoiceHeaderOrganization", "invoiceHeaderAddress", "invoiceHeaderPhone", "invoiceClubType", "manualLines", "layoutInputs"]) {
      expect(sql).toContain(`"${column}"`);
      expect(schema).toContain(column);
    }
    expect(sql).toContain(`ADD COLUMN "manualLines" JSONB NOT NULL DEFAULT '[]'`);
    expect(sql).toContain(`jsonb_typeof("manualLines") = 'array'`);
  });

  it("lets a draft's lines and the totals that include them change without a regeneration, and nothing else", () => {
    expect(sql).toContain(`editing_lines CONSTANT text[] := ARRAY['manualLines', 'amountDueCents', 'amountsFingerprint']`);
    expect(sql).toContain(`OLD."status" = 'DRAFT' AND NEW."status" = 'DRAFT' AND NEW."manualLines" IS DISTINCT FROM OLD."manualLines" AND (new_json - editing_lines) = (old_json - editing_lines)`);
  });

  it("keeps every other freeze rule of the invoice-version guard as the first migration wrote it", () => {
    // The finalizing and superseding column lists do not include the lines, so a finalized version's lines can never change.
    const finalizing = /finalizing CONSTANT text\[\] := ARRAY\[([^\]]*)\]/.exec(sql)![1]!;
    const superseding = /superseding CONSTANT text\[\] := ARRAY\[([^\]]*)\]/.exec(sql)![1]!;
    expect(finalizing).not.toMatch(/manualLines|amountDueCents|amountsFingerprint/);
    expect(superseding).not.toMatch(/manualLines|amountDueCents|amountsFingerprint/);
    for (const message of ["An invoice version starts as a draft.", "An invoice version is never deleted.", "A draft is regenerated one step at a time.", "Finalizing changes only the number and the approval.", "A finalized invoice version is an immutable snapshot."]) {
      expect(initial).toContain(message);
      expect(sql).toContain(message);
    }
    expect(sql).toContain('CREATE OR REPLACE FUNCTION "InvoiceVersion_guard"()');
  });
});
