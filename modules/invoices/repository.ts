import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import {
  LONG_TRANSACTION,
  loadReconciliationFacts,
  lockEvent as lockReconciliationEvent,
} from "@/modules/attendance-reconciliation/repository";
import { versionFreshness, type GroupResult, type ReconciliationResult, type ResponsibilityBlocker } from "@/modules/attendance-reconciliation/domain";
import { getBillingResponsibilityView } from "@/modules/billing-responsibility/repository";
import type { BillingGroup } from "@/modules/billing-responsibility/domain";
import {
  buildInvoiceFigures,
  contactsMatch,
  deriveInvoiceCode,
  eventInvoiceYear,
  finalizationNeedsPermission,
  formatBaseNumber,
  formatVersionNumber,
  normalizeInvoiceCode,
  revisionChangeSummary,
  type InvoiceContact,
  type InvoiceFigures,
  type InvoiceSnapshot,
  type InvoiceVersionBasis,
  amountsFingerprintOf,
  type InvoiceVersionStatus,
} from "@/modules/invoices/domain";
import {
  MANUAL_LINES_MAX,
  fingerprintWithManualLines,
  manualLinesTotal,
  normalizeManualLine,
  parseManualLines,
  withManualLines,
  type ManualInvoiceLine,
  type ManualLineInput,
} from "@/modules/invoices/manual-lines";

/**
 * Deferred-organization invoices (#167, ADR 0008). Every function takes the event the caller was
 * authorized for (the route or page checks MANAGE_FINANCE; finalizing also needs the Finalize
 * invoices permission, which the route passes in as `canFinalizeInvoices` and this module enforces
 * again whenever a version changes a billable amount) and refuses an invoice or version that does
 * not belong to that event. Audit entries carry ids and numbers only, never a contact's name or
 * email. Nothing here sends an invoice (#168).
 *
 * One lock per event (the same advisory lock the attendance reconciliation takes) serializes every
 * write below with preparing and approving a reconciliation, so a finalization always sees the
 * approval it is built on. The database enforces the rest: one draft and one finalized version per
 * invoice, one number per invoice from a counter that only counts up, immutable finalized versions.
 */

export type InvoiceErrorCode =
  | "EVENT_NOT_FOUND"
  | "NOT_DEFERRED_EVENT"
  | "INVOICE_NOT_FOUND"
  | "VERSION_NOT_FOUND"
  | "NO_APPROVED_RECONCILIATION"
  | "FACTS_CHANGED"
  | "RESPONSIBILITY_NOT_READY"
  | "GROUPING_CONFLICT"
  | "NOT_A_DRAFT"
  | "NOT_FINALIZED"
  | "DRAFT_EXISTS"
  | "DRAFT_STALE"
  | "CONTACT_MISSING"
  | "CONTACT_STALE"
  | "NO_CHANGE"
  | "CONFIRMATION_REQUIRED"
  | "FINALIZE_PERMISSION_REQUIRED"
  | "IDEMPOTENCY_KEY_REUSED"
  | "CODE_INVALID"
  | "CODE_LOCKED"
  | "CODE_IN_USE"
  | "CONCURRENT_CHANGE"
  // Delivery, AR and payments (#168)
  | "NOT_SENDABLE"
  | "NO_RECIPIENTS"
  | "UNKNOWN_RECIPIENT"
  | "PREVIEW_CHANGED"
  | "DOCUMENT_CORRUPT"
  | "EXTERNAL_EMAIL_NOT_CONFIGURED"
  | "ALREADY_POSTED"
  | "NOT_POSTED"
  | "PAYMENT_NOT_FOUND"
  | "ALREADY_VOIDED"
  | "INVALID_INPUT"
  | "PARTY_NOT_FOUND";

export class InvoiceError extends Error {
  constructor(
    message: string,
    public readonly code: InvoiceErrorCode,
    public readonly blockers: ResponsibilityBlocker[] = [],
  ) {
    super(message);
    this.name = "InvoiceError";
  }
}

type Client = Prisma.TransactionClient | PrismaClient;

const concurrent = () => new InvoiceError("Someone else just changed this. Reload and try again.", "CONCURRENT_CHANGE");

function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/** The database's own refusals (a trigger or constraint) carry SQLSTATE 23001 or 23514. */
function isDatabaseRefusal(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return message.includes("23001") || /invoice code is locked/i.test(message);
}

// ---------------------------------------------------------------------------------------------
// Facts: the approved reconciliation, the live facts, and the current billing contacts
// ---------------------------------------------------------------------------------------------

async function requireDeferredEvent(client: Client, eventId: string) {
  const event = await client.event.findUnique({
    where: { id: eventId },
    select: { id: true, name: true, startsAt: true, timezone: true, billingMode: true, invoiceGrouping: true, invoiceCode: true, invoiceClubType: true },
  });
  if (!event) throw new InvoiceError("That event does not exist.", "EVENT_NOT_FOUND");
  if (event.billingMode !== "DEFERRED_ORGANIZATION_INVOICE") {
    throw new InvoiceError("This event is not billed to organizations after the event.", "NOT_DEFERRED_EVENT");
  }
  return event;
}

export function contactOfGroup(group: BillingGroup | undefined | null): InvoiceContact | null {
  if (!group) return null;
  if (group.party.kind === "ORGANIZATION") {
    return group.contact ? { name: group.contact.name, email: group.contact.email, roleLabel: group.contact.roleLabel, verified: group.contact.verifiedAt !== null } : null;
  }
  if (group.party.kind === "PERSON") {
    return group.party.email ? { name: group.party.name, email: group.party.email, roleLabel: "Billing person", verified: true } : null;
  }
  return null;
}

const approvedSelect = {
  id: true,
  versionNumber: true,
  status: true,
  fingerprint: true,
  ruleVersion: true,
  invoiceGrouping: true,
  billableCents: true,
  approvedAt: true,
  snapshot: true,
} satisfies Prisma.AttendanceReconciliationVersionSelect;

/**
 * What a draft or an amount-changing finalization stands on: the event's APPROVED reconciliation, which must still match
 * the facts now, with billing responsibility complete. Refuses otherwise, so an invoice never comes from a stale or
 * missing approval (ADR 0008 section 2; #166 requires refusing FACTS_CHANGED).
 */
async function loadApprovedBasis(client: Client, eventId: string) {
  const event = await requireDeferredEvent(client, eventId);
  const facts = await loadReconciliationFacts(client, eventId);
  const approved = await client.attendanceReconciliationVersion.findFirst({ where: { eventId, status: "APPROVED" }, select: approvedSelect });
  if (!approved) {
    throw new InvoiceError("No attendance reconciliation has been approved yet. Approve one first; an invoice is built from it.", "NO_APPROVED_RECONCILIATION");
  }
  if (versionFreshness(approved, facts.fingerprint) === "FACTS_CHANGED") {
    throw new InvoiceError("Attendance or billing facts changed since the reconciliation was approved. Prepare and approve it again before invoicing.", "FACTS_CHANGED");
  }
  if (facts.blockers.length > 0) {
    const first = facts.blockers[0]!;
    throw new InvoiceError(
      `Finish billing responsibility first: ${facts.blockers.length} ${facts.blockers.length === 1 ? "registration needs" : "registrations need"} attention (${first.confirmationCode}).`,
      "RESPONSIBILITY_NOT_READY",
      facts.blockers,
    );
  }
  const billing = await getBillingResponsibilityView(eventId, {}, client);
  return { event, approved, result: approved.snapshot as unknown as ReconciliationResult, billing };
}

type ApprovedBasis = Awaited<ReturnType<typeof loadApprovedBasis>>;

function figuresFor(basis: ApprovedBasis, group: GroupResult, contactGroup: BillingGroup | undefined): { figures: InvoiceFigures; contact: InvoiceContact | null } {
  if (group.partyKind === "UNRESOLVED") throw new InvoiceError("A registration without a responsible organization cannot be invoiced.", "RESPONSIBILITY_NOT_READY");
  const figures = buildInvoiceFigures({
    event: { id: basis.event.id, name: basis.event.name },
    groupKey: group.key,
    groupTitle: group.title,
    invoiceGrouping: basis.approved.invoiceGrouping,
    party: { kind: group.partyKind, id: group.partyId, name: group.partyName },
    clubId: group.clubId,
    reconciliation: { versionId: basis.approved.id, versionNumber: basis.approved.versionNumber, ruleVersion: basis.approved.ruleVersion },
    group,
  });
  return { figures, contact: contactOfGroup(contactGroup) };
}

