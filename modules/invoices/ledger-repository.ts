import "server-only";

import { Prisma, type PrismaClient } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { InvoiceError } from "@/modules/invoices/repository";
import {
  MAX_PAYMENT_CENTS,
  correctArSchema,
  formatDateOnly,
  normalizePaymentInstructions,
  outstandingFigures,
  parseDateOnly,
  parseMoneyToCents,
  postToArSchema,
  recordPaymentSchema,
  settlementStatus,
  voidedPaymentIds,
  voidPaymentSchema,
  type SettlementStatus,
  type TreasurerCsvInvoice,
} from "@/modules/invoices/delivery-domain";

/**
 * Accounts receivable, manual payments, statements and finance reporting for deferred-organization
 * invoices (#168). Churches pay by check and the conference keeps its own books, so this records what staff
 * tell it: "Posted to AR" (a date and an optional reference, once per finalized version) and payments received
 * (amount, date, optional check number, note). Every row is append-only (database triggers): an AR posting is
 * corrected by a new posting that names the one it corrects; a payment is voided by a REVERSAL entry that names
 * it and gives a reason. Refunds are out of scope.
 *
 * How payments follow a revision. A payment is recorded against the OPEN receivable of the version that is
 * finalized when it is recorded. When a revision is finalized, that version and its receivable become
 * SUPERSEDED and the revision gets its own OPEN receivable, but no payment row moves or changes: what is
 * outstanding is always the live version's total less every payment (net of voids) on the INVOICE, whichever
 * version each was recorded against. Paying a $100 invoice $60 and then revising it to $90 leaves $30 outstanding;
 * revising it to $50 shows $10 overpaid, flagged for staff and never silently dropped. The "Posted to AR" mark is
 * per version (the books carry the amount that was posted), so a revision is posted again.
 *
 * Every function takes the event the caller was authorized for (MANAGE_FINANCE on the URL's event, checked by the
 * route or page) and refuses anything that is not on that event. Statements are scoped the same way: the
 * invoices of the one event in the URL, never another event's, even for the same church. Audit entries carry ids,
 * numbers and amounts only, never a contact's name or email.
 */

type Client = Prisma.TransactionClient | PrismaClient;

const notFound = () => new InvoiceError("That invoice version does not belong to this event.", "VERSION_NOT_FOUND");

function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function isDatabaseRefusal(error: unknown) {
  return error instanceof Error && error.message.includes("23001");
}

