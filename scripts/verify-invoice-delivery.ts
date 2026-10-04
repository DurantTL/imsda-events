/**
 * Proves invoice delivery, accounts receivable, payments and statements (#168) against a real PostgreSQL database,
 * where the unit tests' in-memory stand-ins can't:
 *
 * - the PDF of a finalized version is made once from its immutable snapshot and stored (hash checked by the database);
 *   a resend attaches the same stored bytes and the same hash, regenerating it from the same inputs gives the same bytes,
 *   and a contact changed after finalization leaves the PDF showing the snapshot contact;
 * - a send queues one outbox message per ticked recipient with the stored attachment (billing contact now + club directors),
 *   records a delivery with the version, sequence, actor and recipients, refuses none ticked, an unknown recipient, a changed
 *   recipient list and a superseded version (the database refuses it too), replays a retry with the same key, and records
 *   a bounce, a suppression (event email off) and the attachment handed to the provider on real delivery;
 * - "Posted to AR" is once per finalized version and corrected only by a superseding record; payments are append-only, partial
 *   payments leave an outstanding balance, a void is a reversal, an overpayment is flagged, and a revision carries what was paid;
 * - statements, the finance report and the treasurer CSV are scoped to the event in the URL (never another event's invoices), and
 *   the CSV is formula-safe;
 * - no audit row holds an email address or a contact's name, and deleting an event removes all of it.
 *
 * Uses fictitious rows it creates and removes itself.
 *
 *   npm run test:invoice-delivery
 */
import { loadEnvConfig } from "@next/env";
import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { assertLocalDatabase } from "./support/local-only-guard";
import { fillBlankSyntheticEnv } from "./support/synthetic-env";
import { prepareReconciliation, approveReconciliation, recordAttendanceCorrection } from "@/modules/attendance-reconciliation/repository";
import { resolveEventBillingResponsibility } from "@/modules/billing-responsibility/repository";
import { ensureEventMessagingDefaults } from "@/modules/communications/messaging-repository";
import { processExternalEmailQueue } from "@/modules/communications/email-delivery";
import { mapResendDeliveryEvent, providerTransitionUpdate } from "@/modules/communications/provider-events";
import { DEFAULT_PAYMENT_INSTRUCTIONS, treasurerCsvRows } from "@/modules/invoices/delivery-domain";
import { ensureInvoiceDocument, getInvoiceDeliveryHistory, getInvoicePdfForDownload, getInvoiceSendPreview, readInvoiceDocumentBytes, sendInvoiceVersion } from "@/modules/invoices/delivery-repository";
import { renderInvoicePdf } from "@/modules/invoices/invoice-pdf";
import {
  correctArPosting,
  getInvoiceFinanceReport,
  getPartyStatement,
  getTreasurerCsvInvoices,
  listEventStatements,
  loadEventLedger,
  postInvoiceToAr,
  recordInvoicePayment,
  setInvoicePaymentInstructions,
  voidInvoicePayment,
} from "@/modules/invoices/ledger-repository";
import { InvoiceError, createInvoiceDrafts, finalizeInvoiceVersion, reviseInvoice } from "@/modules/invoices/repository";
import type { InvoiceSnapshot } from "@/modules/invoices/domain";
import { toCsv } from "@/modules/reporting/csv";

loadEnvConfig(process.cwd());
// Local-only, before any Prisma client or connection exists.
assertLocalDatabase(process.env, "run this verification");
fillBlankSyntheticEnv("SECRET_ENCRYPTION_KEY", "verify-invoice-delivery-synthetic-key-not-a-secret");

const prisma = new PrismaClient();
const P = `id168_${randomUUID().slice(0, 8)}`;
const letters = (seed: string, count: number) => [...seed.replace(/[^0-9a-f]/g, "").padEnd(count, "0")].slice(0, count).map((char) => String.fromCharCode(65 + parseInt(char, 16))).join("");
const hex = (n: number) => randomUUID().replace(/-/g, "").slice(n, n + 5);
const CODE_A = letters(hex(0), 5);
const CODE_B = letters(hex(8), 5);
const ids = {
  staff: `${P}_staff`,
  clerk: `${P}_clerk`,
  treasurer: `${P}_treasurer`,
  holder: `${P}_holder`,
  church1: `${P}_church_1`,
  church2: `${P}_church_2`,
  club1: `${P}_club_1`,
  club2: `${P}_club_2`,
  club3: `${P}_club_3`,
  eventA: `${P}_ev_a`,
  eventB: `${P}_ev_b`,
  dir1: `${P}_dir_1`,
  dir2: `${P}_dir_2`,
  dir3: `${P}_dir_3`,
};
const events = [ids.eventA, ids.eventB];
const people = ["Ann", "Bo", "Cy", "Di", "Ed", "Flo", "Gus"].map((name) => ({ id: `${P}_person_${name}`, name }));
const EMAIL = {
  tina: `${P}.tina@contact.test`,
  sam: `${P}.sam@contact.test`,
  carl: `${P}.carl@contact.test`,
  dir1: `${P}.dir1@contact.test`,
  dir2: `${P}.dir2@contact.test`,
  dir3: `${P}.dir3@contact.test`,
};
const CHURCH2_NAME = `=Church Two ${P}`;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}
const rejects = (promise: Promise<unknown>) => promise.then(() => false, () => true);
const failure = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error);
const code = (error: unknown) => (error instanceof InvoiceError ? error.code : error instanceof Error ? `other:${error.message.slice(0, 100)}` : "none");
const key = (label: string) => `${label}-${P}-${randomUUID()}`;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function cleanup() {
  await prisma.auditLog.deleteMany({ where: { OR: [{ eventId: { in: events } }, { actorUserId: { in: [ids.staff, ids.clerk, ids.treasurer] } }] } });
  await prisma.publicRegistrationSubmission.deleteMany({ where: { eventId: { in: events } } });
  await prisma.event.deleteMany({ where: { id: { in: events } } });
  await prisma.clubDirectorGrant.deleteMany({ where: { attendeeAccountId: { in: [ids.dir1, ids.dir2, ids.dir3] } } });
  await prisma.attendeeAccount.deleteMany({ where: { id: { in: [ids.dir1, ids.dir2, ids.dir3] } } });
  await prisma.$transaction([
    prisma.$executeRawUnsafe('ALTER TABLE "OrganizationBillingContact" DISABLE TRIGGER "OrganizationBillingContact_no_delete"'),
    prisma.organizationBillingContact.deleteMany({ where: { organizationId: { in: [ids.church1, ids.church2] } } }),
    prisma.$executeRawUnsafe('ALTER TABLE "OrganizationBillingContact" ENABLE TRIGGER "OrganizationBillingContact_no_delete"'),
  ]);
  await prisma.organization.deleteMany({ where: { id: { in: [ids.club1, ids.club2, ids.club3] } } });
  await prisma.organization.deleteMany({ where: { id: { in: [ids.church1, ids.church2] } } });
  await prisma.person.deleteMany({ where: { id: { in: [ids.holder, ...people.map((entry) => entry.id)] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ids.staff, ids.clerk, ids.treasurer] } } });
}