/** The figures for an invoice's group when the approved reconciliation no longer has it: no lines, $0. */
function emptyFigures(basis: ApprovedBasis, invoice: { groupKey: string; partyKind: "ORGANIZATION" | "PERSON" | "UNRESOLVED"; partyId: string | null; clubId: string | null }, title: string, name: string) {
  return buildInvoiceFigures({
    event: { id: basis.event.id, name: basis.event.name },
    groupKey: invoice.groupKey,
    groupTitle: title,
    invoiceGrouping: basis.approved.invoiceGrouping,
    party: { kind: invoice.partyKind === "PERSON" ? "PERSON" : "ORGANIZATION", id: invoice.partyId, name },
    clubId: invoice.clubId,
    reconciliation: { versionId: basis.approved.id, versionNumber: basis.approved.versionNumber, ruleVersion: basis.approved.ruleVersion },
    group: null,
  });
}

// ---------------------------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------------------------

const versionSelect = {
  id: true,
  invoiceId: true,
  revision: true,
  status: true,
  basis: true,
  supersedesVersionId: true,
  reconciliationVersionId: true,
  number: true,
  groupTitle: true,
  organizationName: true,
  contactName: true,
  contactEmail: true,
  contactRoleLabel: true,
  contactVerified: true,
  registeredCount: true,
  billableCount: true,
  amountDueCents: true,
  amountsFingerprint: true,
  manualLines: true,
  revisionReason: true,
  createdAt: true,
  regenerationCount: true,
  regeneratedAt: true,
  finalizedAt: true,
  finalizedByName: true,
  finalizeIdempotencyKey: true,
  supersededAt: true,
  supersededByVersionId: true,
  createdBy: { select: { displayName: true } },
  reconciliationVersion: { select: { versionNumber: true, status: true } },
  receivable: { select: { id: true, amountCents: true, status: true } },
} satisfies Prisma.InvoiceVersionSelect;

type VersionRow = Prisma.InvoiceVersionGetPayload<{ select: typeof versionSelect }>;

export type InvoiceVersionSummary = {
  id: string;
  invoiceId: string;
  revision: number;
  status: InvoiceVersionStatus;
  basis: InvoiceVersionBasis;
  supersedesVersionId: string | null;
  reconciliationVersionId: string;
  reconciliationVersionNumber: number;
  number: string | null;
  groupTitle: string;
  organizationName: string;
  contact: (InvoiceContact) | null;
  registeredCount: number;
  billableCount: number;
  amountDueCents: number;
  amountsFingerprint: string;
  /** Staff-added custom lines (#780); included in `amountDueCents`. */
  manualLines: ManualInvoiceLine[];
  revisionReason: string | null;
  createdAt: string;
  createdByName: string | null;
  regenerationCount: number;
  finalizedAt: string | null;
  finalizedByName: string | null;
  supersededAt: string | null;
  supersededByVersionId: string | null;
  receivable: { amountCents: number; status: "OPEN" | "SUPERSEDED" } | null;
};

function toSummary(row: VersionRow): InvoiceVersionSummary {
  return {
    id: row.id,
    invoiceId: row.invoiceId,
    revision: row.revision,
    status: row.status,
    basis: row.basis,
    supersedesVersionId: row.supersedesVersionId,
    reconciliationVersionId: row.reconciliationVersionId,
    reconciliationVersionNumber: row.reconciliationVersion.versionNumber,
    number: row.number,
    groupTitle: row.groupTitle,
    organizationName: row.organizationName,
    contact: row.contactName && row.contactEmail ? { name: row.contactName, email: row.contactEmail, roleLabel: row.contactRoleLabel ?? "", verified: row.contactVerified } : null,
    registeredCount: row.registeredCount,
    billableCount: row.billableCount,
    amountDueCents: row.amountDueCents,
    amountsFingerprint: row.amountsFingerprint,
    manualLines: parseManualLines(row.manualLines),
    revisionReason: row.revisionReason,
    createdAt: row.createdAt.toISOString(),
    createdByName: row.createdBy?.displayName ?? null,
    regenerationCount: row.regenerationCount,
    finalizedAt: row.finalizedAt?.toISOString() ?? null,
    finalizedByName: row.finalizedByName,
    supersededAt: row.supersededAt?.toISOString() ?? null,
    supersededByVersionId: row.supersededByVersionId,
    receivable: row.receivable ? { amountCents: row.receivable.amountCents, status: row.receivable.status } : null,
  };
}

/** The columns of a version made from the figures; the draft's manual lines (#780) are folded into the total and the fingerprint. */
function figureColumns(baseFigures: InvoiceFigures, contact: InvoiceContact | null, manualLines: readonly ManualInvoiceLine[] = []) {
  const figures = withManualLines(baseFigures, manualLines);
  return {
    groupTitle: figures.groupTitle,
    organizationName: figures.organizationName,
    contactName: contact?.name ?? null,
    contactEmail: contact?.email ?? null,
    contactRoleLabel: contact?.roleLabel ?? null,
    contactVerified: contact?.verified ?? false,
    registeredCount: figures.registeredCount,
    billableCount: figures.billableCount,
    amountDueCents: figures.amountDueCents,
    amountsFingerprint: figures.amountsFingerprint,
    snapshot: figures.snapshot as unknown as Prisma.InputJsonValue,
  };
}

// ---------------------------------------------------------------------------------------------
// Event invoice code
// ---------------------------------------------------------------------------------------------

/** The code the next number will carry: the event's explicit code, or the one derived from its name. */
export function effectiveInvoiceCode(event: { name: string; invoiceCode: string | null }) {
  return event.invoiceCode ?? deriveInvoiceCode(event.name);
}

/**
 * Staff set (or clear) the event's invoice code, letters only, before the first invoice is finalized. It is locked
 * once the event has a number series (a trigger refuses a change too). Audited with before and after.
 */
export async function setEventInvoiceCode(input: { eventId: string; code: string | null; actorUserId: string }) {
  const prisma = getPrisma();
  const code = input.code === null || input.code.trim() === "" ? null : normalizeInvoiceCode(input.code);
  if (input.code !== null && input.code.trim() !== "" && code === null) {
    throw new InvoiceError("Use two to six letters for the invoice code, such as SC.", "CODE_INVALID");
  }
  try {
    return await prisma.$transaction(async (tx) => {
      // Lock first, then read: a finalization that just ran may have frozen the code.
      await lockReconciliationEvent(tx, input.eventId);
      const event = await requireDeferredEvent(tx, input.eventId);
      if ((await tx.invoiceNumberCounter.count({ where: { eventId: input.eventId } })) > 0) {
        throw new InvoiceError("Invoice numbers were already issued for this event, so its code can no longer change.", "CODE_LOCKED");
      }
      if (event.invoiceCode === code) return { changed: false as const, code };
      if (code) {
        const year = eventInvoiceYear(event.startsAt, event.timezone);
        const taken = await tx.invoiceNumberCounter.findUnique({ where: { code_year: { code, year } }, select: { eventId: true } });
        if (taken && taken.eventId !== input.eventId) {
          throw new InvoiceError(`Another event already issues invoice numbers starting ${code}${String(year % 100).padStart(2, "0")}. Choose a different code.`, "CODE_IN_USE");
        }
      }
      await tx.event.update({ where: { id: input.eventId }, data: { invoiceCode: code } });
      await writeAuditLog({
        eventId: input.eventId,
        actorUserId: input.actorUserId,
        action: "INVOICE_CODE_SET",
        entityType: "Event",
        entityId: input.eventId,
        summary: code ? "Set the invoice number code for this event." : "Cleared the invoice number code for this event.",
        metadata: { eventId: input.eventId, before: event.invoiceCode, after: code },
      }, tx);
      return { changed: true as const, code };
    }, LONG_TRANSACTION);
  } catch (error) {
    if (isDatabaseRefusal(error)) throw new InvoiceError("Invoice numbers were already issued for this event, so its code can no longer change.", "CODE_LOCKED");
    throw error;
  }
}

export const CLUB_TYPE_MAX = 40;