async function lockInvoice(tx: Prisma.TransactionClient, invoiceId: string) {
  await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${invoiceId} FOR UPDATE`;
}

async function actorDisplayName(tx: Client, userId: string) {
  const user = await tx.user.findUnique({ where: { id: userId }, select: { displayName: true } });
  return user?.displayName ?? "Staff";
}

// ---------------------------------------------------------------------------------------------
// Finance setting: the payment instruction printed on invoice PDFs
// ---------------------------------------------------------------------------------------------

/** Sets (or clears) the event's payment instruction. Applies to PDFs made after this; an earlier PDF keeps what it said. */
export async function setInvoicePaymentInstructions(input: { eventId: string; instructions: string | null; actorUserId: string }) {
  const normalized = normalizePaymentInstructions(input.instructions);
  if (!normalized.ok) throw new InvoiceError(normalized.message, "INVALID_INPUT");
  const prisma = getPrisma();
  return prisma.$transaction(async (tx) => {
    const event = await tx.event.findUnique({ where: { id: input.eventId }, select: { id: true, invoicePaymentInstructions: true } });
    if (!event) throw new InvoiceError("That event does not exist.", "EVENT_NOT_FOUND");
    if ((event.invoicePaymentInstructions ?? null) === normalized.value) return { changed: false, instructions: normalized.value };
    await tx.event.update({ where: { id: event.id }, data: { invoicePaymentInstructions: normalized.value } });
    await writeAuditLog({
      eventId: event.id,
      actorUserId: input.actorUserId,
      action: "INVOICE_PAYMENT_INSTRUCTIONS_CHANGED",
      entityType: "Event",
      entityId: event.id,
      summary: normalized.value === null ? "Cleared the invoice payment instruction (the default applies)." : "Changed the invoice payment instruction.",
      metadata: { eventId: event.id, cleared: normalized.value === null, length: normalized.value?.length ?? 0 },
    }, tx);
    return { changed: true, instructions: normalized.value };
  });
}

// ---------------------------------------------------------------------------------------------
// Posted to AR
// ---------------------------------------------------------------------------------------------

async function loadVersionForLedger(tx: Prisma.TransactionClient, eventId: string, versionId: string) {
  const version = await tx.invoiceVersion.findFirst({ where: { id: versionId, eventId }, select: { id: true, invoiceId: true, status: true, number: true } });
  if (!version) throw notFound();
  await lockInvoice(tx, version.invoiceId);
  // Read again under the invoice lock: a revision finalized meanwhile has superseded it.
  const fresh = await tx.invoiceVersion.findUniqueOrThrow({ where: { id: version.id }, select: { id: true, invoiceId: true, status: true, number: true } });
  if (fresh.status !== "FINALIZED") {
    throw new InvoiceError(
      fresh.status === "SUPERSEDED" ? "That version was replaced by a newer one. Work on the newer version." : "Only a finalized invoice version can be posted to AR or paid.",
      "NOT_FINALIZED",
    );
  }
  return fresh as typeof fresh & { number: string };
}

/** Marks a finalized version "Posted to AR". Once per version; a mistake is corrected with `correctArPosting`, never edited. */
export async function postInvoiceToAr(input: { eventId: string; versionId: string; postedOn: string; reference?: string | null; actorUserId: string }) {
  const parsed = postToArSchema.safeParse({ versionId: input.versionId, postedOn: input.postedOn, reference: input.reference ?? null });
  if (!parsed.success) throw new InvoiceError(parsed.error.issues[0]?.message ?? "Check the date.", "INVALID_INPUT");
  const postedOn = parseDateOnly(parsed.data.postedOn)!;
  const prisma = getPrisma();
  try {
    return await prisma.$transaction(async (tx) => {
      const version = await loadVersionForLedger(tx, input.eventId, input.versionId);
      const existing = await tx.invoiceArPosting.findFirst({ where: { invoiceVersionId: version.id, correctsPostingId: null }, select: { id: true } });
      if (existing) throw new InvoiceError("This invoice is already posted to AR. To change the date or reference, correct the posting.", "ALREADY_POSTED");
      const recordedByName = await actorDisplayName(tx, input.actorUserId);
      const posting = await tx.invoiceArPosting.create({
        data: { eventId: input.eventId, invoiceId: version.invoiceId, invoiceVersionId: version.id, postedOn, reference: parsed.data.reference, recordedByUserId: input.actorUserId, recordedByName },
        select: { id: true },
      });
      await writeAuditLog({
        eventId: input.eventId,
        actorUserId: input.actorUserId,
        action: "INVOICE_POSTED_TO_AR",
        entityType: "InvoiceVersion",
        entityId: version.id,
        summary: `Marked invoice ${version.number} as posted to AR.`,
        metadata: { eventId: input.eventId, invoiceId: version.invoiceId, versionId: version.id, postingId: posting.id, number: version.number, postedOn: parsed.data.postedOn, hasReference: parsed.data.reference !== null },
      }, tx);
      return { postingId: posting.id, versionId: version.id, invoiceId: version.invoiceId };
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new InvoiceError("This invoice is already posted to AR. To change the date or reference, correct the posting.", "ALREADY_POSTED");
    if (isDatabaseRefusal(error)) throw new InvoiceError("That could not be saved for this invoice version.", "NOT_FINALIZED");
    throw error;
  }
}

/** Corrects the latest AR posting of a version with a new, superseding posting and a reason. The earlier posting stays on record. */
export async function correctArPosting(input: { eventId: string; versionId: string; postedOn: string; reference?: string | null; reason: string; actorUserId: string }) {
  const parsed = correctArSchema.safeParse({ versionId: input.versionId, postedOn: input.postedOn, reference: input.reference ?? null, reason: input.reason });
  if (!parsed.success) throw new InvoiceError(parsed.error.issues[0]?.message ?? "Check the details.", "INVALID_INPUT");
  const postedOn = parseDateOnly(parsed.data.postedOn)!;
  const prisma = getPrisma();
  try {
    return await prisma.$transaction(async (tx) => {
      const version = await loadVersionForLedger(tx, input.eventId, input.versionId);
      const postings = await tx.invoiceArPosting.findMany({ where: { invoiceVersionId: version.id }, select: { id: true, correctsPostingId: true } });
      const corrected = new Set(postings.flatMap((posting) => (posting.correctsPostingId ? [posting.correctsPostingId] : [])));
      const tip = postings.find((posting) => !corrected.has(posting.id));
      if (!tip) throw new InvoiceError("This invoice has not been posted to AR yet.", "NOT_POSTED");
      const recordedByName = await actorDisplayName(tx, input.actorUserId);
      const posting = await tx.invoiceArPosting.create({
        data: { eventId: input.eventId, invoiceId: version.invoiceId, invoiceVersionId: version.id, postedOn, reference: parsed.data.reference, correctsPostingId: tip.id, reason: parsed.data.reason, recordedByUserId: input.actorUserId, recordedByName },
        select: { id: true },
      });
      await writeAuditLog({
        eventId: input.eventId,
        actorUserId: input.actorUserId,
        action: "INVOICE_AR_POSTING_CORRECTED",
        entityType: "InvoiceVersion",
        entityId: version.id,
        summary: `Corrected the AR posting of invoice ${version.number}.`,
        metadata: { eventId: input.eventId, invoiceId: version.invoiceId, versionId: version.id, postingId: posting.id, correctsPostingId: tip.id, number: version.number, postedOn: parsed.data.postedOn },
      }, tx);
      return { postingId: posting.id, correctsPostingId: tip.id, versionId: version.id, invoiceId: version.invoiceId };
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new InvoiceError("Someone else just corrected this posting. Reload and try again.", "CONCURRENT_CHANGE");
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------------------------

/** Records a check received against a finalized invoice. Append-only; partial payments are allowed and an overpayment is accepted but flagged. */
export async function recordInvoicePayment(input: {
  eventId: string;
  invoiceId: string;
  amount: string;
  checkNumber?: string | null;
  receivedOn: string;
  note?: string | null;
  requestKey: string;
  actorUserId: string;
}) {
  const parsed = recordPaymentSchema.safeParse({ invoiceId: input.invoiceId, amount: input.amount, checkNumber: input.checkNumber ?? null, receivedOn: input.receivedOn, note: input.note ?? null, requestKey: input.requestKey });
  if (!parsed.success) throw new InvoiceError(parsed.error.issues[0]?.message ?? "Check the details.", "INVALID_INPUT");
  const amountCents = parseMoneyToCents(parsed.data.amount);
  if (amountCents === null || amountCents <= 0) throw new InvoiceError("Enter an amount greater than zero, like 250.00.", "INVALID_INPUT");
  if (amountCents > MAX_PAYMENT_CENTS) throw new InvoiceError("That amount is larger than a single payment can be. Check it.", "INVALID_INPUT");
  const receivedOn = parseDateOnly(parsed.data.receivedOn)!;
  const prisma = getPrisma();
  const replay = async (client: Client) => {
    const existing = await client.invoicePayment.findUnique({ where: { requestKey: parsed.data.requestKey }, select: { id: true, eventId: true, invoiceId: true, kind: true, amountCents: true } });
    if (!existing) return null;
    if (existing.eventId !== input.eventId || existing.invoiceId !== parsed.data.invoiceId || existing.kind !== "PAYMENT" || existing.amountCents !== amountCents) {
      throw new InvoiceError("That request key was already used for a different entry. Reload the page and try again.", "IDEMPOTENCY_KEY_REUSED");
    }
    return existing.id;
  };
  try {
    return await prisma.$transaction(async (tx) => {
      const invoice = await tx.invoice.findFirst({ where: { id: parsed.data.invoiceId, eventId: input.eventId }, select: { id: true } });
      if (!invoice) throw new InvoiceError("That invoice does not belong to this event.", "INVOICE_NOT_FOUND");
      await lockInvoice(tx, invoice.id);
      const replayed = await replay(tx);
      if (replayed) return { paymentId: replayed, replayed: true, ...(await balanceOf(tx, invoice.id)) };
      const version = await tx.invoiceVersion.findFirst({ where: { invoiceId: invoice.id, status: "FINALIZED" }, select: { id: true, number: true, receivable: { select: { id: true, status: true } } } });
      if (!version?.receivable || version.receivable.status !== "OPEN") throw new InvoiceError("This invoice has no finalized version to record a payment against.", "NOT_FINALIZED");
      const recordedByName = await actorDisplayName(tx, input.actorUserId);
      const payment = await tx.invoicePayment.create({
        data: {
          eventId: input.eventId,
          invoiceId: invoice.id,
          invoiceVersionId: version.id,
          receivableId: version.receivable.id,
          kind: "PAYMENT",
          amountCents,
          checkNumber: parsed.data.checkNumber,
          receivedOn,
          note: parsed.data.note,
          requestKey: parsed.data.requestKey,
          recordedByUserId: input.actorUserId,
          recordedByName,
        },
        select: { id: true },
      });
      const balance = await balanceOf(tx, invoice.id);
      await writeAuditLog({
        eventId: input.eventId,
        actorUserId: input.actorUserId,
        action: "INVOICE_PAYMENT_RECORDED",
        entityType: "InvoicePayment",
        entityId: payment.id,
        summary: `Recorded a payment on invoice ${version.number}.`,
        metadata: { eventId: input.eventId, invoiceId: invoice.id, versionId: version.id, paymentId: payment.id, amountCents, outstandingCents: balance.outstandingCents, overpaidCents: balance.overpaidCents },
      }, tx);
      return { paymentId: payment.id, replayed: false, ...balance };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const again = await replay(prisma);
      if (again) return { paymentId: again, replayed: true, ...(await balanceOf(prisma, parsed.data.invoiceId)) };
    }
    if (isDatabaseRefusal(error)) throw new InvoiceError("This invoice changed while you were recording the payment. Reload and try again.", "CONCURRENT_CHANGE");
    throw error;
  }
}

/** Voids a payment with a reversal entry (the original stays on record) and a reason. A payment is voided once. */
export async function voidInvoicePayment(input: { eventId: string; paymentId: string; reason: string; requestKey: string; actorUserId: string }) {
  const parsed = voidPaymentSchema.safeParse({ paymentId: input.paymentId, reason: input.reason, requestKey: input.requestKey });
  if (!parsed.success) throw new InvoiceError(parsed.error.issues[0]?.message ?? "Check the details.", "INVALID_INPUT");
  const prisma = getPrisma();
  try {
    return await prisma.$transaction(async (tx) => {
      const payment = await tx.invoicePayment.findFirst({
        where: { id: parsed.data.paymentId, eventId: input.eventId, kind: "PAYMENT" },
        select: { id: true, invoiceId: true, invoiceVersionId: true, receivableId: true, amountCents: true, invoice: { select: { baseNumber: true } } },
      });
      if (!payment) throw new InvoiceError("That payment does not belong to this event.", "PAYMENT_NOT_FOUND");
      await lockInvoice(tx, payment.invoiceId);
      const byKey = await tx.invoicePayment.findUnique({ where: { requestKey: parsed.data.requestKey }, select: { id: true, reversesPaymentId: true } });
      if (byKey) {
        if (byKey.reversesPaymentId !== payment.id) throw new InvoiceError("That request key was already used for a different entry. Reload the page and try again.", "IDEMPOTENCY_KEY_REUSED");
        return { reversalId: byKey.id, replayed: true, ...(await balanceOf(tx, payment.invoiceId)) };
      }
      const already = await tx.invoicePayment.findUnique({ where: { reversesPaymentId: payment.id }, select: { id: true } });
      if (already) throw new InvoiceError("That payment was already voided.", "ALREADY_VOIDED");
      const recordedByName = await actorDisplayName(tx, input.actorUserId);
      const reversal = await tx.invoicePayment.create({
        data: {
          eventId: input.eventId,
          invoiceId: payment.invoiceId,
          invoiceVersionId: payment.invoiceVersionId,
          receivableId: payment.receivableId,
          kind: "REVERSAL",
          amountCents: payment.amountCents,
          receivedOn: new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z"),
          reversesPaymentId: payment.id,
          reason: parsed.data.reason,
          requestKey: parsed.data.requestKey,
          recordedByUserId: input.actorUserId,
          recordedByName,
        },
        select: { id: true },
      });
      const balance = await balanceOf(tx, payment.invoiceId);
      await writeAuditLog({
        eventId: input.eventId,
        actorUserId: input.actorUserId,
        action: "INVOICE_PAYMENT_VOIDED",
        entityType: "InvoicePayment",
        entityId: reversal.id,
        summary: `Voided a payment on invoice ${payment.invoice.baseNumber ?? ""}.`.trim(),
        metadata: { eventId: input.eventId, invoiceId: payment.invoiceId, versionId: payment.invoiceVersionId, paymentId: payment.id, reversalId: reversal.id, amountCents: payment.amountCents, outstandingCents: balance.outstandingCents },
      }, tx);
      return { reversalId: reversal.id, replayed: false, ...balance };
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new InvoiceError("That payment was already voided.", "ALREADY_VOIDED");
    throw error;
  }
}

/** What is owed on an invoice now: its live finalized version's total less every payment on the invoice (see the module note). */
async function balanceOf(client: Client, invoiceId: string) {
  const [version, entries] = await Promise.all([
    client.invoiceVersion.findFirst({ where: { invoiceId, status: "FINALIZED" }, select: { amountDueCents: true } }),
    client.invoicePayment.findMany({ where: { invoiceId }, select: { id: true, kind: true, amountCents: true, reversesPaymentId: true } }),
  ]);
  return outstandingFigures(version?.amountDueCents ?? 0, entries);
}

// ---------------------------------------------------------------------------------------------
// The ledger of one event: every finalized invoice with its AR mark, payments and sends
// ---------------------------------------------------------------------------------------------

export type LedgerPosting = { id: string; postedOn: string; reference: string | null; recordedByName: string; createdAt: string; correctsPostingId: string | null; reason: string | null };

export type LedgerVersion = {
  id: string;
  revision: number;
  status: "FINALIZED" | "SUPERSEDED";
  number: string;
  amountDueCents: number;
  registeredCount: number;
  billableCount: number;
  finalizedAt: string;
  supersededAt: string | null;
  /** The posting now in force (the latest correction), and how many postings the chain holds. */
  posting: LedgerPosting | null;
  postingCount: number;
  sendCount: number;
  lastSentAt: string | null;
};

export type LedgerPayment = {
  id: string;
  kind: "PAYMENT" | "REVERSAL";
  amountCents: number;
  checkNumber: string | null;
  receivedOn: string;
  note: string | null;
  reason: string | null;
  reversesPaymentId: string | null;
  /** The number of the version it was recorded against. */
  versionNumber: string;
  recordedByName: string;
  createdAt: string;
  /** A PAYMENT that a later REVERSAL voided. */
  voided: boolean;
};

export type LedgerInvoice = {
  invoiceId: string;
  partyKind: "ORGANIZATION" | "PERSON" | "UNRESOLVED";
  partyId: string | null;
  organizationName: string;
  groupTitle: string;
  baseNumber: string;
  /** The live finalized version: what is owed now. */
  live: LedgerVersion;
  /** Newest first, including the live version. */
  versions: LedgerVersion[];
  payments: LedgerPayment[];
  figures: { amountDueCents: number; paidCents: number; outstandingCents: number; overpaidCents: number };
  settlement: SettlementStatus;
};

const ledgerVersionSelect = {
  id: true,
  revision: true,
  status: true,
  number: true,
  amountDueCents: true,
  registeredCount: true,
  billableCount: true,
  finalizedAt: true,
  supersededAt: true,
  groupTitle: true,
  organizationName: true,
  arPostings: { orderBy: { createdAt: "asc" }, select: { id: true, postedOn: true, reference: true, recordedByName: true, createdAt: true, correctsPostingId: true, reason: true } },
  deliveries: { select: { createdAt: true } },
} satisfies Prisma.InvoiceVersionSelect;

type LedgerVersionRow = Prisma.InvoiceVersionGetPayload<{ select: typeof ledgerVersionSelect }>;

function toLedgerVersion(row: LedgerVersionRow): LedgerVersion | null {
  if (!row.number || !row.finalizedAt || (row.status !== "FINALIZED" && row.status !== "SUPERSEDED")) return null;
  const corrected = new Set(row.arPostings.flatMap((posting) => (posting.correctsPostingId ? [posting.correctsPostingId] : [])));
  const tip = row.arPostings.find((posting) => !corrected.has(posting.id)) ?? null;
  const sentAt = row.deliveries.map((delivery) => delivery.createdAt.getTime());
  return {
    id: row.id,
    revision: row.revision,
    status: row.status,
    number: row.number,
    amountDueCents: row.amountDueCents,
    registeredCount: row.registeredCount,
    billableCount: row.billableCount,
    finalizedAt: row.finalizedAt.toISOString(),
    supersededAt: row.supersededAt?.toISOString() ?? null,
    posting: tip
      ? { id: tip.id, postedOn: formatDateOnly(tip.postedOn), reference: tip.reference, recordedByName: tip.recordedByName, createdAt: tip.createdAt.toISOString(), correctsPostingId: tip.correctsPostingId, reason: tip.reason }
      : null,
    postingCount: row.arPostings.length,
    sendCount: sentAt.length,
    lastSentAt: sentAt.length > 0 ? new Date(Math.max(...sentAt)).toISOString() : null,
  };
}

/**
 * Every invoice of the event that has a finalized version, with that version's AR mark and sends, the payments
 * on the invoice and what is outstanding. Event-scoped: only this event's invoices, whoever the church is. Pass
 * `partyId` for one church's (or billing person's) statement.
 */
export async function loadEventLedger(eventId: string, options: { partyId?: string | null; invoiceId?: string | null } = {}, client: Client = getPrisma()): Promise<LedgerInvoice[]> {
  const invoices = await client.invoice.findMany({
    where: { eventId, baseNumber: { not: null }, ...(options.partyId ? { partyId: options.partyId } : {}), ...(options.invoiceId ? { id: options.invoiceId } : {}) },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      partyKind: true,
      partyId: true,
      baseNumber: true,
      versions: { where: { status: { in: ["FINALIZED", "SUPERSEDED"] } }, orderBy: { revision: "desc" }, select: ledgerVersionSelect },
      payments: { orderBy: { createdAt: "asc" }, select: { id: true, kind: true, amountCents: true, checkNumber: true, receivedOn: true, note: true, reason: true, reversesPaymentId: true, recordedByName: true, createdAt: true, invoiceVersion: { select: { number: true } } } },
    },
  });
  const result: LedgerInvoice[] = [];
  for (const invoice of invoices) {
    const versions = invoice.versions.flatMap((row) => {
      const version = toLedgerVersion(row);
      return version ? [version] : [];
    });
    const live = versions.find((version) => version.status === "FINALIZED");
    if (!live || !invoice.baseNumber) continue;
    const liveRow = invoice.versions.find((row) => row.id === live.id)!;
    const voided = voidedPaymentIds(invoice.payments);
    const figures = outstandingFigures(live.amountDueCents, invoice.payments);
    result.push({
      invoiceId: invoice.id,
      partyKind: invoice.partyKind,
      partyId: invoice.partyId,
      organizationName: liveRow.organizationName,
      groupTitle: liveRow.groupTitle,
      baseNumber: invoice.baseNumber,
      live,
      versions,
      payments: invoice.payments.map((payment) => ({
        id: payment.id,
        kind: payment.kind,
        amountCents: payment.amountCents,
        checkNumber: payment.checkNumber,
        receivedOn: formatDateOnly(payment.receivedOn),
        note: payment.note,
        reason: payment.reason,
        reversesPaymentId: payment.reversesPaymentId,
        versionNumber: payment.invoiceVersion.number ?? "",
        recordedByName: payment.recordedByName,
        createdAt: payment.createdAt.toISOString(),
        voided: payment.kind === "PAYMENT" && voided.has(payment.id),
      })),
      figures,
      settlement: settlementStatus(figures),
    });
  }
  return result.sort((left, right) => left.organizationName.localeCompare(right.organizationName) || left.live.number.localeCompare(right.live.number));
}

export type StatementTotals = { invoiceCount: number; invoicedCents: number; paidCents: number; outstandingCents: number; overpaidCents: number };

function totalsOf(invoices: readonly LedgerInvoice[]): StatementTotals {
  return invoices.reduce<StatementTotals>(
    (sum, invoice) => ({
      invoiceCount: sum.invoiceCount + 1,
      invoicedCents: sum.invoicedCents + invoice.figures.amountDueCents,
      paidCents: sum.paidCents + invoice.figures.paidCents,
      outstandingCents: sum.outstandingCents + invoice.figures.outstandingCents,
      overpaidCents: sum.overpaidCents + invoice.figures.overpaidCents,
    }),
    { invoiceCount: 0, invoicedCents: 0, paidCents: 0, outstandingCents: 0, overpaidCents: 0 },
  );
}

export type StatementParty = { partyKind: "ORGANIZATION" | "PERSON" | "UNRESOLVED"; partyId: string; name: string; totals: StatementTotals; lastSentAt: string | null };

/** One row per church (or billing person) with a finalized invoice on this event. Only this event's invoices. */
export async function listEventStatements(eventId: string): Promise<{ eventName: string; parties: StatementParty[]; totals: StatementTotals }> {
  const prisma = getPrisma();
  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { name: true } });
  if (!event) throw new InvoiceError("That event does not exist.", "EVENT_NOT_FOUND");
  const ledger = await loadEventLedger(eventId);
  const byParty = new Map<string, LedgerInvoice[]>();
  for (const invoice of ledger) {
    if (!invoice.partyId) continue;
    byParty.set(invoice.partyId, [...(byParty.get(invoice.partyId) ?? []), invoice]);
  }
  const parties = [...byParty.entries()].map(([partyId, invoices]) => ({
    partyKind: invoices[0]!.partyKind,
    partyId,
    name: invoices[0]!.organizationName,
    totals: totalsOf(invoices),
    lastSentAt: invoices.flatMap((invoice) => (invoice.live.lastSentAt ? [invoice.live.lastSentAt] : [])).sort().at(-1) ?? null,
  }));
  return { eventName: event.name, parties: parties.sort((left, right) => left.name.localeCompare(right.name)), totals: totalsOf(ledger) };
}

export type PartyStatement = { eventId: string; eventName: string; partyId: string; partyKind: "ORGANIZATION" | "PERSON" | "UNRESOLVED"; name: string; invoices: LedgerInvoice[]; totals: StatementTotals };

/**
 * One church's statement for one event: its finalized invoices (the live version of each, superseded versions as
 * history), AR status, payments (voided ones shown struck through) and what is outstanding. Null when the party
 * has no finalized invoice on this event, so the page answers 404 and never reveals another event's invoices.
 */
export async function getPartyStatement(eventId: string, partyId: string): Promise<PartyStatement | null> {
  const prisma = getPrisma();
  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { name: true } });
  if (!event) return null;
  const invoices = await loadEventLedger(eventId, { partyId });
  if (invoices.length === 0) return null;
  return { eventId, eventName: event.name, partyId, partyKind: invoices[0]!.partyKind, name: invoices[0]!.organizationName, invoices, totals: totalsOf(invoices) };
}

export type FinanceReport = {
  eventName: string;
  /** The finance setting printed on invoice PDFs; null uses the built-in default. */
  paymentInstructions: string | null;
  /** Submitted headcount and billable units of the finalized invoices (registered and billed people). */
  headcount: { submitted: number; billable: number };
  invoiced: { invoiceCount: number; amountCents: number; postedToArCount: number; postedToArCents: number; sentCount: number; notSentCount: number };
  paidCents: number;
  outstandingCents: number;
  overpaidCents: number;
  invoicesWithOutstanding: number;
  /** Separate from the above: money attendees paid for this event (registrations, not invoices), net of refunds. */
  attendeePayments: { netCents: number };
  draftCount: number;
};

/** The event's finance report section: deferred receivables shown apart from attendee payments. */
export async function getInvoiceFinanceReport(eventId: string): Promise<FinanceReport> {
  const prisma = getPrisma();
  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { name: true, invoicePaymentInstructions: true } });
  if (!event) throw new InvoiceError("That event does not exist.", "EVENT_NOT_FOUND");
  const [ledger, drafts, attendee, refunded] = await Promise.all([
    loadEventLedger(eventId),
    prisma.invoiceVersion.count({ where: { eventId, status: "DRAFT" } }),
    prisma.payment.aggregate({ where: { eventId, status: "SUCCEEDED" }, _sum: { amount: true } }),
    prisma.refund.aggregate({ where: { eventId, status: "SUCCEEDED" }, _sum: { amount: true } }),
  ]);
  const totals = totalsOf(ledger);
  const posted = ledger.filter((invoice) => invoice.live.posting !== null);
  const sent = ledger.filter((invoice) => invoice.live.sendCount > 0);
  return {
    eventName: event.name,
    paymentInstructions: event.invoicePaymentInstructions,
    headcount: { submitted: ledger.reduce((sum, invoice) => sum + invoice.live.registeredCount, 0), billable: ledger.reduce((sum, invoice) => sum + invoice.live.billableCount, 0) },
    invoiced: {
      invoiceCount: totals.invoiceCount,
      amountCents: totals.invoicedCents,
      postedToArCount: posted.length,
      postedToArCents: posted.reduce((sum, invoice) => sum + invoice.live.amountDueCents, 0),
      sentCount: sent.length,
      notSentCount: ledger.length - sent.length,
    },
    paidCents: totals.paidCents,
    outstandingCents: totals.outstandingCents,
    overpaidCents: totals.overpaidCents,
    invoicesWithOutstanding: ledger.filter((invoice) => invoice.figures.outstandingCents > 0).length,
    attendeePayments: { netCents: Math.round(Number(attendee._sum.amount ?? 0) * 100) - Math.round(Number(refunded._sum.amount ?? 0) * 100) },
    draftCount: drafts,
  };
}

/** The treasurer's rows: the live finalized version of each invoice of the event (superseded versions are history, not shown). */
export async function getTreasurerCsvInvoices(eventId: string): Promise<TreasurerCsvInvoice[]> {
  const prisma = getPrisma();
  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { name: true } });
  if (!event) throw new InvoiceError("That event does not exist.", "EVENT_NOT_FOUND");
  const ledger = await loadEventLedger(eventId);
  return ledger.map((invoice) => {
    const prior = invoice.versions.find((version) => version.revision === invoice.live.revision - 1);
    return {
      number: invoice.live.number,
      supersedesNumber: prior?.number ?? null,
      organizationName: invoice.organizationName,
      eventName: event.name,
      totalCents: invoice.live.amountDueCents,
      postedToArOn: invoice.live.posting?.postedOn ?? null,
      arReference: invoice.live.posting?.reference ?? null,
      paidCents: invoice.figures.paidCents,
      outstandingCents: invoice.figures.outstandingCents,
      overpaidCents: invoice.figures.overpaidCents,
      lastSentAt: invoice.live.lastSentAt,
    };
  });
}