let counter = 0;
async function registration(eventId: string, formVersionId: string, club: string, names: string[]) {
  counter += 1;
  const created = await prisma.registration.create({
    data: { eventId, accountHolderPersonId: ids.holder, confirmationCode: `${P}-${counter}`, status: "CONFIRMED", totalAmount: ((names.length * 2500) / 100).toFixed(2), submittedAt: new Date("2027-03-01T10:00:00Z") },
    select: { id: true },
  });
  await prisma.clubEventRegistration.create({ data: { eventId, organizationId: club, registrationId: created.id } });
  const attendees: Record<string, string> = {};
  for (const [position, name] of names.entries()) {
    const person = people.find((entry) => entry.name === name)!;
    const attendee = await prisma.registrationAttendee.create({
      data: { eventId, registrationId: created.id, personId: person.id, attendeeType: "YOUTH", position, profileSnapshot: { firstName: name, lastName: "Verify" }, createdAt: new Date("2027-03-01T10:00:00Z") },
      select: { id: true },
    });
    attendees[name] = attendee.id;
  }
  await prisma.publicRegistrationSubmission.create({
    data: {
      eventId, formVersionId, registrationId: created.id, idempotencyKey: `${P}-${counter}`, requestHash: `hash-${counter}`, responses: {},
      pricingSnapshot: { lineItems: names.map((_, index) => ({ key: `attendees.${index}.fee`, label: "Fee", amountCents: 2500, attendeeIndex: index })) },
    },
  });
  return { id: created.id, attendees };
}

const checkIn = (eventId: string, attendeeId: string) => prisma.checkIn.create({ data: { eventId, registrationAttendeeId: attendeeId, idempotencyKey: `${P}-ci-${attendeeId}` } });

async function newEvent(id: string, name: string, startsAt: string) {
  await prisma.event.create({
    data: { id, slug: `${P}-${id.slice(-1)}`, name, startsAt: new Date(startsAt), endsAt: new Date(new Date(startsAt).getTime() + 2 * 86_400_000), audience: "CLUB", billingMode: "DEFERRED_ORGANIZATION_INVOICE", invoiceGrouping: "PER_CHURCH" },
  });
  const form = await prisma.registrationForm.create({ data: { eventId: id, createdByUserId: ids.staff, name: "Synthetic form", slug: `${P}-form-${id.slice(-1)}` } });
  const version = await prisma.registrationFormVersion.create({ data: { formId: form.id, createdByUserId: ids.staff, versionNumber: 1, definition: { sections: [] } } });
  return version.id;
}

async function approveReconciled(eventId: string) {
  await resolveEventBillingResponsibility(eventId, { apply: true, actorUserId: ids.staff });
  const prepared = await prepareReconciliation({ eventId, actorUserId: ids.staff });
  await approveReconciliation({ eventId, versionId: prepared.versionId, actorUserId: ids.staff });
  return prepared.versionId;
}

const finalize = (eventId: string, versionId: string, label: string) =>
  finalizeInvoiceVersion({ eventId, versionId, actorUserId: ids.treasurer, idempotencyKey: key(label), confirm: true, canFinalizeInvoices: true });

async function send(eventId: string, versionId: string, options: { selected?: string[]; idempotencyKey?: string; subject?: string; body?: string } = {}) {
  const preview = await getInvoiceSendPreview(eventId, versionId);
  return sendInvoiceVersion({
    eventId,
    versionId,
    actorUserId: ids.clerk,
    selectedKeys: options.selected ?? preview.recipients.map((recipient) => recipient.key),
    recipientsFingerprint: preview.recipientsFingerprint,
    subject: options.subject ?? preview.subject,
    body: options.body ?? preview.body,
    idempotencyKey: options.idempotencyKey ?? key("send"),
    confirm: true,
  });
}