/** The heading the invoice PDF groups registration lines under (for example "Pathfinders"). Blank prints "Registrations". A PDF already made keeps its heading. */
export async function setEventInvoiceClubType(input: { eventId: string; clubType: string | null; actorUserId: string }) {
  const clubType = (input.clubType ?? "").replace(/\s+/g, " ").trim();
  if (clubType.length > CLUB_TYPE_MAX) throw new InvoiceError(`Keep the club type to ${CLUB_TYPE_MAX} characters or fewer.`, "INVALID_INPUT");
  const value = clubType === "" ? null : clubType;
  const prisma = getPrisma();
  return prisma.$transaction(async (tx) => {
    const event = await requireDeferredEvent(tx, input.eventId);
    if ((event.invoiceClubType ?? null) === value) return { changed: false as const, clubType: value };
    await tx.event.update({ where: { id: input.eventId }, data: { invoiceClubType: value } });
    await writeAuditLog({
      eventId: input.eventId,
      actorUserId: input.actorUserId,
      action: "INVOICE_CLUB_TYPE_SET",
      entityType: "Event",
      entityId: input.eventId,
      summary: value ? "Set the club type printed on invoice PDFs." : "Cleared the club type printed on invoice PDFs.",
      metadata: { eventId: input.eventId, before: event.invoiceClubType, after: value },
    }, tx);
    return { changed: true as const, clubType: value };
  });
}

// ---------------------------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------------------------

const invoiceWithVersionsSelect = {
  id: true,
  groupKey: true,
  invoiceGrouping: true,
  partyKind: true,
  partyId: true,
  clubId: true,
  baseNumber: true,
  versions: {
    where: { status: { not: "DISCARDED" } },
    orderBy: { revision: "desc" },
    select: { id: true, revision: true, status: true, basis: true, reconciliationVersionId: true, amountsFingerprint: true, manualLines: true, contactName: true, contactEmail: true, supersedesVersionId: true },
  },
} satisfies Prisma.InvoiceSelect;

export type DraftRunResult = {
  /** Groups that got their first draft. */
  created: number;
  /** Drafts replaced because the approved reconciliation, the amounts or the contact changed. */
  regenerated: number;
  /** Drafts already matching the approved reconciliation and the contact. */
  unchanged: number;
  /** Groups whose invoice is already finalized: nothing was touched. */
  finalized: number;
  /** Of those, how many no longer match the approved reconciliation and need a revision. */
  needRevision: number;
  reconciliationVersionNumber: number;
};

/**
 * "Create invoice drafts": one draft per invoice group of the event's approved, current reconciliation. Refused with no
 * approved version, with an approval whose facts changed, or while billing responsibility is not ready. Regenerating
 * replaces a draft only; a group whose invoice is finalized is never touched (revise it instead). Safe to repeat.
 */
export async function createInvoiceDrafts(input: { eventId: string; actorUserId: string }): Promise<DraftRunResult> {
  const prisma = getPrisma();
  try {
    return await prisma.$transaction(async (tx) => {
      await lockReconciliationEvent(tx, input.eventId);
      await requireDeferredEvent(tx, input.eventId);
      const basis = await loadApprovedBasis(tx, input.eventId);
      const existing = await tx.invoice.findMany({ where: { eventId: input.eventId }, select: invoiceWithVersionsSelect });
      if (existing.some((invoice) => invoice.baseNumber !== null && invoice.invoiceGrouping !== basis.approved.invoiceGrouping)) {
        throw new InvoiceError("Some invoices were finalized under a different invoice grouping. Change the grouping back before creating drafts, or revise those invoices.", "GROUPING_CONFLICT");
      }
      const byKey = new Map(existing.map((invoice) => [invoice.groupKey, invoice]));
      const run: DraftRunResult = { created: 0, regenerated: 0, unchanged: 0, finalized: 0, needRevision: 0, reconciliationVersionNumber: basis.approved.versionNumber };
      for (const group of basis.result.groups) {
        const { figures, contact } = figuresFor(basis, group, basis.billing.groups.find((candidate) => candidate.key === group.key));
        const invoice = byKey.get(group.key);
        if (!invoice) {
          const created = await tx.invoice.create({
            data: { eventId: input.eventId, groupKey: group.key, invoiceGrouping: basis.approved.invoiceGrouping, partyKind: group.partyKind, partyId: group.partyId, clubId: group.clubId },
            select: { id: true },
          });
          await tx.invoiceVersion.create({
            data: {
              invoiceId: created.id,
              eventId: input.eventId,
              revision: 0,
              basis: "RECONCILIATION",
              reconciliationVersionId: basis.approved.id,
              createdByUserId: input.actorUserId,
              ...figureColumns(figures, contact),
            },
          });
          run.created += 1;
          continue;
        }
        // An invoice with no number yet follows the event's current grouping (a numbered one was checked above).
        const regrouped = invoice.baseNumber === null && invoice.invoiceGrouping !== basis.approved.invoiceGrouping;
        if (regrouped) await tx.invoice.update({ where: { id: invoice.id }, data: { invoiceGrouping: basis.approved.invoiceGrouping } });
        const latest = invoice.versions[0];
        if (!latest) {
          // Every earlier draft was discarded: start a fresh one.
          await tx.invoiceVersion.create({
            data: { invoiceId: invoice.id, eventId: input.eventId, revision: 0, basis: "RECONCILIATION", reconciliationVersionId: basis.approved.id, createdByUserId: input.actorUserId, ...figureColumns(figures, contact) },
          });
          run.created += 1;
          continue;
        }
        if (latest.status === "DRAFT") {
          if (latest.basis !== "RECONCILIATION") {
            // A contact-only copy is refreshed from its own button, never silently turned into a rebuild.
            run.unchanged += 1;
            continue;
          }
          const manualLines = parseManualLines(latest.manualLines);
          const same = !regrouped && latest.reconciliationVersionId === basis.approved.id && latest.amountsFingerprint === fingerprintWithManualLines(figures.amountsFingerprint, manualLines) && contactsMatch(latest, contact);
          if (same) {
            run.unchanged += 1;
            continue;
          }
          await tx.invoiceVersion.update({
            where: { id: latest.id },
            data: { reconciliationVersionId: basis.approved.id, regenerationCount: { increment: 1 }, regeneratedAt: new Date(), ...figureColumns(figures, contact, manualLines) },
          });
          run.regenerated += 1;
          continue;
        }
        run.finalized += 1;
        if (latest.amountsFingerprint !== fingerprintWithManualLines(figures.amountsFingerprint, parseManualLines(latest.manualLines))) run.needRevision += 1;
      }
      await writeAuditLog({
        eventId: input.eventId,
        actorUserId: input.actorUserId,
        action: "INVOICE_DRAFTS_CREATED",
        entityType: "Event",
        entityId: input.eventId,
        summary: "Created invoice drafts from the approved attendance reconciliation.",
        metadata: { eventId: input.eventId, reconciliationVersionId: basis.approved.id, reconciliationVersionNumber: basis.approved.versionNumber, created: run.created, regenerated: run.regenerated, unchanged: run.unchanged, finalized: run.finalized, needRevision: run.needRevision },
      }, tx);
      return run;
    }, LONG_TRANSACTION);
  } catch (error) {
    if (isUniqueViolation(error)) throw concurrent();
    throw error;
  }
}

async function requireInvoice(client: Client, eventId: string, invoiceId: string) {
  const invoice = await client.invoice.findFirst({ where: { id: invoiceId, eventId }, select: invoiceWithVersionsSelect });
  if (!invoice) throw new InvoiceError("That invoice does not belong to this event.", "INVOICE_NOT_FOUND");
  return invoice;
}

/**
 * Regenerates one invoice's open draft: a draft built from the reconciliation is rebuilt from the approved, current
 * one; a contact-only draft is copied again from the finalized version with the contact as it is now.
 */
export async function regenerateInvoiceDraft(input: { eventId: string; invoiceId: string; actorUserId: string }) {
  const prisma = getPrisma();
  try {
    return await prisma.$transaction(async (tx) => {
      await lockReconciliationEvent(tx, input.eventId);
      await requireDeferredEvent(tx, input.eventId);
      const invoice = await requireInvoice(tx, input.eventId, input.invoiceId);
      const draft = invoice.versions[0];
      if (!draft || draft.status !== "DRAFT") throw new InvoiceError("This invoice has no open draft to regenerate. Revise it to start a new version.", "NOT_A_DRAFT");
      // An un-numbered invoice follows the event's current grouping.
      const approvedGrouping = (await tx.attendanceReconciliationVersion.findFirst({ where: { eventId: input.eventId, status: "APPROVED" }, select: { invoiceGrouping: true } }))?.invoiceGrouping;
      if (invoice.baseNumber === null && approvedGrouping && invoice.invoiceGrouping !== approvedGrouping) {
        await tx.invoice.update({ where: { id: invoice.id }, data: { invoiceGrouping: approvedGrouping } });
      }
      if (draft.basis === "CONTACT_ONLY_COPY") {
        const prior = await tx.invoiceVersion.findFirst({ where: { id: draft.supersedesVersionId ?? "", invoiceId: invoice.id, status: "FINALIZED" }, select: { snapshot: true, groupTitle: true, organizationName: true, registeredCount: true, billableCount: true, amountDueCents: true, amountsFingerprint: true, reconciliationVersionId: true } });
        if (!prior) throw new InvoiceError("The finalized version this draft revises has changed. Reload and revise again.", "DRAFT_STALE");
        const billing = await getBillingResponsibilityView(input.eventId, {}, tx);
        const contact = contactOfGroup(billing.groups.find((candidate) => candidate.key === invoice.groupKey));
        if (!contact) throw new InvoiceError("This group has no billing contact on file. Add one under Billing responsibility first.", "CONTACT_MISSING");
        await tx.invoiceVersion.update({
          where: { id: draft.id },
          data: {
            regenerationCount: { increment: 1 },
            regeneratedAt: new Date(),
            contactName: contact.name,
            contactEmail: contact.email,
            contactRoleLabel: contact.roleLabel,
            contactVerified: contact.verified,
          },
        });
      } else {
        const basis = await loadApprovedBasis(tx, input.eventId);
        const group = basis.result.groups.find((candidate) => candidate.key === invoice.groupKey);
        const contactGroup = basis.billing.groups.find((candidate) => candidate.key === invoice.groupKey);
        let figures: InvoiceFigures;
        let contact: InvoiceContact | null;
        if (group) {
          ({ figures, contact } = figuresFor(basis, group, contactGroup));
        } else if (draft.revision > 0) {
          const title = contactGroup?.title ?? "Invoice";
          figures = emptyFigures(basis, invoice, title, contactGroup && contactGroup.party.kind !== "UNRESOLVED" ? contactGroup.party.name : title);
          contact = contactOfGroup(contactGroup);
        } else {
          throw new InvoiceError("This group is no longer part of the approved reconciliation, so this draft cannot be rebuilt.", "DRAFT_STALE");
        }
        await tx.invoiceVersion.update({
          where: { id: draft.id },
          data: { reconciliationVersionId: basis.approved.id, regenerationCount: { increment: 1 }, regeneratedAt: new Date(), ...figureColumns(figures, contact, parseManualLines(draft.manualLines)) },
        });
      }
      await writeAuditLog({
        eventId: input.eventId,
        actorUserId: input.actorUserId,
        action: "INVOICE_DRAFT_REGENERATED",
        entityType: "InvoiceVersion",
        entityId: draft.id,
        summary: "Regenerated an invoice draft.",
        metadata: { eventId: input.eventId, invoiceId: invoice.id, versionId: draft.id, revision: draft.revision, basis: draft.basis },
      }, tx);
      return { versionId: draft.id, invoiceId: invoice.id };
    }, LONG_TRANSACTION);
  } catch (error) {
    if (isUniqueViolation(error)) throw concurrent();
    throw error;
  }
}

/**
 * Throws away an open draft (an original that was never numbered, or a revision not yet finalized): it becomes
 * DISCARDED, stays on record, and disappears from the screens and the draft counts. Creating drafts afterwards
 * makes a fresh one; a discarded revision frees its revision number. A finalized version cannot be discarded.
 */
export async function discardInvoiceDraft(input: { eventId: string; invoiceId: string; actorUserId: string }) {
  const prisma = getPrisma();
  return prisma.$transaction(async (tx) => {
    await lockReconciliationEvent(tx, input.eventId);
    await requireDeferredEvent(tx, input.eventId);
    const invoice = await requireInvoice(tx, input.eventId, input.invoiceId);
    const draft = invoice.versions[0];
    if (!draft || draft.status !== "DRAFT") throw new InvoiceError("This invoice has no open draft to discard.", "NOT_A_DRAFT");
    const discarded = await tx.invoiceVersion.updateMany({ where: { id: draft.id, status: "DRAFT" }, data: { status: "DISCARDED", discardedAt: new Date() } });
    if (discarded.count === 0) throw concurrent();
    await writeAuditLog({
      eventId: input.eventId,
      actorUserId: input.actorUserId,
      action: "INVOICE_DRAFT_DISCARDED",
      entityType: "InvoiceVersion",
      entityId: draft.id,
      summary: "Discarded an invoice draft.",
      metadata: { eventId: input.eventId, invoiceId: invoice.id, versionId: draft.id, revision: draft.revision },
    }, tx);
    return { versionId: draft.id, invoiceId: invoice.id };
  }, LONG_TRANSACTION);
}

// ---------------------------------------------------------------------------------------------
// Revisions
// ---------------------------------------------------------------------------------------------

export type ReviseMode = "CONTACT_ONLY" | "FROM_RECONCILIATION";

/**
 * "Revise" a finalized invoice: starts a new DRAFT version linked to the finalized one (it supersedes it when finalized).
 *  - CONTACT_ONLY copies the finalized version's lines and amounts unchanged and refreshes only the billing contact.
 *  - FROM_RECONCILIATION rebuilds the lines from the approved, current reconciliation (an adjustment after finalization).
 * Either needs a reason. Who may finalize the draft depends on what it changes (amounts need Finalize invoices).
 */