async function main() {
  await cleanup();
  await prisma.user.createMany({ data: [
    { id: ids.staff, email: `${P}_staff@example.test`, displayName: "Rae Reconciler" },
    { id: ids.clerk, email: `${P}_clerk@example.test`, displayName: "Fran Finance" },
    { id: ids.treasurer, email: `${P}_treasurer@example.test`, displayName: "Tess Treasurer" },
  ] });
  await prisma.person.createMany({ data: [
    { id: ids.holder, firstName: "Pat", lastName: "Holder", normalizedEmail: `${P}.holder@contact.test` },
    ...people.map((entry) => ({ id: entry.id, firstName: entry.name, lastName: "Verify" })),
  ] });
  await prisma.organization.createMany({ data: [
    { id: ids.church1, type: "CHURCH", name: `Delivery Check Church One ${P}`, normalizedName: `delivery check church one ${P}` },
    { id: ids.church2, type: "CHURCH", name: CHURCH2_NAME, normalizedName: `church two ${P}` },
  ] });
  await prisma.organization.createMany({ data: [
    { id: ids.club1, type: "CLUB", name: `Delivery Check Club 1 ${P}`, normalizedName: `delivery check club 1 ${P}`, parentOrganizationId: ids.church1 },
    { id: ids.club2, type: "CLUB", name: `Delivery Check Club 2 ${P}`, normalizedName: `delivery check club 2 ${P}`, parentOrganizationId: ids.church1 },
    { id: ids.club3, type: "CLUB", name: `Delivery Check Club 3 ${P}`, normalizedName: `delivery check club 3 ${P}`, parentOrganizationId: ids.church2 },
  ] });
  await prisma.organizationBillingContact.create({ data: { organizationId: ids.church1, name: "Tina Treasurer", email: EMAIL.tina, roleLabel: "Treasurer", verifiedAt: new Date(), createdByUserId: ids.treasurer } });
  await prisma.organizationBillingContact.create({ data: { organizationId: ids.church2, name: "Carl Clerk", email: EMAIL.carl, roleLabel: "Clerk", verifiedAt: new Date(), createdByUserId: ids.treasurer } });
  // Club directors (#354): two for church 1's clubs, one for church 2's club. A deputy and a revoked director must not be copied.
  await prisma.attendeeAccount.createMany({ data: [
    { id: ids.dir1, email: EMAIL.dir1, displayName: "Dana Director", status: "ACTIVE" },
    { id: ids.dir2, email: EMAIL.dir2, displayName: "Dev Director", status: "ACTIVE" },
    { id: ids.dir3, email: EMAIL.dir3, displayName: "Dot Director", status: "ACTIVE" },
  ] });
  const grant = (organizationId: string, attendeeAccountId: string, role: "DIRECTOR" | "DEPUTY" = "DIRECTOR", revokedAt: Date | null = null) =>
    prisma.clubDirectorGrant.create({ data: { organizationId, attendeeAccountId, role, reason: "synthetic", revokedAt, effectiveFrom: new Date("2020-01-01T00:00:00Z") } });
  await grant(ids.club1, ids.dir1);
  await grant(ids.club2, ids.dir2);
  await grant(ids.club3, ids.dir3);
  await grant(ids.club1, ids.dir3, "DEPUTY"); // a deputy of club 1 is not a director
  await grant(ids.club2, ids.dir3, "DIRECTOR", new Date("2021-01-01T00:00:00Z")); // revoked

  const formA = await newEvent(ids.eventA, "Verify Delivery A", "2027-04-01T12:00:00Z");
  const formB = await newEvent(ids.eventB, "Verify Delivery B", "2027-05-01T12:00:00Z");
  await prisma.event.update({ where: { id: ids.eventA }, data: { invoiceCode: CODE_A } });
  await prisma.event.update({ where: { id: ids.eventB }, data: { invoiceCode: CODE_B } });

  // Event A: church 1 (clubs 1 and 2: 4 attended at $25 = $100) and church 2 (club 3: 2 attended = $50).
  const r1 = await registration(ids.eventA, formA, ids.club1, ["Ann", "Bo", "Cy"]);
  const r2 = await registration(ids.eventA, formA, ids.club2, ["Di", "Ed"]);
  const r3 = await registration(ids.eventA, formA, ids.club3, ["Flo", "Gus"]);
  for (const name of ["Ann", "Bo"]) await checkIn(ids.eventA, r1.attendees[name]!);
  for (const name of ["Di", "Ed"]) await checkIn(ids.eventA, r2.attendees[name]!);
  await checkIn(ids.eventA, r3.attendees.Flo!);
  await checkIn(ids.eventA, r3.attendees.Gus!);
  // Event B: church 1 again, a different event with its own invoice (for cross-event scoping).
  const b1 = await registration(ids.eventB, formB, ids.club1, ["Ann"]);
  await checkIn(ids.eventB, b1.attendees.Ann!);

  await approveReconciled(ids.eventA);
  await approveReconciled(ids.eventB);
  await createInvoiceDrafts({ eventId: ids.eventA, actorUserId: ids.staff });
  await createInvoiceDrafts({ eventId: ids.eventB, actorUserId: ids.staff });
  const invA1 = await prisma.invoice.findFirstOrThrow({ where: { eventId: ids.eventA, partyId: ids.church1 }, include: { versions: true } });
  const invA2 = await prisma.invoice.findFirstOrThrow({ where: { eventId: ids.eventA, partyId: ids.church2 }, include: { versions: true } });
  const invB1 = await prisma.invoice.findFirstOrThrow({ where: { eventId: ids.eventB, partyId: ids.church1 }, include: { versions: true } });
  const draftA1 = invA1.versions[0]!;
  const draftA2 = invA2.versions[0]!;
  assert(draftA1.amountDueCents === 10000 && draftA2.amountDueCents === 5000, "the drafts bill $100 and $50");

  // Nothing is sent by finalizing, and a draft cannot be sent or have a PDF.
  assert(code(await failure(getInvoiceSendPreview(ids.eventA, draftA1.id))) === "VERSION_NOT_FOUND", "a draft has no send preview");
  assert(code(await failure(ensureInvoiceDocument(ids.eventA, draftA1.id))) === "NOT_FINALIZED", "a draft has no PDF");
  const numA1 = (await finalize(ids.eventA, draftA1.id, "f-a1")).number;
  const numA2 = (await finalize(ids.eventA, draftA2.id, "f-a2")).number;
  await finalize(ids.eventB, invB1.versions[0]!.id, "f-b1");
  assert((await prisma.messageOutbox.count({ where: { eventId: { in: events }, templateKey: "INVOICE_DELIVERY" } })) === 0 && (await prisma.invoiceDelivery.count({ where: { eventId: { in: events } } })) === 0, "finalizing sent nothing and recorded no delivery");
  assert((await prisma.invoiceVersionDocument.count({ where: { eventId: { in: events } } })) === 0, "finalizing made no PDF; it is made on first use");
  const v1 = draftA1.id;

  // ---------------------------------------------------------------------------------------------
  // Preview: the exact recipients
  // ---------------------------------------------------------------------------------------------
  await ensureEventMessagingDefaults(ids.eventA);
  await prisma.eventMessageSettings.update({ where: { eventId: ids.eventA }, data: { deliveryMode: "LOCAL_CAPTURE", senderName: "Verify Conference", senderEmail: `${P}.sender@conference.test`, replyToEmail: `${P}.reply@conference.test` } });
  const preview = await getInvoiceSendPreview(ids.eventA, v1);
  assert(preview.canSend && preview.version.number === numA1 && preview.version.status === "FINALIZED" && preview.blockedReason === null, "a finalized version can be sent");
  assert(preview.recipients.map((recipient) => `${recipient.kind}:${recipient.email}`).join() === `BILLING_CONTACT:${EMAIL.tina},CLUB_DIRECTOR:${EMAIL.dir1},CLUB_DIRECTOR:${EMAIL.dir2}`, "recipients: the billing contact, then the active directors of the invoice's clubs (no deputy, no revoked grant, none from another church)");
  assert(!preview.contactChanged && preview.snapshotContact?.name === "Tina Treasurer" && preview.currentContact?.name === "Tina Treasurer", "contact not changed yet");
  assert(preview.subject.includes(numA1) && preview.body.includes(numA1) && preview.body.includes(DEFAULT_PAYMENT_INSTRUCTIONS) && preview.isResend === false && preview.deliveryMode === "LOCAL_CAPTURE", "the default message names the invoice and the payment text");
  assert(!preview.recipients.some((recipient) => recipient.email === `${P}.holder@contact.test`), "the form submitter is never a recipient");

  // The PDF: made once, hash checked, deterministic.
  const doc = await ensureInvoiceDocument(ids.eventA, v1);
  assert(!doc.created || doc.sha256.length === 64, "the document has a hash");
  const again = await ensureInvoiceDocument(ids.eventA, v1);
  assert(again.id === doc.id && again.created === false && again.sha256 === doc.sha256, "the second call returns the stored document");
  const stored = await readInvoiceDocumentBytes(ids.eventA, v1);
  assert(sha(stored.bytes) === doc.sha256 && Buffer.from(stored.bytes).subarray(0, 5).toString() === "%PDF-" && stored.filename === `Invoice-${numA1}.pdf`, "the stored bytes hash to the recorded value");
  assert((await prisma.invoiceVersionDocument.count({ where: { invoiceVersionId: v1 } })) === 1 && (await prisma.messageAttachment.count({ where: { eventId: ids.eventA } })) === 1, "one document and one stored attachment");
  const racers = await Promise.all(Array.from({ length: 4 }, () => ensureInvoiceDocument(ids.eventA, invA2.versions[0]!.id)));
  assert(new Set(racers.map((entry) => entry.id)).size === 1 && (await prisma.invoiceVersionDocument.count({ where: { invoiceVersionId: draftA2.id } })) === 1, "parallel first requests make one document");
  // Regenerating from the same inputs gives the same bytes (what makes "never regenerated" checkable).
  const versionRow = await prisma.invoiceVersion.findUniqueOrThrow({ where: { id: v1 }, include: { event: true } });
  const docRow = await prisma.invoiceVersionDocument.findUniqueOrThrow({ where: { invoiceVersionId: v1 } });
  const rebuilt = await renderInvoicePdf({
    headerName: docRow.headerName, number: versionRow.number!, issuedAt: versionRow.finalizedAt!, timezone: versionRow.event.timezone, supersedesNumber: null,
    contact: { name: versionRow.contactName!, email: versionRow.contactEmail!, roleLabel: versionRow.contactRoleLabel ?? "" }, organizationName: versionRow.organizationName, groupTitle: versionRow.groupTitle,
    snapshot: versionRow.snapshot as unknown as InvoiceSnapshot, paymentInstructions: docRow.paymentInstructions,
  });
  assert(sha(rebuilt) === doc.sha256, "rebuilding the PDF from the same snapshot gives the same bytes");
  // The database refuses a rewrite, a delete, a wrong hash and a document for a draft.
  assert(await rejects(prisma.messageAttachment.update({ where: { id: doc.attachmentId }, data: { filename: "x.pdf" } })), "a stored attachment cannot be rewritten");
  assert(await rejects(prisma.messageAttachment.delete({ where: { id: doc.attachmentId } })), "a stored attachment cannot be deleted");
  assert(await rejects(prisma.$executeRawUnsafe(`UPDATE "MessageAttachment" SET "content" = '\\x00'::bytea WHERE "id" = '${doc.attachmentId}'`)), "attachment content cannot be rewritten");
  assert(await rejects(prisma.messageAttachment.create({ data: { eventId: ids.eventA, filename: "bad.pdf", contentType: "application/pdf", sizeBytes: 3, sha256: "0".repeat(64), content: Buffer.from("abc") } })), "an attachment whose hash does not match its content is refused");
  assert(await rejects(prisma.invoiceVersionDocument.update({ where: { invoiceVersionId: v1 }, data: { headerName: "x" } })), "a document cannot be rewritten");
  assert(await rejects(prisma.invoiceVersionDocument.delete({ where: { invoiceVersionId: v1 } })), "a document cannot be deleted");

  // ---------------------------------------------------------------------------------------------
  // Send: untick, none, unknown, changed list, replay
  // ---------------------------------------------------------------------------------------------
  const tinaKey = "billing";
  const dir1Key = `director:${ids.dir1}`;
  const dir2Key = `director:${ids.dir2}`;
  assert(preview.recipients.some((recipient) => recipient.key === tinaKey) && preview.recipients.some((recipient) => recipient.key === dir1Key) && preview.recipients.some((recipient) => recipient.key === dir2Key), "recipient keys are the billing contact and the director accounts");
  const baseSend = { eventId: ids.eventA, versionId: v1, actorUserId: ids.clerk, recipientsFingerprint: preview.recipientsFingerprint, subject: preview.subject, body: preview.body, confirm: true };
  assert(code(await failure(sendInvoiceVersion({ ...baseSend, selectedKeys: [], idempotencyKey: key("none") }))) === "NO_RECIPIENTS", "no recipient: refused");
  assert(code(await failure(sendInvoiceVersion({ ...baseSend, selectedKeys: [tinaKey, "director:nobody"], idempotencyKey: key("unknown") }))) === "UNKNOWN_RECIPIENT", "an unknown recipient key is refused");
  assert(code(await failure(sendInvoiceVersion({ ...baseSend, selectedKeys: [tinaKey], recipientsFingerprint: "stale", idempotencyKey: key("fp") }))) === "PREVIEW_CHANGED", "a recipient list that changed since the preview is refused");
  assert(code(await failure(sendInvoiceVersion({ ...baseSend, selectedKeys: [tinaKey], confirm: false, idempotencyKey: key("conf") }))) === "CONFIRMATION_REQUIRED", "a send needs an explicit confirmation");
  assert(code(await failure(sendInvoiceVersion({ ...baseSend, selectedKeys: [tinaKey], subject: "Line\nbreak", idempotencyKey: key("subj") }))) === "INVALID_INPUT", "a subject must be one line");
  assert(code(await failure(sendInvoiceVersion({ ...baseSend, eventId: ids.eventB, selectedKeys: [tinaKey], idempotencyKey: key("xe") }))) === "VERSION_NOT_FOUND", "another event's version cannot be sent");
  assert((await prisma.invoiceDelivery.count({ where: { eventId: { in: events } } })) === 0 && (await prisma.messageOutbox.count({ where: { eventId: { in: events }, templateKey: "INVOICE_DELIVERY" } })) === 0, "every refusal queued nothing and recorded nothing");

  const firstKey = key("first");
  const first = await sendInvoiceVersion({ ...baseSend, selectedKeys: [tinaKey, dir1Key], body: `${preview.body}\n{{manage_link}}`, idempotencyKey: firstKey });
  assert(first.sequence === 1 && first.recipientCount === 2 && !first.replayed && first.documentSha256 === doc.sha256 && first.number === numA1, "the first send: sequence 1, two recipients (one director unticked), the document's hash");
  assert(first.deliveryMode === "LOCAL_CAPTURE" && first.outcome.captured === 2, "local capture records the messages as captured, not emailed");
  const messages = await prisma.messageOutbox.findMany({ where: { eventId: ids.eventA, templateKey: "INVOICE_DELIVERY" }, orderBy: { recipientEmail: "asc" } });
  assert(messages.length === 2 && messages.every((message) => message.attachmentId === doc.attachmentId && message.recipientKind === "BILLING_CONTACT" && message.status === "CAPTURED"), "two messages, each with the stored attachment");
  assert(messages.map((message) => message.recipientEmail).sort().join() === [EMAIL.tina, EMAIL.dir1].sort().join(), "the unticked director got nothing");
  assert(messages.every((message) => message.bodyTextSnapshot.includes("{ {manage_link} }") && !message.bodyTextSnapshot.includes("{{manage_link}}") && message.bodyHtmlSnapshot !== null && message.subjectSnapshot === preview.subject && message.senderNameSnapshot === "Verify Conference"), "the body is stored as sent (placeholders neutralized), with its HTML and the event's sender");
  const delivery1 = await prisma.invoiceDelivery.findUniqueOrThrow({ where: { idempotencyKey: firstKey }, include: { recipients: true } });
  assert(delivery1.invoiceVersionId === v1 && delivery1.sequence === 1 && delivery1.sentByUserId === ids.clerk && delivery1.sentByName === "Fran Finance" && delivery1.documentId === docRow.id && delivery1.recipients.length === 2 && !delivery1.contactChangedSinceFinalization, "the delivery records the version, sequence, actor, document and recipients");
  assert(delivery1.recipients.map((recipient) => recipient.kind).sort().join() === "BILLING_CONTACT,CLUB_DIRECTOR", "one billing-contact row and one director row");
  // A retry with the same key replays; the key cannot be reused for another version.
  const replay = await sendInvoiceVersion({ ...baseSend, selectedKeys: [tinaKey], idempotencyKey: firstKey });
  assert(replay.replayed && replay.deliveryId === first.deliveryId && (await prisma.invoiceDelivery.count({ where: { invoiceVersionId: v1 } })) === 1 && (await prisma.messageOutbox.count({ where: { eventId: ids.eventA, templateKey: "INVOICE_DELIVERY" } })) === 2, "a retry with the same key sends nothing more");
  assert(code(await failure(sendInvoiceVersion({ ...baseSend, versionId: invA2.versions[0]!.id, selectedKeys: [tinaKey], idempotencyKey: firstKey }))) === "IDEMPOTENCY_KEY_REUSED", "a send key cannot be reused for another version");
  // Parallel sends with one key send once.
  const parKey = key("par");
  const par = await Promise.allSettled(Array.from({ length: 3 }, () => sendInvoiceVersion({ ...baseSend, selectedKeys: [dir2Key], idempotencyKey: parKey })));
  assert(par.every((outcome) => outcome.status === "fulfilled") && (await prisma.invoiceDelivery.count({ where: { invoiceVersionId: v1, idempotencyKey: parKey } })) === 1, "parallel sends with one key record one delivery");
  assert((await prisma.invoiceDelivery.count({ where: { invoiceVersionId: v1 } })) === 2, "that was the second delivery of the version");

  // Resend: same version, same PDF, a new delivery record.
  const resend = await send(ids.eventA, v1, { selected: [tinaKey] });
  assert(resend.sequence === 3 && resend.documentSha256 === doc.sha256, "a resend is a new delivery of the same version with the same PDF hash");
  assert((await prisma.invoiceVersionDocument.count({ where: { invoiceVersionId: v1 } })) === 1 && (await prisma.messageAttachment.count({ where: { eventId: ids.eventA, filename: `Invoice-${numA1}.pdf` } })) === 1, "the PDF was not regenerated or stored again");
  const attachmentsUsed = await prisma.messageOutbox.findMany({ where: { eventId: ids.eventA, templateKey: "INVOICE_DELIVERY" }, select: { attachmentId: true } });
  assert(attachmentsUsed.length === 4 && attachmentsUsed.every((row) => row.attachmentId === doc.attachmentId), "every message carries the one stored attachment");
  assert((await readInvoiceDocumentBytes(ids.eventA, v1)).sha256 === doc.sha256, "the bytes still hash to the recorded value after the resends");

  // ---------------------------------------------------------------------------------------------
  // Bounce, suppression, delivery mode
  // ---------------------------------------------------------------------------------------------
  const tinaMessage = await prisma.messageOutbox.findFirstOrThrow({ where: { eventId: ids.eventA, recipientEmail: EMAIL.tina, templateKey: "INVOICE_DELIVERY" }, orderBy: { createdAt: "desc" } });
  await prisma.messageOutbox.update({ where: { id: tinaMessage.id }, data: providerTransitionUpdate(mapResendDeliveryEvent("email.bounced", new Date())!) });
  const history = await getInvoiceDeliveryHistory(ids.eventA, invA1.id);
  const bounced = history.flatMap((entry) => entry.recipients).find((recipient) => recipient.email === EMAIL.tina && recipient.status === "BOUNCED");
  assert(history.length === 3 && bounced?.problem === true, "a bounce is recorded on the delivery's recipient");
  const afterBounce = await getInvoiceSendPreview(ids.eventA, v1);
  assert(afterBounce.recipients.find((recipient) => recipient.key === tinaKey)?.priorProblem?.includes("bounced") === true && afterBounce.isResend, "the preview warns that the last email to that address bounced, and calls it a resend");
  assert(afterBounce.recipients.length === 3, "a bounce does not remove the recipient: staff decide");

  await prisma.eventMessageSettings.update({ where: { eventId: ids.eventA }, data: { deliveryMode: "DISABLED" } });
  const suppressed = await send(ids.eventA, v1, { selected: [dir1Key] });
  assert(suppressed.deliveryMode === "DISABLED" && suppressed.outcome.suppressed === 1, "with event email off the message is recorded as suppressed, not sent");
  const suppressedRow = await prisma.messageOutbox.findFirstOrThrow({ where: { recipientEmail: EMAIL.dir1, status: "SUPPRESSED" } });
  assert(suppressedRow.attachmentId === doc.attachmentId && suppressedRow.lastError !== null, "the suppressed message is on record with its attachment");

  // Real delivery hands the provider the stored PDF.
  await prisma.eventMessageSettings.update({ where: { eventId: ids.eventA }, data: { deliveryMode: "EXTERNAL_EMAIL", senderEmail: null } });
  assert(code(await failure(send(ids.eventA, v1, { selected: [dir1Key] }))) === "EXTERNAL_EMAIL_NOT_CONFIGURED", "real email needs a sender address");
  await prisma.eventMessageSettings.update({ where: { eventId: ids.eventA }, data: { senderEmail: `${P}.sender@conference.test` } });
  const external = await send(ids.eventA, v1, { selected: [dir2Key] });
  const pendingRows = await prisma.messageOutbox.findMany({ where: { id: { in: (await prisma.invoiceDeliveryRecipient.findMany({ where: { deliveryId: external.deliveryId } })).map((row) => row.messageOutboxId) } } });
  assert(external.deliveryMode === "EXTERNAL_EMAIL" && pendingRows.every((row) => row.status === "PENDING" || row.status === "FAILED" || row.status === "SENT"), "real email is queued through the outbox");
  const provided: Array<{ filename: string; contentType: string; sha: string }> = [];
  const processed = await processExternalEmailQueue(ids.eventA, {
    messageIds: pendingRows.filter((row) => row.status === "PENDING").map((row) => row.id),
    dependencies: {
      configuration: { apiKey: "synthetic-not-a-key", apiUrl: "http://127.0.0.1:9" },
      sendEmail: async (input) => {
        for (const attachment of input.attachments ?? []) provided.push({ filename: attachment.filename, contentType: attachment.contentType, sha: sha(attachment.content) });
        return { provider: "RESEND", providerMessageId: `synthetic-${randomUUID()}` };
      },
    },
  });
  assert(processed.sentIds.length === pendingRows.filter((row) => row.status === "PENDING").length && provided.length === processed.sentIds.length, "the provider was handed an attachment for each message");
  assert(provided.every((entry) => entry.filename === `Invoice-${numA1}.pdf` && entry.contentType === "application/pdf" && entry.sha === doc.sha256), "the attachment is the stored PDF, byte for byte");
  await prisma.eventMessageSettings.update({ where: { eventId: ids.eventA }, data: { deliveryMode: "LOCAL_CAPTURE" } });

  // ---------------------------------------------------------------------------------------------
  // A contact changed after finalization: recipients follow the current contact, the PDF the snapshot
  // ---------------------------------------------------------------------------------------------
  await prisma.organizationBillingContact.updateMany({ where: { organizationId: ids.church1, effectiveTo: null }, data: { effectiveTo: new Date() } });
  await prisma.organizationBillingContact.create({ data: { organizationId: ids.church1, name: "Sam Successor", email: EMAIL.sam, roleLabel: "Treasurer", verifiedAt: new Date(), createdByUserId: ids.treasurer } });
  const changed = await getInvoiceSendPreview(ids.eventA, v1);
  assert(changed.contactChanged && changed.snapshotContact?.name === "Tina Treasurer" && changed.currentContact?.name === "Sam Successor", "the preview flags the contact change and names both");
  assert(changed.recipients[0]!.email === EMAIL.sam && !changed.recipients.some((recipient) => recipient.email === EMAIL.tina), "the email goes to the current billing contact, not the snapshot's");
  assert(code(await failure(sendInvoiceVersion({ ...baseSend, selectedKeys: [tinaKey], idempotencyKey: key("old-page") }))) === "PREVIEW_CHANGED", "a page opened before the contact changed cannot send");
  const toSam = await send(ids.eventA, v1, { selected: ["billing"] });
  const samDelivery = await prisma.invoiceDelivery.findUniqueOrThrow({ where: { id: toSam.deliveryId } });
  assert(samDelivery.contactChangedSinceFinalization && toSam.documentSha256 === doc.sha256, "the delivery records that the contact had changed, with the same PDF");
  assert((await prisma.messageOutbox.count({ where: { eventId: ids.eventA, recipientEmail: EMAIL.sam, templateKey: "INVOICE_DELIVERY" } })) === 1, "the new contact received it");
  assert((await readInvoiceDocumentBytes(ids.eventA, v1)).sha256 === doc.sha256, "the PDF still shows the contact it was finalized with (same bytes)");
  // A version that was never sent still gets its PDF from the snapshot, with the old contact.
  const pdfA2 = await getInvoicePdfForDownload(ids.eventA, draftA2.id);
  assert(Buffer.from(pdfA2.bytes).subarray(0, 5).toString() === "%PDF-", "a finalized version's PDF can be downloaded by staff");
  assert(code(await failure(getInvoicePdfForDownload(ids.eventB, v1))) === "VERSION_NOT_FOUND", "another event cannot download this PDF");

  // ---------------------------------------------------------------------------------------------
  // A revision supersedes: the old version cannot be sent
  // ---------------------------------------------------------------------------------------------
  const rev = await reviseInvoice({ eventId: ids.eventA, invoiceId: invA1.id, mode: "CONTACT_ONLY", reason: "New treasurer", actorUserId: ids.staff });
  assert(code(await failure(send(ids.eventA, rev.versionId))) === "VERSION_NOT_FOUND", "an unfinalized revision cannot be previewed or sent");
  await finalizeInvoiceVersion({ eventId: ids.eventA, versionId: rev.versionId, actorUserId: ids.staff, idempotencyKey: key("rev"), confirm: true, canFinalizeInvoices: false });
  const oldPreview = await getInvoiceSendPreview(ids.eventA, v1);
  assert(!oldPreview.canSend && oldPreview.newerVersion?.id === rev.versionId && oldPreview.blockedReason?.includes("replaced"), "a superseded version shows a notice and the newer version");
  assert(code(await failure(sendInvoiceVersion({ ...baseSend, selectedKeys: [tinaKey], idempotencyKey: key("sup") }))) === "NOT_SENDABLE", "a superseded version cannot be sent");
  assert(await rejects(prisma.invoiceDelivery.create({ data: { eventId: ids.eventA, invoiceId: invA1.id, invoiceVersionId: v1, documentId: docRow.id, sequence: 99, sentByName: "x", subject: "x", idempotencyKey: key("raw") } })), "the database refuses a delivery of a superseded version");
  assert(await rejects(prisma.invoiceDelivery.update({ where: { id: first.deliveryId }, data: { subject: "changed" } })) && await rejects(prisma.invoiceDelivery.delete({ where: { id: first.deliveryId } })), "a delivery record is append-only");
  assert(await rejects(prisma.invoiceDeliveryRecipient.deleteMany({ where: { deliveryId: first.deliveryId } })), "a delivery's recipients are append-only");
  const v1r = rev.versionId;
  const revPreview = await getInvoiceSendPreview(ids.eventA, v1r);
  assert(revPreview.canSend && revPreview.version.number === `${numA1}-R1` && !revPreview.isResend && revPreview.snapshotContact?.name === "Sam Successor" && !revPreview.contactChanged, "the revision is sendable, carries the new contact and has not been sent");
  assert(revPreview.body.includes(`replaces ${numA1}`), "the default message says which invoice it replaces");
  const revSend = await send(ids.eventA, v1r);
  const revDoc = await prisma.invoiceVersionDocument.findUniqueOrThrow({ where: { invoiceVersionId: v1r } });
  assert(revSend.sequence === 1 && revDoc.sha256 !== doc.sha256 && revSend.documentSha256 === revDoc.sha256, "the revision has its own document and its own first send");
  assert((await getInvoiceDeliveryHistory(ids.eventA, invA1.id)).length === 7, "the invoice's history holds every send of every version");

  // ---------------------------------------------------------------------------------------------
  // Posted to AR
  // ---------------------------------------------------------------------------------------------
  assert(code(await failure(postInvoiceToAr({ eventId: ids.eventA, versionId: v1, postedOn: "2027-04-20", actorUserId: ids.clerk }))) === "NOT_FINALIZED", "a superseded version cannot be posted");
  assert(code(await failure(postInvoiceToAr({ eventId: ids.eventA, versionId: v1r, postedOn: "2027-13-40", actorUserId: ids.clerk }))) === "INVALID_INPUT", "an invalid date is refused");
  assert(code(await failure(postInvoiceToAr({ eventId: ids.eventB, versionId: v1r, postedOn: "2027-04-20", actorUserId: ids.clerk }))) === "VERSION_NOT_FOUND", "another event's version cannot be posted");
  assert(code(await failure(postInvoiceToAr({ eventId: ids.eventA, versionId: draftA1.id === v1r ? v1 : v1r, postedOn: "2027-04-20", reference: "x".repeat(81), actorUserId: ids.clerk }))) === "INVALID_INPUT", "a reference has a length limit");
  const posted = await postInvoiceToAr({ eventId: ids.eventA, versionId: v1r, postedOn: "2027-04-20", reference: "GL-1001", actorUserId: ids.clerk });
  assert(posted.versionId === v1r, "a finalized version is posted to AR");
  assert(code(await failure(postInvoiceToAr({ eventId: ids.eventA, versionId: v1r, postedOn: "2027-04-21", actorUserId: ids.clerk }))) === "ALREADY_POSTED", "posting is once per version");
  assert(code(await failure(correctArPosting({ eventId: ids.eventA, versionId: invA2.versions[0]!.id, postedOn: "2027-04-21", reason: "typo", actorUserId: ids.clerk }))) === "NOT_POSTED", "an unposted version has nothing to correct");
  assert(code(await failure(correctArPosting({ eventId: ids.eventA, versionId: v1r, postedOn: "2027-04-21", reason: " ", actorUserId: ids.clerk }))) === "INVALID_INPUT", "a correction needs a reason");
  const corrected = await correctArPosting({ eventId: ids.eventA, versionId: v1r, postedOn: "2027-04-22", reference: "GL-1002", reason: "Wrong period", actorUserId: ids.clerk });
  assert(corrected.correctsPostingId === posted.postingId, "a correction names the posting it replaces");
  assert((await prisma.invoiceArPosting.count({ where: { invoiceVersionId: v1r } })) === 2, "both postings stay on record");
  assert(await rejects(prisma.invoiceArPosting.update({ where: { id: posted.postingId }, data: { reference: "x" } })) && await rejects(prisma.invoiceArPosting.delete({ where: { id: posted.postingId } })), "AR postings are append-only");
  assert(await rejects(prisma.invoiceArPosting.create({ data: { eventId: ids.eventA, invoiceId: invA1.id, invoiceVersionId: v1r, postedOn: new Date("2027-05-01"), recordedByName: "x" } })), "the database allows one root posting per version");

  // ---------------------------------------------------------------------------------------------
  // Payments: partial, void, overpaid, revision carries them
  // ---------------------------------------------------------------------------------------------
  const pay = (invoiceId: string, amount: string, extra: Partial<{ checkNumber: string; receivedOn: string; note: string; requestKey: string }> = {}) =>
    recordInvoicePayment({ eventId: ids.eventA, invoiceId, amount, checkNumber: extra.checkNumber ?? null, receivedOn: extra.receivedOn ?? "2027-05-02", note: extra.note ?? null, requestKey: extra.requestKey ?? key("pay"), actorUserId: ids.clerk });
  for (const bad of ["0", "-5", "abc", "10.999", "", "1e3"]) {
    assert(code(await failure(pay(invA1.id, bad))) === "INVALID_INPUT", `amount "${bad}" is refused`);
  }
  assert(code(await failure(pay(invA1.id, "10", { receivedOn: "yesterday" }))) === "INVALID_INPUT", "a bad date is refused");
  assert(code(await failure(recordInvoicePayment({ eventId: ids.eventB, invoiceId: invA1.id, amount: "10", receivedOn: "2027-05-02", requestKey: key("x"), actorUserId: ids.clerk }))) === "INVOICE_NOT_FOUND", "another event's invoice takes no payment");
  const ledgerBefore = (await loadEventLedger(ids.eventA, { invoiceId: invA1.id }))[0]!;
  assert(ledgerBefore.figures.amountDueCents === 10000 && ledgerBefore.figures.outstandingCents === 10000 && ledgerBefore.settlement === "UNPAID", "$100 invoice, nothing paid: $100 outstanding");
  const payKey = key("p60");
  const p60 = await pay(invA1.id, "$60.00", { checkNumber: "1042", note: "Check from the church", requestKey: payKey });
  assert(p60.outstandingCents === 4000 && p60.paidCents === 6000 && !p60.replayed, "a partial payment of $60 leaves $40 outstanding");
  const p60again = await pay(invA1.id, "60", { requestKey: payKey });
  assert(p60again.replayed && p60again.paymentId === p60.paymentId && (await prisma.invoicePayment.count({ where: { invoiceId: invA1.id } })) === 1, "a double click records one payment");
  assert(code(await failure(pay(invA1.id, "61", { requestKey: payKey }))) === "IDEMPOTENCY_KEY_REUSED", "a payment key cannot be reused for another amount");
  const ledgerPartial = (await loadEventLedger(ids.eventA, { invoiceId: invA1.id }))[0]!;
  assert(ledgerPartial.settlement === "PARTIALLY_PAID" && ledgerPartial.payments.length === 1 && ledgerPartial.payments[0]!.checkNumber === "1042" && ledgerPartial.live.posting?.reference === "GL-1002", "the ledger shows the partial payment, the check number and the corrected AR posting");
  assert(await rejects(prisma.invoicePayment.update({ where: { id: p60.paymentId }, data: { amountCents: 1 } })) && await rejects(prisma.invoicePayment.delete({ where: { id: p60.paymentId } })), "payments are append-only");
  // Void: a reversal entry with a reason.
  const p10 = await pay(invA1.id, "10.00", { requestKey: key("p10") });
  assert(p10.outstandingCents === 3000, "$70 paid, $30 outstanding");
  assert(code(await failure(voidInvoicePayment({ eventId: ids.eventA, paymentId: p10.paymentId, reason: " ", requestKey: key("v"), actorUserId: ids.clerk }))) === "INVALID_INPUT", "a void needs a reason");
  assert(code(await failure(voidInvoicePayment({ eventId: ids.eventB, paymentId: p10.paymentId, reason: "Entered twice", requestKey: key("v"), actorUserId: ids.clerk }))) === "PAYMENT_NOT_FOUND", "another event cannot void this payment");
  const voidKey = key("void");
  const voided = await voidInvoicePayment({ eventId: ids.eventA, paymentId: p10.paymentId, reason: "Entered twice", requestKey: voidKey, actorUserId: ids.clerk });
  assert(voided.outstandingCents === 4000 && voided.paidCents === 6000, "voiding the $10 payment restores $40 outstanding");
  assert((await voidInvoicePayment({ eventId: ids.eventA, paymentId: p10.paymentId, reason: "Entered twice", requestKey: voidKey, actorUserId: ids.clerk })).replayed, "a retried void is a replay");
  assert(code(await failure(voidInvoicePayment({ eventId: ids.eventA, paymentId: p10.paymentId, reason: "again", requestKey: key("v2"), actorUserId: ids.clerk }))) === "ALREADY_VOIDED", "a payment is voided once");
  const entries = await prisma.invoicePayment.findMany({ where: { invoiceId: invA1.id }, orderBy: { createdAt: "asc" } });
  assert(entries.map((entry) => entry.kind).join() === "PAYMENT,PAYMENT,REVERSAL" && entries[2]!.reversesPaymentId === p10.paymentId && entries[2]!.amountCents === 1000, "the original and its reversal both stay on record");
  assert(await rejects(prisma.invoicePayment.create({ data: { eventId: ids.eventA, invoiceId: invA1.id, invoiceVersionId: v1r, receivableId: entries[0]!.receivableId, kind: "REVERSAL", amountCents: 5, receivedOn: new Date("2027-05-03"), reversesPaymentId: p60.paymentId, reason: "wrong amount", recordedByName: "x" } })), "the database refuses a reversal of a different amount");
  // The payment recorded against the superseded version's receivable would be refused by the database.
  const oldReceivable = await prisma.invoiceReceivable.findUniqueOrThrow({ where: { invoiceVersionId: v1 } });
  assert(oldReceivable.status === "SUPERSEDED" && await rejects(prisma.invoicePayment.create({ data: { eventId: ids.eventA, invoiceId: invA1.id, invoiceVersionId: v1, receivableId: oldReceivable.id, kind: "PAYMENT", amountCents: 100, receivedOn: new Date("2027-05-03"), recordedByName: "x" } })), "a payment cannot be recorded against a superseded receivable");

  // Revised invoice carries payments: church 2's $50 invoice, $20 paid, then Gus's attendance is withdrawn so it becomes $25 (a revision that changes an amount).
  const part2 = await pay(invA2.id, "20.00", { requestKey: key("c2") });
  assert(part2.outstandingCents === 3000, "church 2: $50 invoice, $20 paid, $30 outstanding");
  await recordAttendanceCorrection({ eventId: ids.eventA, attendeeId: r3.attendees.Gus!, kind: "MARK_NOT_ATTENDED", reason: "Left early", actorUserId: ids.staff });
  await approveReconciled(ids.eventA);
  const rev2 = await reviseInvoice({ eventId: ids.eventA, invoiceId: invA2.id, mode: "FROM_RECONCILIATION", reason: "Gus did not attend", actorUserId: ids.staff });
  await finalize(ids.eventA, rev2.versionId, "rev2");
  const ledger2 = (await loadEventLedger(ids.eventA, { invoiceId: invA2.id }))[0]!;
  assert(ledger2.live.number === `${numA2}-R1` && ledger2.figures.amountDueCents === 2500 && ledger2.figures.paidCents === 2000 && ledger2.figures.outstandingCents === 500, "the revision carries what was paid: $25 new total less $20 paid = $5 outstanding");
  assert(ledger2.payments.length === 1 && ledger2.payments[0]!.versionNumber === numA2, "the payment stays attached to the version it was recorded against");
  const overpay = await pay(invA2.id, "30.00", { requestKey: key("over") });
  assert(overpay.outstandingCents === 0 && overpay.overpaidCents === 2500 && (await loadEventLedger(ids.eventA, { invoiceId: invA2.id }))[0]!.settlement === "OVERPAID", "paying more than is owed is accepted and flagged as overpaid; outstanding never goes below zero");
  // A revision is posted again: its mark is its own, since the amount changed.
  assert(ledger2.live.posting === null, "a revision starts unposted");

  // ---------------------------------------------------------------------------------------------
  // Statements, report, CSV: scoped to the event
  // ---------------------------------------------------------------------------------------------
  const statementA = await getPartyStatement(ids.eventA, ids.church1);
  const statementB = await getPartyStatement(ids.eventB, ids.church1);
  assert(statementA !== null && statementA.invoices.length === 1 && statementA.invoices[0]!.live.number === `${numA1}-R1` && statementA.invoices[0]!.versions.length === 2, "church 1's statement for event A: its invoice with the superseded version as history");
  assert(statementA.totals.invoicedCents === 10000 && statementA.totals.paidCents === 6000 && statementA.totals.outstandingCents === 4000, "statement totals reconcile to the payments and outstanding");
  assert(statementA.invoices[0]!.payments.some((payment) => payment.kind === "REVERSAL") && statementA.invoices[0]!.payments.find((payment) => payment.id === p10.paymentId)?.voided === true, "the statement shows the void");
  assert(statementB !== null && statementB.invoices.length === 1 && statementB.invoices[0]!.invoiceId === invB1.id, "the same church's statement for event B holds only event B's invoice");
  assert(!JSON.stringify(statementA).includes(invB1.id) && !JSON.stringify(statementB).includes(invA1.id), "no statement leaks another event's invoice");
  assert((await getPartyStatement(ids.eventB, ids.church2)) === null && (await getPartyStatement(ids.eventA, "nobody")) === null, "a church with no invoice on the event has no statement there");
  const list = await listEventStatements(ids.eventA);
  assert(list.parties.length === 2 && list.totals.invoiceCount === 2 && list.totals.invoicedCents === 12500, "the event's statements list: two churches, $125 invoiced");
  const report = await getInvoiceFinanceReport(ids.eventA);
  assert(report.headcount.submitted === 7 && report.headcount.billable === 5 && report.invoiced.invoiceCount === 2 && report.invoiced.amountCents === 12500, "report: submitted headcount, billable units and the invoiced amount");
  assert(report.paidCents === 6000 + 5000, "report: paid is every payment net of voids");
  assert(report.outstandingCents === 4000 && report.overpaidCents === 2500 && report.invoiced.postedToArCount === 1 && report.invoiced.sentCount === 1 && report.invoiced.notSentCount === 1, "report: outstanding, overpaid, posted to AR and sent counts");
  assert(report.attendeePayments.netCents === 0, "attendee payments are reported apart (none here)");
  const csv = await getTreasurerCsvInvoices(ids.eventA);
  const csvText = toCsv(treasurerCsvRows(csv));
  const lines = csvText.trim().split("\r\n");
  assert(lines.length === 3 && lines[0]!.startsWith('"Invoice number"'), "the CSV has a header and one row per finalized invoice");
  assert(lines.some((line) => line.includes(`"${numA1}-R1"`) && line.includes('"2027-04-22"') && line.includes('"GL-1002"') && line.includes('"60.00"') && line.includes('"40.00"')), "the CSV carries number, AR date and reference, paid and outstanding");
  assert(lines.some((line) => line.includes(`"'=Church Two ${P}"`)) && !lines.some((line) => /(^|,)"=/.test(line)), "a church name that looks like a formula is neutralized");
  assert(lines.some((line) => line.includes(`"${numA1}-R1"`) && line.trimEnd().endsWith(`"${new Date().toISOString().slice(0, 10)}"`)), "the CSV carries the date it was last sent");
  const savedInstruction = await setInvoicePaymentInstructions({ eventId: ids.eventA, instructions: "Mail checks to PO Box 1, Synthetic City.", actorUserId: ids.clerk });
  assert(savedInstruction.changed && (await getInvoiceFinanceReport(ids.eventA)).paymentInstructions === "Mail checks to PO Box 1, Synthetic City.", "finance staff set the payment instruction");
  assert((await readInvoiceDocumentBytes(ids.eventA, v1)).sha256 === doc.sha256, "changing the instruction does not change a PDF already made");
  assert(code(await failure(setInvoicePaymentInstructions({ eventId: ids.eventA, instructions: "x".repeat(601), actorUserId: ids.clerk }))) === "INVALID_INPUT", "the instruction has a length limit");
  assert(!(await setInvoicePaymentInstructions({ eventId: ids.eventA, instructions: "Mail checks to PO Box 1, Synthetic City.", actorUserId: ids.clerk })).changed, "saving the same instruction changes nothing");

  // ---------------------------------------------------------------------------------------------
  // Audit: ids and counts, never an address or a contact's name
  // ---------------------------------------------------------------------------------------------
  const audits = JSON.stringify(await prisma.auditLog.findMany({ where: { eventId: { in: events } } }));
  for (const action of ["INVOICE_SENT", "INVOICE_RESENT", "INVOICE_POSTED_TO_AR", "INVOICE_AR_POSTING_CORRECTED", "INVOICE_PAYMENT_RECORDED", "INVOICE_PAYMENT_VOIDED", "INVOICE_PAYMENT_INSTRUCTIONS_CHANGED"]) {
    assert(audits.includes(action), `${action} is audited`);
  }
  for (const secret of [...Object.values(EMAIL), "Tina Treasurer", "Sam Successor", "Carl Clerk", "Dana Director", "Dev Director"]) {
    assert(!audits.includes(secret), `no audit row holds ${secret.includes("@") ? "an email address" : secret}`);
  }

  // Deleting the actor keeps the names; deleting the event removes everything, including the stored PDFs.
  await prisma.user.delete({ where: { id: ids.clerk } });
  assert((await prisma.invoiceDelivery.findUniqueOrThrow({ where: { id: first.deliveryId } })).sentByUserId === null && (await prisma.invoiceDelivery.findUniqueOrThrow({ where: { id: first.deliveryId } })).sentByName === "Fran Finance", "deleting the sender keeps the name they sent under");
  assert((await prisma.invoicePayment.findUniqueOrThrow({ where: { id: p60.paymentId } })).recordedByUserId === null, "deleting the recorder clears the id and keeps the entry");
  await prisma.event.delete({ where: { id: ids.eventA } });
  assert((await prisma.invoiceDelivery.count({ where: { eventId: ids.eventA } })) === 0 && (await prisma.invoicePayment.count({ where: { eventId: ids.eventA } })) === 0 && (await prisma.invoiceArPosting.count({ where: { eventId: ids.eventA } })) === 0 && (await prisma.invoiceVersionDocument.count({ where: { eventId: ids.eventA } })) === 0 && (await prisma.messageAttachment.count({ where: { eventId: ids.eventA } })) === 0 && (await prisma.messageOutbox.count({ where: { eventId: ids.eventA } })) === 0, "deleting an event removes its deliveries, payments, postings, documents and attachments");

  console.log("Invoice delivery verified: one stored PDF per finalized version with a database-checked hash, sends with exact recipients and the same attachment on every resend, superseded versions refused, bounce and suppression recorded, AR postings and payments append-only with partial, void, overpaid and revised-invoice figures, statements scoped to the event, a formula-safe treasurer CSV, and audit without addresses.");
}

main()
  .then(async () => { await cleanup(); })
  .catch(async (error) => {
    console.error(error);
    await cleanup().catch(() => undefined);
    process.exitCode = 1;
  })
  .finally(async () => { await prisma.$disconnect(); });