export async function reviseInvoice(input: { eventId: string; invoiceId: string; mode: ReviseMode; reason: string; actorUserId: string }) {
  const prisma = getPrisma();
  const reason = input.reason.trim();
  try {
    return await prisma.$transaction(async (tx) => {
      await lockReconciliationEvent(tx, input.eventId);
      await requireDeferredEvent(tx, input.eventId);
      const invoice = await requireInvoice(tx, input.eventId, input.invoiceId);
      const latest = invoice.versions[0];
      if (!latest) throw new InvoiceError("Only a finalized invoice can be revised.", "NOT_FINALIZED");
      if (latest.status === "DRAFT") throw new InvoiceError("This invoice already has an open draft. Finalize or regenerate it first.", "DRAFT_EXISTS");
      if (latest.status !== "FINALIZED") throw new InvoiceError("Only a finalized invoice can be revised.", "NOT_FINALIZED");
      const prior = await tx.invoiceVersion.findUniqueOrThrow({
        where: { id: latest.id },
        select: { id: true, snapshot: true, manualLines: true, groupTitle: true, organizationName: true, registeredCount: true, billableCount: true, amountDueCents: true, amountsFingerprint: true, reconciliationVersionId: true, contactName: true, contactEmail: true, revision: true },
      });
      let data: Prisma.InvoiceVersionUncheckedCreateInput;
      if (input.mode === "CONTACT_ONLY") {
        const billing = await getBillingResponsibilityView(input.eventId, {}, tx);
        const contact = contactOfGroup(billing.groups.find((candidate) => candidate.key === invoice.groupKey));
        if (!contact) throw new InvoiceError("This group has no billing contact on file. Add one under Billing responsibility first.", "CONTACT_MISSING");
        if (contactsMatch(prior, contact)) throw new InvoiceError("The billing contact has not changed since this version was finalized.", "NO_CHANGE");
        data = {
          invoiceId: invoice.id,
          eventId: input.eventId,
          revision: prior.revision + 1,
          basis: "CONTACT_ONLY_COPY",
          supersedesVersionId: prior.id,
          reconciliationVersionId: prior.reconciliationVersionId,
          createdByUserId: input.actorUserId,
          revisionReason: reason,
          groupTitle: prior.groupTitle,
          organizationName: prior.organizationName,
          contactName: contact.name,
          contactEmail: contact.email,
          contactRoleLabel: contact.roleLabel,
          contactVerified: contact.verified,
          registeredCount: prior.registeredCount,
          billableCount: prior.billableCount,
          amountDueCents: prior.amountDueCents,
          amountsFingerprint: prior.amountsFingerprint,
          snapshot: prior.snapshot as Prisma.InputJsonValue,
          manualLines: prior.manualLines as Prisma.InputJsonValue,
        };
      } else {
        const basis = await loadApprovedBasis(tx, input.eventId);
        if (invoice.baseNumber !== null && invoice.invoiceGrouping !== basis.approved.invoiceGrouping) {
          throw new InvoiceError("This invoice was finalized under a different invoice grouping. Change the grouping back before revising it.", "GROUPING_CONFLICT");
        }
        const group = basis.result.groups.find((candidate) => candidate.key === invoice.groupKey);
        const contactGroup = basis.billing.groups.find((candidate) => candidate.key === invoice.groupKey);
        let figures: InvoiceFigures;
        let contact: InvoiceContact | null;
        if (group) {
          ({ figures, contact } = figuresFor(basis, group, contactGroup));
        } else {
          figures = emptyFigures(basis, invoice, prior.groupTitle, prior.organizationName);
          contact = contactOfGroup(contactGroup);
        }
        // A revision carries the finalized version's manual lines forward; staff can then change them on the draft.
        const manualLines = parseManualLines(prior.manualLines);
        if (withManualLines(figures, manualLines).amountsFingerprint === prior.amountsFingerprint && contactsMatch(prior, contact)) {
          throw new InvoiceError("Nothing has changed since this version was finalized: the amounts and the contact are the same.", "NO_CHANGE");
        }
        data = {
          invoiceId: invoice.id,
          eventId: input.eventId,
          revision: prior.revision + 1,
          basis: "RECONCILIATION",
          supersedesVersionId: prior.id,
          reconciliationVersionId: basis.approved.id,
          createdByUserId: input.actorUserId,
          revisionReason: reason,
          manualLines: manualLines as unknown as Prisma.InputJsonValue,
          ...figureColumns(figures, contact, manualLines),
        };
      }
      const created = await tx.invoiceVersion.create({ data, select: { id: true, revision: true } });
      await writeAuditLog({
        eventId: input.eventId,
        actorUserId: input.actorUserId,
        action: "INVOICE_REVISION_STARTED",
        entityType: "InvoiceVersion",
        entityId: created.id,
        summary: "Started a revision of a finalized invoice.",
        metadata: { eventId: input.eventId, invoiceId: invoice.id, versionId: created.id, revision: created.revision, revises: prior.id, mode: input.mode },
      }, tx);
      return { versionId: created.id, invoiceId: invoice.id, revision: created.revision };
    }, LONG_TRANSACTION);
  } catch (error) {
    if (isUniqueViolation(error)) throw new InvoiceError("This invoice already has an open draft or revision. Reload and try again.", "DRAFT_EXISTS");
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Finalization
// ---------------------------------------------------------------------------------------------

export type FinalizeResult = {
  /** False when this request found the version already finalized (a retry or a concurrent request) and returned its number. */
  changed: boolean;
  versionId: string;
  invoiceId: string;
  number: string;
  revision: number;
  amountDueCents: number;
};

/** Allocates the next number of the event's series with one atomic statement; the row lock serializes concurrent finalizations. */
async function allocateSequence(tx: Prisma.TransactionClient, event: { id: string }, code: string, year: number) {
  const now = new Date();
  const rows = await tx.$queryRaw<Array<{ lastNumber: number }>>`
    INSERT INTO "InvoiceNumberCounter" ("id", "eventId", "code", "year", "lastNumber", "createdAt", "updatedAt")
    VALUES (${randomUUID()}, ${event.id}, ${code}, ${year}, 1, ${now}, ${now})
    ON CONFLICT ("code", "year") DO UPDATE
      SET "lastNumber" = "InvoiceNumberCounter"."lastNumber" + 1, "updatedAt" = ${now}
      WHERE "InvoiceNumberCounter"."eventId" = EXCLUDED."eventId"
    RETURNING "lastNumber"`;
  if (rows.length === 0) {
    throw new InvoiceError(`Another event already issues invoice numbers starting ${code}${String(year % 100).padStart(2, "0")}. Set a different invoice code for this event first.`, "CODE_IN_USE");
  }
  return rows[0]!.lastNumber;
}

/**
 * Finalizes a draft: the one deliberate act that commits the conference to an invoice. Needs an explicit confirmation, a
 * named actor and (when the version is an original invoice or changes any billable amount) the Finalize invoices
 * permission, which this function enforces from `canFinalizeInvoices` and the amounts themselves (a revision that only
 * changes the contact needs no more than MANAGE_FINANCE, ADR 0008 section 4). In one transaction it checks the draft
 * is still current, assigns the invoice number exactly once (an original takes the next number of the event's series;
 * a revision adds -R<n> to its invoice's number), marks the version it revises SUPERSEDED with its receivable, freezes
 * the draft and records its receivable. A request for a version that is already finalized (a retry, or two requests
 * at once) returns the same number and changes nothing; the idempotency key may not be reused for another version.
 */
export async function finalizeInvoiceVersion(input: {
  eventId: string;
  versionId: string;
  actorUserId: string;
  idempotencyKey: string;
  confirm: boolean;
  canFinalizeInvoices: boolean;
}): Promise<FinalizeResult> {
  if (!input.confirm) throw new InvoiceError("Confirm that you are finalizing this invoice.", "CONFIRMATION_REQUIRED");
  const prisma = getPrisma();
  const replay = async (client: Client): Promise<FinalizeResult | null> => {
    const version = await client.invoiceVersion.findFirst({
      where: { id: input.versionId, eventId: input.eventId, status: { in: ["FINALIZED", "SUPERSEDED"] } },
      select: { id: true, invoiceId: true, number: true, revision: true, amountDueCents: true },
    });
    return version?.number ? { changed: false, versionId: version.id, invoiceId: version.invoiceId, number: version.number, revision: version.revision, amountDueCents: version.amountDueCents } : null;
  };
  try {
    return await prisma.$transaction(async (tx) => {
      // Lock first, then read the event: its code may have been frozen by a finalization that just ran.
      await lockReconciliationEvent(tx, input.eventId);
      const event = await requireDeferredEvent(tx, input.eventId);
      const version = await tx.invoiceVersion.findFirst({
        where: { id: input.versionId, eventId: input.eventId },
        select: {
          id: true, invoiceId: true, revision: true, status: true, basis: true, supersedesVersionId: true, reconciliationVersionId: true, amountsFingerprint: true, amountDueCents: true, manualLines: true,
          contactName: true, contactEmail: true, snapshot: true, groupTitle: true, organizationName: true,
          invoice: { select: { id: true, groupKey: true, partyKind: true, partyId: true, clubId: true, baseNumber: true, invoiceGrouping: true } },
        },
      });
      if (!version) throw new InvoiceError("That invoice version does not belong to this event.", "VERSION_NOT_FOUND");
      const used = await tx.invoiceVersion.findUnique({ where: { finalizeIdempotencyKey: input.idempotencyKey }, select: { id: true } });
      if (used && used.id !== version.id) {
        throw new InvoiceError("That request key was already used for a different invoice. Reload the page and try again.", "IDEMPOTENCY_KEY_REUSED");
      }
      if (version.status !== "DRAFT") {
        const again = await replay(tx);
        if (again) return again;
        throw new InvoiceError("That invoice version cannot be finalized.", "NOT_A_DRAFT");
      }
      // Belt and braces on top of the event lock: one finalization of an invoice at a time.
      await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${version.invoiceId} FOR UPDATE`;
      const invoice = version.invoice;
      const prior = version.revision > 0
        ? await tx.invoiceVersion.findFirst({
            where: { invoiceId: version.invoiceId, status: "FINALIZED" },
            select: { id: true, amountsFingerprint: true, revision: true },
          })
        : null;
      if (version.revision > 0 && (!prior || prior.id !== version.supersedesVersionId)) {
        throw new InvoiceError("The invoice changed after this revision was started. Revise it again.", "DRAFT_STALE");
      }
      const needsPermission = finalizationNeedsPermission(version, prior);
      if (needsPermission && !input.canFinalizeInvoices) {
        throw new InvoiceError("Finalizing an invoice, or a revision that changes an amount, needs the Finalize invoices permission.", "FINALIZE_PERMISSION_REQUIRED");
      }
      // The contact on the draft must be the contact now (a stale one would be frozen into the invoice).
      let billing: Awaited<ReturnType<typeof getBillingResponsibilityView>>;
      if (needsPermission) {
        const basis = await loadApprovedBasis(tx, input.eventId);
        if (invoice.invoiceGrouping !== basis.approved.invoiceGrouping) {
          throw invoice.baseNumber === null
            ? new InvoiceError("The event's invoice grouping changed after this draft was made. Create the drafts again.", "DRAFT_STALE")
            : new InvoiceError("This invoice was finalized under a different invoice grouping. Change the grouping back before finalizing a revision.", "GROUPING_CONFLICT");
        }
        if (basis.approved.id !== version.reconciliationVersionId) {
          throw new InvoiceError("A newer reconciliation was approved after this draft was made. Regenerate the draft first.", "DRAFT_STALE");
        }
        const group = basis.result.groups.find((candidate) => candidate.key === invoice.groupKey);
        const contactGroup = basis.billing.groups.find((candidate) => candidate.key === invoice.groupKey);
        const rebuilt = group
          ? figuresFor(basis, group, contactGroup).figures
          : version.revision > 0 ? emptyFigures(basis, invoice, version.groupTitle, version.organizationName) : null;
        if (!rebuilt || fingerprintWithManualLines(rebuilt.amountsFingerprint, parseManualLines(version.manualLines)) !== version.amountsFingerprint) {
          throw new InvoiceError("The approved reconciliation no longer matches this draft. Regenerate the draft first.", "DRAFT_STALE");
        }
        billing = basis.billing;
      } else {
        billing = await getBillingResponsibilityView(input.eventId, {}, tx);
      }
      const current = contactOfGroup(billing.groups.find((candidate) => candidate.key === invoice.groupKey));
      if (!version.contactName || !version.contactEmail) {
        throw new InvoiceError("This invoice has no billing contact. Add one under Billing responsibility, then regenerate the draft.", "CONTACT_MISSING");
      }
      if (!contactsMatch(version, current)) {
        throw new InvoiceError("The billing contact changed since this draft was made. Regenerate the draft so the invoice carries the current contact.", "CONTACT_STALE");
      }

      // The number, exactly once.
      let baseNumber = invoice.baseNumber;
      if (baseNumber === null) {
        const code = effectiveInvoiceCode(event);
        const year = eventInvoiceYear(event.startsAt, event.timezone);
        // The code is frozen on the event with the first number, so a later rename never starts a second series.
        if (event.invoiceCode === null) await tx.event.update({ where: { id: event.id }, data: { invoiceCode: code } });
        const sequence = await allocateSequence(tx, event, code, year);
        baseNumber = formatBaseNumber(code, year, sequence);
        await tx.invoice.update({ where: { id: invoice.id }, data: { baseNumber, numberCode: code, numberYear: year, numberSequence: sequence } });
      }
      const number = formatVersionNumber(baseNumber, version.revision);
      const now = new Date();
      const approver = await tx.user.findUniqueOrThrow({ where: { id: input.actorUserId }, select: { displayName: true } });
      if (prior) {
        const superseded = await tx.invoiceVersion.updateMany({ where: { id: prior.id, status: "FINALIZED" }, data: { status: "SUPERSEDED", supersededAt: now, supersededByVersionId: version.id } });
        if (superseded.count === 0) throw concurrent();
        await tx.invoiceReceivable.updateMany({ where: { invoiceVersionId: prior.id, status: "OPEN" }, data: { status: "SUPERSEDED", supersededAt: now, supersededByVersionId: version.id } });
        // An invoice email for the replaced version that has not gone out yet must never go out: cancel it in this transaction.
        // (Messages already being processed are caught by the delivery worker, which checks the version is still FINALIZED.)
        await tx.messageOutbox.updateMany({
          where: { eventId: input.eventId, templateKey: "INVOICE_DELIVERY", status: "PENDING", invoiceRecipients: { some: { delivery: { invoiceVersionId: prior.id } } } },
          data: { status: "CANCELLED", lastError: "The invoice was replaced by a newer version before this was sent." },
        });
      }
      const finalized = await tx.invoiceVersion.updateMany({
        where: { id: version.id, status: "DRAFT" },
        data: { status: "FINALIZED", number, finalizedAt: now, finalizedByUserId: input.actorUserId, finalizedByName: approver.displayName, finalizeIdempotencyKey: input.idempotencyKey },
      });
      // Losing the compare-and-set rolls back the number, the supersession and everything above with it.
      if (finalized.count === 0) throw concurrent();
      await tx.invoiceReceivable.create({
        data: { eventId: input.eventId, invoiceId: invoice.id, invoiceVersionId: version.id, amountCents: version.amountDueCents, status: "OPEN" },
      });
      await writeAuditLog({
        eventId: input.eventId,
        actorUserId: input.actorUserId,
        action: "INVOICE_FINALIZED",
        entityType: "InvoiceVersion",
        entityId: version.id,
        summary: `Finalized invoice ${number}.`,
        metadata: { eventId: input.eventId, invoiceId: invoice.id, versionId: version.id, number, revision: version.revision, amountDueCents: version.amountDueCents, reconciliationVersionId: version.reconciliationVersionId, supersededVersionId: prior?.id ?? null, amountsChanged: needsPermission },
      }, tx);
      return { changed: true, versionId: version.id, invoiceId: invoice.id, number, revision: version.revision, amountDueCents: version.amountDueCents };
    }, LONG_TRANSACTION);
  } catch (error) {
    const lost = error instanceof InvoiceError ? error.code === "CONCURRENT_CHANGE" : isUniqueViolation(error);
    if (!lost) throw error;
    // Another request finalized it first: that is the same outcome, with the same number.
    const again = await replay(prisma);
    if (again) return again;
    if (isUniqueViolation(error)) throw new InvoiceError("That request key was already used for a different invoice. Reload the page and try again.", "IDEMPOTENCY_KEY_REUSED");
    throw concurrent();
  }
}

// ---------------------------------------------------------------------------------------------
// Manual lines (#780)
// ---------------------------------------------------------------------------------------------

/**
 * Loads the invoice's open draft for a manual-line change under the event and invoice locks, and refuses anyone without
 * Finalize invoices (the same permission as finalizing: a line changes what is owed). Only a draft built from the
 * reconciliation takes manual lines; a contact-only copy of a finalized version changes nothing about amounts.
 */
async function loadDraftForManualLines(tx: Prisma.TransactionClient, input: { eventId: string; invoiceId: string; canFinalizeInvoices: boolean }) {
  if (!input.canFinalizeInvoices) {
    throw new InvoiceError("Adding or removing a manual invoice line needs the Finalize invoices permission.", "FINALIZE_PERMISSION_REQUIRED");
  }
  await lockReconciliationEvent(tx, input.eventId);
  await requireDeferredEvent(tx, input.eventId);
  await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${input.invoiceId} FOR UPDATE`;
  const invoice = await requireInvoice(tx, input.eventId, input.invoiceId);
  const latest = invoice.versions[0];
  if (!latest || latest.status !== "DRAFT") {
    throw new InvoiceError("Manual lines can be changed only on a draft. Revise a finalized invoice to start a new draft.", "NOT_A_DRAFT");
  }
  if (latest.basis !== "RECONCILIATION") {
    throw new InvoiceError("This draft only refreshes the billing contact of a finalized invoice. Start a revision from the reconciliation to add lines.", "NOT_A_DRAFT");
  }
  const draft = await tx.invoiceVersion.findUniqueOrThrow({ where: { id: latest.id }, select: { id: true, revision: true, snapshot: true, manualLines: true } });
  return { invoice, draft, snapshot: draft.snapshot as unknown as InvoiceSnapshot, lines: parseManualLines(draft.manualLines) };
}

/** Stores the new lines with the totals that include them; nothing else about the draft changes (the database enforces it). */
async function saveManualLines(tx: Prisma.TransactionClient, draftId: string, snapshot: InvoiceSnapshot, lines: ManualInvoiceLine[]) {
  const amountDueCents = snapshot.totals.amountDueCents + manualLinesTotal(lines);
  if (amountDueCents < 0) throw new InvoiceError("The lines would bring the invoice below $0.", "INVALID_INPUT");
  // The reconciliation figures' fingerprint is recomputed from the snapshot itself, so it never depends on the previous lines.
  const base = amountsFingerprintOf(snapshot.lines, snapshot.totals.amountDueCents);
  await tx.invoiceVersion.update({
    where: { id: draftId },
    data: { manualLines: lines as unknown as Prisma.InputJsonValue, amountDueCents, amountsFingerprint: fingerprintWithManualLines(base, lines) },
  });
  return amountDueCents;
}

/** Adds a custom line (item, description, quantity, rate) to an invoice's open draft. Needs Finalize invoices. */
export async function addManualInvoiceLine(input: { eventId: string; invoiceId: string; line: ManualLineInput; actorUserId: string; canFinalizeInvoices: boolean }) {
  const prisma = getPrisma();
  return prisma.$transaction(async (tx) => {
    const { draft, snapshot, lines } = await loadDraftForManualLines(tx, input);
    if (lines.length >= MANUAL_LINES_MAX) throw new InvoiceError(`An invoice can carry at most ${MANUAL_LINES_MAX} manual lines.`, "INVALID_INPUT");
    const normalized = normalizeManualLine(input.line, randomUUID());
    if (!normalized.ok) throw new InvoiceError(normalized.message, "INVALID_INPUT");
    const amountDueCents = await saveManualLines(tx, draft.id, snapshot, [...lines, normalized.line]);
    await writeAuditLog({
      eventId: input.eventId,
      actorUserId: input.actorUserId,
      action: "INVOICE_MANUAL_LINE_ADDED",
      entityType: "InvoiceVersion",
      entityId: draft.id,
      summary: "Added a manual line to an invoice draft.",
      metadata: { eventId: input.eventId, invoiceId: input.invoiceId, versionId: draft.id, lineId: normalized.line.id, quantity: normalized.line.quantity, rateCents: normalized.line.rateCents, amountCents: normalized.line.amountCents },
    }, tx);
    return { versionId: draft.id, invoiceId: input.invoiceId, lineId: normalized.line.id, amountDueCents };
  }, LONG_TRANSACTION);
}

/** Removes one manual line from an invoice's open draft. Needs Finalize invoices. */
export async function removeManualInvoiceLine(input: { eventId: string; invoiceId: string; lineId: string; actorUserId: string; canFinalizeInvoices: boolean }) {
  const prisma = getPrisma();
  return prisma.$transaction(async (tx) => {
    const { draft, snapshot, lines } = await loadDraftForManualLines(tx, input);
    const removed = lines.find((line) => line.id === input.lineId);
    if (!removed) throw new InvoiceError("That manual line is no longer on this draft.", "NO_CHANGE");
    const amountDueCents = await saveManualLines(tx, draft.id, snapshot, lines.filter((line) => line.id !== input.lineId));
    await writeAuditLog({
      eventId: input.eventId,
      actorUserId: input.actorUserId,
      action: "INVOICE_MANUAL_LINE_REMOVED",
      entityType: "InvoiceVersion",
      entityId: draft.id,
      summary: "Removed a manual line from an invoice draft.",
      metadata: { eventId: input.eventId, invoiceId: input.invoiceId, versionId: draft.id, lineId: removed.id, amountCents: removed.amountCents },
    }, tx);
    return { versionId: draft.id, invoiceId: input.invoiceId, lineId: removed.id, amountDueCents };
  }, LONG_TRANSACTION);
}

// ---------------------------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------------------------

export type InvoiceListRow = {
  invoiceId: string;
  groupKey: string;
  groupTitle: string;
  organizationName: string;
  baseNumber: string | null;
  /** The version staff are looking at: the open draft if there is one, else the finalized one. */
  current: InvoiceVersionSummary;
  /** The live finalized version, when there is one (the current one, or the one an open revision will replace). */
  finalized: InvoiceVersionSummary | null;
  hasOpenRevision: boolean;
  versionCount: number;
  /** The finalized contact no longer matches the billing contact now: offer a contact-only revision. */
  contactChanged: boolean;
  /** The finalized amounts no longer match the approved reconciliation: offer a revision. */
  amountsOutOfDate: boolean;
  /** The contact now (null when the group has none). */
  currentContact: InvoiceContact | null;
};

export type InvoicesView =
  | { isDeferred: false }
  | {
      isDeferred: true;
      eventName: string;
      invoiceGrouping: "PER_CHURCH" | "PER_CLUB";
      code: { effective: string; explicit: string | null; locked: boolean; year: number };
      /** The heading the invoice PDF groups registration lines under (#780). */
      clubType: string | null;
      approved: { id: string; versionNumber: number; billableCents: number; approvedAt: string | null; freshness: "CURRENT" | "FACTS_CHANGED" | "UNKNOWN" | "SUPERSEDED" } | null;
      blockers: ResponsibilityBlocker[];
      invoices: InvoiceListRow[];
      /** Groups of the approved reconciliation that have no invoice yet. */
      groupsWithoutInvoice: Array<{ key: string; title: string; amountCents: number }>;
      finalizers: string[];
      totals: { draftCount: number; finalizedCount: number; finalizedCents: number };
    };

/** The Invoices screen's data: every invoice of the event with its current version, plus what drafting would do now. */
export async function getInvoicesView(eventId: string): Promise<InvoicesView> {
  const prisma = getPrisma();
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { id: true, name: true, startsAt: true, timezone: true, billingMode: true, invoiceGrouping: true, invoiceCode: true, invoiceClubType: true },
  });
  if (!event) throw new InvoiceError("That event does not exist.", "EVENT_NOT_FOUND");
  if (event.billingMode !== "DEFERRED_ORGANIZATION_INVOICE") return { isDeferred: false };
  const facts = await loadReconciliationFacts(prisma, eventId);
  const billing = await getBillingResponsibilityView(eventId, {}, prisma);
  const approvedRow = await prisma.attendanceReconciliationVersion.findFirst({ where: { eventId, status: "APPROVED" }, select: approvedSelect });
  const approvedResult = approvedRow ? (approvedRow.snapshot as unknown as ReconciliationResult) : null;
  const invoices = await prisma.invoice.findMany({
    where: { eventId },
    orderBy: { createdAt: "asc" },
    select: { id: true, groupKey: true, baseNumber: true, versions: { where: { status: { not: "DISCARDED" } }, orderBy: { revision: "desc" }, select: versionSelect } },
  });
  // An invoice whose drafts were all discarded is hidden, and its group counts as not drafted.
  const liveInvoices = invoices.filter((invoice) => invoice.versions.length > 0);
  const rows: InvoiceListRow[] = liveInvoices.map((invoice) => {
    const versions = invoice.versions.map(toSummary);
    const latest = versions[0]!;
    const finalized = versions.find((version) => version.status === "FINALIZED") ?? null;
    const current = latest.status === "DRAFT" ? latest : finalized ?? latest;
    const currentContact = contactOfGroup(billing.groups.find((candidate) => candidate.key === invoice.groupKey));
    const group = approvedResult?.groups.find((candidate) => candidate.key === invoice.groupKey) ?? null;
    let amountsOutOfDate = false;
    if (finalized && latest.status !== "DRAFT" && approvedRow && approvedResult) {
      const figures = group
        ? buildInvoiceFigures({
            event: { id: event.id, name: event.name }, groupKey: group.key, groupTitle: group.title, invoiceGrouping: approvedRow.invoiceGrouping,
            party: { kind: group.partyKind === "PERSON" ? "PERSON" : "ORGANIZATION", id: group.partyId, name: group.partyName }, clubId: group.clubId,
            reconciliation: { versionId: approvedRow.id, versionNumber: approvedRow.versionNumber, ruleVersion: approvedRow.ruleVersion }, group,
          })
        : null;
      amountsOutOfDate = figures
        ? fingerprintWithManualLines(figures.amountsFingerprint, finalized.manualLines) !== finalized.amountsFingerprint
        : finalized.amountDueCents - manualLinesTotal(finalized.manualLines) > 0 || finalized.billableCount > 0;
    }
    return {
      invoiceId: invoice.id,
      groupKey: invoice.groupKey,
      groupTitle: current.groupTitle,
      organizationName: current.organizationName,
      baseNumber: invoice.baseNumber,
      current,
      finalized,
      hasOpenRevision: latest.status === "DRAFT" && latest.revision > 0,
      versionCount: versions.length,
      contactChanged: Boolean(finalized && latest.status !== "DRAFT" && !contactsMatch(
        finalized.contact ? { name: finalized.contact.name, email: finalized.contact.email } : null,
        currentContact ? { name: currentContact.name, email: currentContact.email } : null,
      )),
      amountsOutOfDate,
      currentContact,
    };
  });
  const haveKeys = new Set(liveInvoices.map((invoice) => invoice.groupKey));
  const finalizerRows = await prisma.eventMembership.findMany({
    where: { eventId, status: "ACTIVE", permissions: { has: "FINALIZE_INVOICES" } },
    select: { user: { select: { displayName: true } } },
    orderBy: { createdAt: "asc" },
  });
  const finalizedRows = rows.flatMap((row) => (row.finalized ? [row.finalized] : []));
  return {
    isDeferred: true,
    eventName: event.name,
    invoiceGrouping: event.invoiceGrouping,
    code: {
      effective: effectiveInvoiceCode(event),
      explicit: event.invoiceCode,
      locked: (await prisma.invoiceNumberCounter.count({ where: { eventId } })) > 0,
      year: eventInvoiceYear(event.startsAt, event.timezone),
    },
    clubType: event.invoiceClubType,
    approved: approvedRow
      ? { id: approvedRow.id, versionNumber: approvedRow.versionNumber, billableCents: approvedRow.billableCents, approvedAt: approvedRow.approvedAt?.toISOString() ?? null, freshness: versionFreshness(approvedRow, facts.fingerprint) }
      : null,
    blockers: facts.blockers,
    invoices: rows.sort((left, right) => left.groupTitle.localeCompare(right.groupTitle) || left.groupKey.localeCompare(right.groupKey)),
    groupsWithoutInvoice: (approvedResult?.groups ?? [])
      .filter((group) => group.partyKind !== "UNRESOLVED" && !haveKeys.has(group.key))
      .map((group) => ({ key: group.key, title: group.title, amountCents: group.billableCents })),
    finalizers: finalizerRows.map((row) => row.user.displayName),
    totals: {
      draftCount: rows.filter((row) => row.current.status === "DRAFT").length,
      finalizedCount: finalizedRows.length,
      finalizedCents: finalizedRows.reduce((total, row) => total + row.amountDueCents, 0),
    },
  };
}

export type InvoiceDetail = {
  invoice: {
    id: string;
    groupKey: string;
    baseNumber: string | null;
    invoiceGrouping: "PER_CHURCH" | "PER_CLUB";
    partyKind: "ORGANIZATION" | "PERSON" | "UNRESOLVED";
  };
  versions: InvoiceVersionSummary[];
  /** Drafts staff threw away: shown in the history as muted rows, never in lists or counts. */
  discarded: Array<{ id: string; revision: number; amountDueCents: number; discardedAt: string | null; discardedByName: string | null }>;
  shown: InvoiceVersionSummary;
  snapshot: InvoiceSnapshot;
  /** What the shown version changed compared with the version it revises (a revision only). */
  change: { amountsChanged: boolean; contactChanged: boolean; previousAmountCents: number; amountCents: number; previousNumber: string | null } | null;
  /** True for a draft: finalizing it needs the Finalize invoices permission (it is an original, or changes an amount). */
  needsFinalizePermission: boolean;
  currentContact: InvoiceContact | null;
  contactChanged: boolean;
  amountsOutOfDate: boolean;
  hasOpenDraft: boolean;
  liveFinalized: InvoiceVersionSummary | null;
  reconciliationFreshness: "CURRENT" | "FACTS_CHANGED" | "UNKNOWN" | "SUPERSEDED" | "NONE";
  approvedReconciliationVersionId: string | null;
};

/** One invoice with its version history and the shown version's snapshot (the open draft, else the live finalized one, else `versionId`). */
export async function getInvoiceDetail(eventId: string, invoiceId: string, options: { versionId?: string | null } = {}): Promise<InvoiceDetail | null> {
  const prisma = getPrisma();
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, eventId },
    select: { id: true, groupKey: true, baseNumber: true, invoiceGrouping: true, partyKind: true, versions: { where: { status: { not: "DISCARDED" } }, orderBy: { revision: "desc" }, select: { ...versionSelect, snapshot: true } } },
  });
  if (!invoice || invoice.versions.length === 0) return null;
  const summaries = invoice.versions.map(toSummary);
  const latest = summaries[0]!;
  const liveFinalized = summaries.find((version) => version.status === "FINALIZED") ?? null;
  const requested = options.versionId ? summaries.find((version) => version.id === options.versionId) ?? null : null;
  const shown = requested ?? (latest.status === "DRAFT" ? latest : liveFinalized ?? latest);
  const shownRow = invoice.versions.find((version) => version.id === shown.id)!;
  const discardedRows = await prisma.invoiceVersion.findMany({
    where: { invoiceId, eventId, status: "DISCARDED" },
    orderBy: { discardedAt: "desc" },
    select: { id: true, revision: true, amountDueCents: true, discardedAt: true },
  });
  const discardAudits = discardedRows.length === 0
    ? []
    : await prisma.auditLog.findMany({
        where: { eventId, action: "INVOICE_DRAFT_DISCARDED", entityId: { in: discardedRows.map((row) => row.id) } },
        select: { entityId: true, actor: { select: { displayName: true } } },
      });
  const discarded = discardedRows.map((row) => ({
    id: row.id,
    revision: row.revision,
    amountDueCents: row.amountDueCents,
    discardedAt: row.discardedAt?.toISOString() ?? null,
    discardedByName: discardAudits.find((audit) => audit.entityId === row.id)?.actor?.displayName ?? null,
  }));
  const prior = shown.supersedesVersionId ? summaries.find((version) => version.id === shown.supersedesVersionId) ?? null : null;
  const event = await prisma.event.findUniqueOrThrow({ where: { id: eventId }, select: { id: true, name: true, billingMode: true } });
  let currentContact: InvoiceContact | null = null;
  let freshness: InvoiceDetail["reconciliationFreshness"] = "NONE";
  let approvedId: string | null = null;
  let amountsOutOfDate = false;
  if (event.billingMode === "DEFERRED_ORGANIZATION_INVOICE") {
    const billing = await getBillingResponsibilityView(eventId, {}, prisma);
    currentContact = contactOfGroup(billing.groups.find((candidate) => candidate.key === invoice.groupKey));
    const approvedRow = await prisma.attendanceReconciliationVersion.findFirst({ where: { eventId, status: "APPROVED" }, select: approvedSelect });
    if (approvedRow) {
      const facts = await loadReconciliationFacts(prisma, eventId);
      freshness = versionFreshness(approvedRow, facts.fingerprint);
      approvedId = approvedRow.id;
      const result = approvedRow.snapshot as unknown as ReconciliationResult;
      const group = result.groups.find((candidate) => candidate.key === invoice.groupKey);
      if (liveFinalized && group) {
        const figures = buildInvoiceFigures({
          event: { id: event.id, name: event.name }, groupKey: group.key, groupTitle: group.title, invoiceGrouping: approvedRow.invoiceGrouping,
          party: { kind: group.partyKind === "PERSON" ? "PERSON" : "ORGANIZATION", id: group.partyId, name: group.partyName }, clubId: group.clubId,
          reconciliation: { versionId: approvedRow.id, versionNumber: approvedRow.versionNumber, ruleVersion: approvedRow.ruleVersion }, group,
        });
        amountsOutOfDate = fingerprintWithManualLines(figures.amountsFingerprint, liveFinalized.manualLines) !== liveFinalized.amountsFingerprint;
      } else if (liveFinalized && !group) {
        amountsOutOfDate = liveFinalized.amountDueCents - manualLinesTotal(liveFinalized.manualLines) > 0;
      }
    }
  }
  const change = prior
    ? { ...revisionChangeSummary({ amountsFingerprint: shown.amountsFingerprint, amountDueCents: shown.amountDueCents, contactName: shown.contact?.name ?? null, contactEmail: shown.contact?.email ?? null }, { amountsFingerprint: prior.amountsFingerprint, amountDueCents: prior.amountDueCents, contactName: prior.contact?.name ?? null, contactEmail: prior.contact?.email ?? null }), previousNumber: prior.number }
    : null;
  return {
    invoice: { id: invoice.id, groupKey: invoice.groupKey, baseNumber: invoice.baseNumber, invoiceGrouping: invoice.invoiceGrouping, partyKind: invoice.partyKind },
    versions: summaries,
    discarded,
    shown,
    snapshot: shownRow.snapshot as unknown as InvoiceSnapshot,
    change,
    needsFinalizePermission: shown.status === "DRAFT" ? finalizationNeedsPermission(shown, prior ? { amountsFingerprint: prior.amountsFingerprint } : null) : false,
    currentContact,
    contactChanged: Boolean(liveFinalized && !contactsMatch(
      liveFinalized.contact ? { name: liveFinalized.contact.name, email: liveFinalized.contact.email } : null,
      currentContact ? { name: currentContact.name, email: currentContact.email } : null,
    )),
    amountsOutOfDate,
    hasOpenDraft: latest.status === "DRAFT",
    liveFinalized,
    reconciliationFreshness: freshness,
    approvedReconciliationVersionId: approvedId,
  };
}
