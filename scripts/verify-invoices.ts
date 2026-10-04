/**
 * Proves deferred-organization invoices (#167) against a real PostgreSQL database, where the unit
 * tests' in-memory stand-ins can't:
 *
 * - drafts come only from an APPROVED reconciliation that still matches the facts and with billing
 *   responsibility recorded (no approval, FACTS_CHANGED and unrecorded responsibility are refused),
 *   one draft per invoice group (a church with two clubs is one invoice; per-club grouping makes one per
 *   club), each tracing to the reconciliation version, snapshotting the contact, and a $0 group gets a $0 draft;
 *   creating drafts again changes nothing, parallel runs leave one draft per group, and regeneration
 *   replaces drafts only;
 * - finalizing needs an explicit confirmation, the Finalize invoices permission for an original, and a draft that is
 *   still current; numbers are <CODE><YY>-<NNNN> from a per-(event, code, year) counter, assigned exactly once
 *   under parallel requests (no duplicates, no gaps), a retry with the same key or another request for the
 *   same draft returns the same number, and a key cannot be reused for another invoice; each finalized
 *   version records one receivable for its amount;
 * - finalized versions are immutable (the database refuses a rewrite, a delete, a reopening, a number change, a
 *   counter rewrite, a receivable rewrite and an event-code change after numbers exist);
 * - a billing contact changed after finalization is shown as changed and revised by finance staff alone
 *   (-R1, the prior version SUPERSEDED with its receivable and fully readable), while a revision that changes an
 *   amount (an adjustment after finalization, re-approved) needs the permission;
 * - cross-event versions and invoices are refused, the invoice code locks with the first number and cannot clash
 *   with another event's series, the counter starts again each year, the permission grant is audited, and no audit
 *   row holds a contact's name or email;
 * - foreign-key actions still work: deleting the approver keeps the name they approved under, deleting the event
 *   removes its invoices.
 *
 * Uses fictitious rows it creates and removes itself.
 *
 *   npm run test:invoices
 */
import { loadEnvConfig } from "@next/env";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { assertLocalDatabase } from "./support/local-only-guard";
import { fillBlankSyntheticEnv } from "./support/synthetic-env";
import { prepareReconciliation, approveReconciliation, recordAttendanceCorrection } from "@/modules/attendance-reconciliation/repository";
import { resolveEventBillingResponsibility } from "@/modules/billing-responsibility/repository";
import {
  InvoiceError,
  createInvoiceDrafts,
  discardInvoiceDraft,
  finalizeInvoiceVersion,
  getInvoiceDetail,
  getInvoicesView,
  regenerateInvoiceDraft,
  reviseInvoice,
  setEventInvoiceCode,
} from "@/modules/invoices/repository";
import { addStaffMembership, updateStaffMembership } from "@/modules/access/membership-repository";
import { setHealthAccess } from "@/modules/coordinator-health/membership-grants";
import { InvoiceAccessGrantError, setInvoiceFinalizationAccess, stripInvoiceFinalizationAccess } from "@/modules/invoices/finalize-access";

loadEnvConfig(process.cwd());
// Local-only, before any Prisma client or connection exists.
assertLocalDatabase(process.env, "run this verification");
fillBlankSyntheticEnv("SECRET_ENCRYPTION_KEY", "verify-invoices-synthetic-key-not-a-secret");

const prisma = new PrismaClient();
const P = `iv167_${randomUUID().slice(0, 8)}`;
/** Letters only, unique per run: the number series are global per (code, year), so a real database never clashes. */
const letters = (seed: string, count: number) => [...seed.replace(/[^0-9a-f]/g, "").padEnd(count, "0")].slice(0, count).map((char) => String.fromCharCode(65 + parseInt(char, 16))).join("");
const hex = (n: number) => randomUUID().replace(/-/g, "").slice(n, n + 5);
const CODE_A = letters(hex(0), 5);
const CODE_B = letters(hex(8), 5);
const CODE_D_CLASH = CODE_A;
// Event C has no explicit code: its name's initials are its code (four random initials).
const initialsC = letters(hex(16), 4);
const NAME_C = [...initialsC].map((letter, index) => `${letter}${["ov", "ar", "il", "ex"][index]}`).join(" ");
const ids = {
  staff: `${P}_staff`,
  treasurer: `${P}_treasurer`,
  staff2: `${P}_staff2`,
  admin: `${P}_admin`,
  doomed: `${P}_doomed`,
  holder: `${P}_holder`,
  church1: `${P}_church_1`,
  church2: `${P}_church_2`,
  club1: `${P}_club_1`,
  club2: `${P}_club_2`,
  club3: `${P}_club_3`,
  eventA: `${P}_ev_a`,
  eventB: `${P}_ev_b`,
  eventC: `${P}_ev_c`,
  eventD: `${P}_ev_d`,
  eventF: `${P}_ev_f`,
};
const events = [ids.eventA, ids.eventB, ids.eventC, ids.eventD, ids.eventF];
const people = ["Ann", "Bo", "Cy", "Di", "Ed", "Flo"].map((name) => ({ id: `${P}_person_${name}`, name }));
const EMAIL = { first: `${P}.first@contact.test`, second: `${P}.second@contact.test`, third: `${P}.third@contact.test` };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

async function rejects(promise: Promise<unknown>) {
  return promise.then(() => false, () => true);
}

async function failure(promise: Promise<unknown>) {
  return promise.then(() => null, (error: unknown) => error);
}

function code(error: unknown) {
  return error instanceof InvoiceError ? error.code : error instanceof Error ? `other:${error.message.slice(0, 80)}` : "none";
}

async function cleanup() {
  await prisma.auditLog.deleteMany({ where: { OR: [{ eventId: { in: events } }, { actorUserId: { in: [ids.staff, ids.treasurer, ids.staff2, ids.admin, ids.doomed] } }] } });
  await prisma.publicRegistrationSubmission.deleteMany({ where: { eventId: { in: events } } });
  await prisma.event.deleteMany({ where: { id: { in: events } } });
  // A contact is never deleted by the application; this local cleanup turns the guard off for one transaction.
  await prisma.$transaction([
    prisma.$executeRawUnsafe('ALTER TABLE "OrganizationBillingContact" DISABLE TRIGGER "OrganizationBillingContact_no_delete"'),
    prisma.organizationBillingContact.deleteMany({ where: { organizationId: { in: [ids.church1, ids.church2] } } }),
    prisma.$executeRawUnsafe('ALTER TABLE "OrganizationBillingContact" ENABLE TRIGGER "OrganizationBillingContact_no_delete"'),
  ]);
  await prisma.organization.deleteMany({ where: { id: { in: [ids.club1, ids.club2, ids.club3] } } });
  await prisma.organization.deleteMany({ where: { id: { in: [ids.church1, ids.church2] } } });
  await prisma.person.deleteMany({ where: { id: { in: [ids.holder, ...people.map((entry) => entry.id)] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ids.staff, ids.treasurer, ids.staff2, ids.admin, ids.doomed] } } });
}

let counter = 0;
/** A club registration, or (club null) a group registration billed to a person. */
async function registration(eventId: string, formVersionId: string, club: string | null, names: string[]) {
  counter += 1;
  const created = await prisma.registration.create({
    data: {
      eventId,
      accountHolderPersonId: ids.holder,
      confirmationCode: `${P}-${counter}`,
      status: "CONFIRMED",
      totalAmount: ((names.length * 2500) / 100).toFixed(2),
      submittedAt: new Date("2027-03-01T10:00:00Z"),
    },
    select: { id: true },
  });
  if (club) await prisma.clubEventRegistration.create({ data: { eventId, organizationId: club, registrationId: created.id } });
  else await prisma.groupEventRegistration.create({ data: { eventId, registrationId: created.id, billingPersonId: ids.holder } });
  const attendees: Record<string, string> = {};
  for (const [position, name] of names.entries()) {
    const person = people.find((entry) => entry.name === name)!;
    const attendee = await prisma.registrationAttendee.create({
      data: {
        eventId,
        registrationId: created.id,
        personId: person.id,
        attendeeType: "YOUTH",
        position,
        profileSnapshot: { firstName: name, lastName: "Verify" },
        createdAt: new Date("2027-03-01T10:00:00Z"),
      },
      select: { id: true },
    });
    attendees[name] = attendee.id;
  }
  await prisma.publicRegistrationSubmission.create({
    data: {
      eventId,
      formVersionId,
      registrationId: created.id,
      idempotencyKey: `${P}-${counter}`,
      requestHash: `hash-${counter}`,
      responses: {},
      pricingSnapshot: { lineItems: names.map((_, index) => ({ key: `attendees.${index}.fee`, label: "Fee", amountCents: 2500, attendeeIndex: index })) },
    },
  });
  return { id: created.id, attendees };
}

const checkIn = (eventId: string, attendeeId: string) =>
  prisma.checkIn.create({ data: { eventId, registrationAttendeeId: attendeeId, idempotencyKey: `${P}-ci-${attendeeId}` } });

async function newEvent(id: string, name: string, startsAt: string, grouping: "PER_CHURCH" | "PER_CLUB") {
  await prisma.event.create({
    data: { id, slug: `${P}-${id.slice(-1)}`, name, startsAt: new Date(startsAt), endsAt: new Date(new Date(startsAt).getTime() + 2 * 86_400_000), audience: "CLUB", billingMode: "DEFERRED_ORGANIZATION_INVOICE", invoiceGrouping: grouping },
  });
  const form = await prisma.registrationForm.create({ data: { eventId: id, createdByUserId: ids.staff, name: "Synthetic form", slug: `${P}-form-${id.slice(-1)}` } });
  const version = await prisma.registrationFormVersion.create({ data: { formId: form.id, createdByUserId: ids.staff, versionNumber: 1, definition: { sections: [] } } });
  return version.id;
}

/** Records responsibility, prepares and approves a reconciliation: the basis an invoice is drafted from. */
async function approveReconciled(eventId: string, actorUserId = ids.staff) {
  await resolveEventBillingResponsibility(eventId, { apply: true, actorUserId });
  const prepared = await prepareReconciliation({ eventId, actorUserId });
  await approveReconciliation({ eventId, versionId: prepared.versionId, actorUserId });
  return prepared.versionId;
}

const finalize = (eventId: string, versionId: string, key: string, options: { canFinalize?: boolean; confirm?: boolean; actor?: string } = {}) =>
  finalizeInvoiceVersion({ eventId, versionId, actorUserId: options.actor ?? ids.treasurer, idempotencyKey: key, confirm: options.confirm ?? true, canFinalizeInvoices: options.canFinalize ?? true });

const key = (label: string) => `${label}-${P}-${randomUUID()}`;

async function main() {
  await cleanup();
  await prisma.user.createMany({ data: [
    { id: ids.staff, email: `${P}_staff@example.test`, displayName: "Fran Finance" },
    { id: ids.treasurer, email: `${P}_treasurer@example.test`, displayName: "Tess Treasurer" },
    { id: ids.admin, email: `${P}_admin@example.test`, displayName: "Ada Admin", globalRole: "SYSTEM_ADMIN" },
    { id: ids.doomed, email: `${P}_doomed@example.test`, displayName: "Dee Departing" },
    { id: ids.staff2, email: `${P}_staff2@example.test`, displayName: "Sue Staff" },
  ] });
  await prisma.person.createMany({ data: [
    { id: ids.holder, firstName: "Pat", lastName: "Holder", normalizedEmail: `${P}.holder@contact.test` },
    ...people.map((entry) => ({ id: entry.id, firstName: entry.name, lastName: "Verify" })),
  ] });
  await prisma.organization.createMany({ data: [
    { id: ids.church1, type: "CHURCH", name: `Invoice Check Church One ${P}`, normalizedName: `invoice check church one ${P}` },
    { id: ids.church2, type: "CHURCH", name: `Invoice Check Church Two ${P}`, normalizedName: `invoice check church two ${P}` },
  ] });
  await prisma.organization.createMany({ data: [
    { id: ids.club1, type: "CLUB", name: `Invoice Check Club 1 ${P}`, normalizedName: `invoice check club 1 ${P}`, parentOrganizationId: ids.church1 },
    { id: ids.club2, type: "CLUB", name: `Invoice Check Club 2 ${P}`, normalizedName: `invoice check club 2 ${P}`, parentOrganizationId: ids.church1 },
    { id: ids.club3, type: "CLUB", name: `Invoice Check Club 3 ${P}`, normalizedName: `invoice check club 3 ${P}`, parentOrganizationId: ids.church2 },
  ] });
  // Church 1 has a verified billing contact; church 2 has none yet.
  await prisma.organizationBillingContact.create({ data: { organizationId: ids.church1, name: "Tina Treasurer", email: EMAIL.first, roleLabel: "Treasurer", verifiedAt: new Date(), createdByUserId: ids.admin } });

  const formA = await newEvent(ids.eventA, "Verify Camporee A", "2027-04-01T12:00:00Z", "PER_CHURCH");
  const formB = await newEvent(ids.eventB, "Verify Camporee B", "2027-05-01T12:00:00Z", "PER_CLUB");
  // The explicit code is set by staff before the first number.
  const bad = await failure(setEventInvoiceCode({ eventId: ids.eventA, code: "S1", actorUserId: ids.staff }));
  assert(code(bad) === "CODE_INVALID", "an invoice code is letters only");
  await setEventInvoiceCode({ eventId: ids.eventA, code: CODE_A.toLowerCase(), actorUserId: ids.staff });
  assert((await prisma.event.findUniqueOrThrow({ where: { id: ids.eventA } })).invoiceCode === CODE_A, "the code is stored uppercase");

  // Event A, grouped per church: church 1 has clubs 1 and 2, church 2 has club 3.
  const r1 = await registration(ids.eventA, formA, ids.club1, ["Ann", "Bo", "Cy"]);
  const r2 = await registration(ids.eventA, formA, ids.club2, ["Di", "Ed"]);
  const r3 = await registration(ids.eventA, formA, ids.club3, ["Flo"]);
  for (const name of ["Ann", "Bo"]) await checkIn(ids.eventA, r1.attendees[name]!);
  for (const name of ["Di", "Ed"]) await checkIn(ids.eventA, r2.attendees[name]!);

  // No approved reconciliation: refused.
  await resolveEventBillingResponsibility(ids.eventA, { apply: true, actorUserId: ids.staff });
  assert(code(await failure(createInvoiceDrafts({ eventId: ids.eventA, actorUserId: ids.staff }))) === "NO_APPROVED_RECONCILIATION", "no approved reconciliation: refused");
  const draftOnly = await prepareReconciliation({ eventId: ids.eventA, actorUserId: ids.staff });
  assert(code(await failure(createInvoiceDrafts({ eventId: ids.eventA, actorUserId: ids.staff }))) === "NO_APPROVED_RECONCILIATION", "a reconciliation that is only a draft is not enough");
  assert((await prisma.invoice.count({ where: { eventId: ids.eventA } })) === 0, "a refused run writes nothing");
  await approveReconciliation({ eventId: ids.eventA, versionId: draftOnly.versionId, actorUserId: ids.staff });
  const recon1 = draftOnly.versionId;

  // Responsibility not recorded while the approval is still current: blockers refuse.
  await prisma.registrationBillingResponsibility.deleteMany({ where: { registrationId: r3.id } });
  const blocked = await failure(createInvoiceDrafts({ eventId: ids.eventA, actorUserId: ids.staff }));
  assert(code(blocked) === "RESPONSIBILITY_NOT_READY" && blocked instanceof InvoiceError && blocked.blockers.length === 1, "billing-responsibility blockers refuse drafting");
  await resolveEventBillingResponsibility(ids.eventA, { apply: true, actorUserId: ids.staff });

  // Drafts: one per group; a church with two clubs is one invoice.
  const run1 = await createInvoiceDrafts({ eventId: ids.eventA, actorUserId: ids.staff });
  assert(run1.created === 2 && run1.regenerated === 0 && run1.finalized === 0, "two invoice groups get a draft each");
  const invoices1 = await prisma.invoice.findMany({ where: { eventId: ids.eventA }, include: { versions: true } });
  const inv1 = invoices1.find((entry) => entry.groupKey === `organization:${ids.church1}`)!;
  const inv2 = invoices1.find((entry) => entry.groupKey === `organization:${ids.church2}`)!;
  assert(inv1 && inv2 && inv1.versions.length === 1 && inv2.versions.length === 1, "one invoice and one draft per group");
  const d1 = inv1.versions[0]!;
  const d2 = inv2.versions[0]!;
  assert(d1.status === "DRAFT" && d1.revision === 0 && d1.basis === "RECONCILIATION" && d1.reconciliationVersionId === recon1, "the draft traces to the approved reconciliation");
  assert(d1.amountDueCents === 10000 && d1.billableCount === 4 && d1.registeredCount === 5, "church 1: four attended at $25, two clubs on one invoice");
  const snap1 = d1.snapshot as { lines: Array<{ label: string; amountCents: number; people: unknown[] }>; totals: { amountDueCents: number } };
  assert(snap1.lines.length === 2 && snap1.lines.every((line) => line.amountCents === 5000) && snap1.totals.amountDueCents === 10000, "the snapshot has a line per club and the total");
  assert(d1.contactName === "Tina Treasurer" && d1.contactEmail === EMAIL.first && d1.contactVerified, "the draft snapshots the billing contact");
  assert(d2.amountDueCents === 0 && d2.billableCount === 0 && d2.contactName === null, "a group nobody attended gets a $0 draft (and has no contact yet)");

  // Repeating changes nothing; parallel runs leave one draft per group.
  const run2 = await createInvoiceDrafts({ eventId: ids.eventA, actorUserId: ids.staff });
  assert(run2.created === 0 && run2.unchanged === 2 && run2.regenerated === 0, "creating drafts again changes nothing");
  const racing = await Promise.allSettled(Array.from({ length: 4 }, () => createInvoiceDrafts({ eventId: ids.eventA, actorUserId: ids.staff })));
  assert(racing.every((outcome) => outcome.status === "fulfilled"), "parallel draft runs all succeed");
  assert((await prisma.invoice.count({ where: { eventId: ids.eventA } })) === 2 && (await prisma.invoiceVersion.count({ where: { eventId: ids.eventA } })) === 2, "parallel draft runs leave one draft per group");

  // A group with no billing contact cannot be finalized until one exists and the draft is regenerated.
  assert(code(await failure(finalize(ids.eventA, d2.id, key("nocontact")))) === "CONTACT_MISSING", "no billing contact: finalization refused");
  await prisma.organizationBillingContact.create({ data: { organizationId: ids.church2, name: "Carl Clerk", email: EMAIL.third, roleLabel: "Clerk", createdByUserId: ids.admin } });
  assert(code(await failure(finalize(ids.eventA, d2.id, key("nocontact")))) === "CONTACT_MISSING", "the draft still lacks the contact until regenerated");
  await regenerateInvoiceDraft({ eventId: ids.eventA, invoiceId: inv2.id, actorUserId: ids.staff });
  const d2b = await prisma.invoiceVersion.findUniqueOrThrow({ where: { id: d2.id } });
  assert(d2b.contactName === "Carl Clerk" && d2b.regenerationCount === 1 && d2b.regeneratedAt !== null, "regeneration replaces the draft with the current contact");

  // Facts change after approval: drafting and finalizing are refused (FACTS_CHANGED).
  await checkIn(ids.eventA, r1.attendees.Cy!);
  assert(code(await failure(createInvoiceDrafts({ eventId: ids.eventA, actorUserId: ids.staff }))) === "FACTS_CHANGED", "drafting from an approval whose facts changed is refused");
  assert(code(await failure(finalize(ids.eventA, d1.id, key("stale")))) === "FACTS_CHANGED", "finalizing from an approval whose facts changed is refused");
  assert(code(await failure(regenerateInvoiceDraft({ eventId: ids.eventA, invoiceId: inv1.id, actorUserId: ids.staff }))) === "FACTS_CHANGED", "regenerating from such an approval is refused");
  // Approve again: the old draft points at a superseded approval.
  const recon2 = await approveReconciled(ids.eventA);
  assert(code(await failure(finalize(ids.eventA, d1.id, key("old")))) === "DRAFT_STALE", "a draft built on an older approval cannot be finalized");
  const run3 = await createInvoiceDrafts({ eventId: ids.eventA, actorUserId: ids.staff });
  assert(run3.regenerated === 2 && run3.created === 0, "drafts are refreshed from the new approval");
  const d1c = await prisma.invoiceVersion.findUniqueOrThrow({ where: { id: d1.id } });
  assert(d1c.reconciliationVersionId === recon2 && d1c.amountDueCents === 12500 && d1c.billableCount === 5, "the refreshed draft bills Cy: $125");

  // Finalizing: explicit confirmation, the permission, the right event.
  assert(code(await failure(finalize(ids.eventA, d1.id, key("c"), { confirm: false }))) === "CONFIRMATION_REQUIRED", "finalizing needs an explicit confirmation");
  assert(code(await failure(finalize(ids.eventA, d1.id, key("p"), { canFinalize: false, actor: ids.staff }))) === "FINALIZE_PERMISSION_REQUIRED", "an original invoice needs the Finalize invoices permission");
  assert(code(await failure(finalize(ids.eventB, d1.id, key("x")))) === "VERSION_NOT_FOUND", "another event's version is refused");
  assert((await prisma.invoiceVersion.findUniqueOrThrow({ where: { id: d1.id } })).status === "DRAFT" && (await prisma.invoiceNumberCounter.count({ where: { eventId: ids.eventA } })) === 0, "refused finalizations change nothing and use no number");

  // Parallel finalization: both groups at once, church 1 five times with different keys.
  const k1 = Array.from({ length: 5 }, (_, index) => key(`k1-${index}`));
  const k2 = key("k2");
  const settled = await Promise.allSettled([...k1.map((entry) => finalize(ids.eventA, d1.id, entry)), finalize(ids.eventA, d2.id, k2)]);
  assert(settled.every((outcome) => outcome.status === "fulfilled"), "every parallel finalization ends finalized");
  const results = settled.map((outcome) => (outcome as PromiseFulfilledResult<Awaited<ReturnType<typeof finalize>>>).value);
  const church1Results = results.slice(0, 5);
  const church2Result = results[5]!;
  const numbersOf = new Set(church1Results.map((entry) => entry.number));
  assert(numbersOf.size === 1 && church1Results.filter((entry) => entry.changed).length === 1, "five requests for one draft: one number, finalized once");
  const sequence = [...numbersOf, church2Result.number].sort();
  assert(sequence.join() === `${CODE_A}27-0001,${CODE_A}27-0002`, "two invoices take 0001 and 0002: no duplicate, no gap");
  assert((await prisma.invoiceNumberCounter.findMany({ where: { eventId: ids.eventA } })).map((row) => `${row.code}|${row.year}|${row.lastNumber}`).join() === `${CODE_A}|2027|2`, "the counter for the event, code and year is at 2");
  const number1 = church1Results[0]!.number;
  const number2 = church2Result.number;
  // A retry with the same key returns the same number.
  const winningKey = (await prisma.invoiceVersion.findUniqueOrThrow({ where: { id: d1.id } })).finalizeIdempotencyKey!;
  assert(k1.includes(winningKey), "the winning request's key is the one recorded");
  const retry = await finalize(ids.eventA, d1.id, winningKey);
  assert(!retry.changed && retry.number === number1, "a retry with the same key returns the same number");
  const loserRetry = await finalize(ids.eventA, d1.id, k1.find((entry) => entry !== winningKey)!);
  assert(!loserRetry.changed && loserRetry.number === number1, "a request that lost the race, retried, still gets the same number");
  assert(code(await failure(finalize(ids.eventA, d2.id, winningKey))) === "IDEMPOTENCY_KEY_REUSED", "a key cannot be reused for another invoice");
  const finalized1 = await prisma.invoiceVersion.findUniqueOrThrow({ where: { id: d1.id }, include: { receivable: true, invoice: true } });
  assert(finalized1.status === "FINALIZED" && finalized1.number === number1 && finalized1.invoice.baseNumber === number1 && finalized1.finalizedByUserId === ids.treasurer && finalized1.finalizedByName === "Tess Treasurer" && finalized1.finalizedAt !== null, "the approver and the number are recorded");
  assert(finalized1.receivable?.amountCents === 12500 && finalized1.receivable.status === "OPEN", "one open receivable for the version's amount");
  assert((await prisma.invoiceReceivable.count({ where: { invoiceId: inv1.id } })) === 1, "the receivable is created once");
  const zero = await prisma.invoiceVersion.findUniqueOrThrow({ where: { id: d2.id }, include: { receivable: true } });
  assert(zero.status === "FINALIZED" && zero.amountDueCents === 0 && zero.receivable?.amountCents === 0, "a $0 invoice can be finalized, with a $0 receivable");
  assert((await prisma.auditLog.count({ where: { eventId: ids.eventA, action: "INVOICE_FINALIZED" } })) === 2, "each finalization is audited once");

  // Finalized versions are immutable; numbers and counters cannot be rewritten.
  assert(await rejects(prisma.invoiceVersion.update({ where: { id: d1.id }, data: { amountDueCents: 1 } })), "a finalized amount cannot be rewritten");
  assert(await rejects(prisma.invoiceVersion.update({ where: { id: d1.id }, data: { snapshot: {} } })), "a finalized snapshot cannot be rewritten");
  assert(await rejects(prisma.invoiceVersion.update({ where: { id: d1.id }, data: { contactEmail: "other@contact.test" } })), "a finalized contact cannot be rewritten");
  assert(await rejects(prisma.invoiceVersion.update({ where: { id: d1.id }, data: { number: `${CODE_A}27-0099` } })), "a finalized number cannot be changed");
  assert(await rejects(prisma.invoiceVersion.update({ where: { id: d1.id }, data: { status: "DRAFT", number: null, finalizedAt: null, finalizedByName: null, finalizeIdempotencyKey: null } })), "a finalized version cannot be reopened");
  assert(await rejects(prisma.invoiceVersion.updateMany({ where: { id: d1.id }, data: { regenerationCount: 9, regeneratedAt: new Date() } })), "a finalized version cannot be regenerated");
  assert(await rejects(prisma.invoiceVersion.deleteMany({ where: { id: d1.id } })), "a finalized version cannot be deleted");
  assert(await rejects(prisma.invoice.update({ where: { id: inv1.id }, data: { baseNumber: `${CODE_A}27-0099`, numberSequence: 99 } })), "an invoice number cannot be changed");
  assert(await rejects(prisma.invoice.deleteMany({ where: { id: inv1.id } })), "an invoice cannot be deleted");
  assert(await rejects(prisma.invoiceNumberCounter.updateMany({ where: { eventId: ids.eventA }, data: { lastNumber: 10 } })), "the counter cannot jump");
  assert(await rejects(prisma.invoiceNumberCounter.updateMany({ where: { eventId: ids.eventA }, data: { lastNumber: 1 } })), "the counter cannot go back");
  assert(await rejects(prisma.invoiceNumberCounter.deleteMany({ where: { eventId: ids.eventA } })), "the counter cannot be deleted");
  assert(await rejects(prisma.invoiceReceivable.updateMany({ where: { invoiceVersionId: d1.id }, data: { amountCents: 1 } })), "a receivable amount cannot be rewritten");
  assert(await rejects(prisma.invoiceReceivable.deleteMany({ where: { invoiceVersionId: d1.id } })), "a receivable cannot be deleted");
  assert(await rejects(prisma.invoiceReceivable.create({ data: { eventId: ids.eventA, invoiceId: inv1.id, invoiceVersionId: d1.id, amountCents: 12500 } })), "a version has one receivable");
  assert(await rejects(prisma.event.update({ where: { id: ids.eventA }, data: { invoiceCode: "ZZ" } })), "the event's invoice code is locked once numbers exist");
  assert(code(await failure(setEventInvoiceCode({ eventId: ids.eventA, code: "ZZ", actorUserId: ids.staff }))) === "CODE_LOCKED", "staff cannot change the code after the first number");
  assert(await rejects(prisma.invoiceVersion.create({ data: { invoiceId: inv1.id, eventId: ids.eventA, revision: 5, supersedesVersionId: d1.id, basis: "RECONCILIATION", reconciliationVersionId: recon2, status: "FINALIZED", number: `${CODE_A}27-0050`, groupTitle: "x", organizationName: "x", registeredCount: 0, billableCount: 0, amountDueCents: 0, amountsFingerprint: "x", snapshot: {} } })), "a version cannot be created already finalized");
  // A receivable must match a finalized version and its amount.
  const spare = await prisma.invoiceVersion.findUniqueOrThrow({ where: { id: d2.id } });
  assert(await rejects(prisma.invoiceReceivable.create({ data: { eventId: ids.eventA, invoiceId: inv2.id, invoiceVersionId: spare.id, amountCents: 5 } })), "a receivable must equal the version's amount");

  // Contact unchanged: a contact-only revision has nothing to do.
  assert(code(await failure(reviseInvoice({ eventId: ids.eventA, invoiceId: inv1.id, mode: "CONTACT_ONLY", reason: "Check", actorUserId: ids.staff }))) === "NO_CHANGE", "a contact-only revision needs a changed contact");
  assert(code(await failure(reviseInvoice({ eventId: ids.eventA, invoiceId: inv1.id, mode: "FROM_RECONCILIATION", reason: "Check", actorUserId: ids.staff }))) === "NO_CHANGE", "nothing changed: no revision from the reconciliation either");

  // The billing contact changes after finalization.
  const viewBefore = await getInvoicesView(ids.eventA);
  assert(viewBefore.isDeferred && viewBefore.invoices.every((row) => !row.contactChanged), "no contact change is flagged yet");
  await prisma.organizationBillingContact.updateMany({ where: { organizationId: ids.church1, effectiveTo: null }, data: { effectiveTo: new Date() } });
  await prisma.organizationBillingContact.create({ data: { organizationId: ids.church1, name: "Sam Successor", email: EMAIL.second, roleLabel: "Treasurer", verifiedAt: new Date(), createdByUserId: ids.admin } });
  const viewAfter = await getInvoicesView(ids.eventA);
  const rowAfter = viewAfter.isDeferred ? viewAfter.invoices.find((row) => row.invoiceId === inv1.id) : undefined;
  assert(rowAfter?.contactChanged === true && rowAfter.current.contact?.name === "Tina Treasurer" && rowAfter.current.status === "FINALIZED", "the finalized snapshot keeps the old contact and the screen says it changed");
  const detailBefore = await getInvoiceDetail(ids.eventA, inv1.id);
  assert(detailBefore?.contactChanged === true && detailBefore.currentContact?.name === "Sam Successor", "the detail names the new contact");
  assert((await getInvoiceDetail(ids.eventB, inv1.id)) === null, "another event cannot read the invoice");
  const rev1 = await reviseInvoice({ eventId: ids.eventA, invoiceId: inv1.id, mode: "CONTACT_ONLY", reason: "New treasurer", actorUserId: ids.staff });
  assert(rev1.revision === 1, "a contact-only revision is revision 1");
  assert(code(await failure(reviseInvoice({ eventId: ids.eventA, invoiceId: inv1.id, mode: "CONTACT_ONLY", reason: "again", actorUserId: ids.staff }))) === "DRAFT_EXISTS", "one open revision at a time");
  const revRow = await prisma.invoiceVersion.findUniqueOrThrow({ where: { id: rev1.versionId } });
  assert(revRow.status === "DRAFT" && revRow.basis === "CONTACT_ONLY_COPY" && revRow.supersedesVersionId === d1.id && revRow.contactName === "Sam Successor" && revRow.amountsFingerprint === finalized1.amountsFingerprint && revRow.amountDueCents === 12500, "the revision copies the amounts and carries the new contact");
  // Finance staff (no Finalize invoices permission) can finalize a contact-only revision, concurrently still once.
  const revSettled = await Promise.allSettled(Array.from({ length: 4 }, (_, index) => finalize(ids.eventA, rev1.versionId, key(`rev-${index}`), { canFinalize: false, actor: ids.staff })));
  assert(revSettled.every((outcome) => outcome.status === "fulfilled"), "finance staff can finalize a contact-only revision");
  const revNumbers = new Set(revSettled.map((outcome) => (outcome as PromiseFulfilledResult<Awaited<ReturnType<typeof finalize>>>).value.number));
  assert(revNumbers.size === 1 && [...revNumbers][0] === `${number1}-R1`, "the revision keeps the base number with -R1");
  const afterRev = await prisma.invoiceVersion.findMany({ where: { invoiceId: inv1.id }, orderBy: { revision: "asc" }, include: { receivable: true } });
  assert(afterRev.map((row) => row.status).join() === "SUPERSEDED,FINALIZED" && afterRev[0]!.supersededByVersionId === rev1.versionId && afterRev[0]!.supersededAt !== null, "finalizing the revision supersedes the prior version");
  assert(afterRev[0]!.receivable?.status === "SUPERSEDED" && afterRev[1]!.receivable?.status === "OPEN" && afterRev[1]!.receivable.amountCents === 12500, "its receivable is superseded and the revision's is open");
  assert(afterRev[0]!.contactName === "Tina Treasurer" && afterRev[0]!.number === number1 && afterRev[0]!.amountDueCents === 12500, "the prior version stays fully readable");
  assert((await prisma.invoiceNumberCounter.findFirstOrThrow({ where: { eventId: ids.eventA } })).lastNumber === 2, "a revision takes no new number from the counter");
  assert(await rejects(prisma.invoiceVersion.update({ where: { id: d1.id }, data: { amountDueCents: 5 } })), "a superseded version is still immutable");
  assert(await rejects(prisma.invoiceVersion.update({ where: { id: d1.id }, data: { status: "FINALIZED", supersededAt: null, supersededByVersionId: null } })), "a superseded version cannot be reinstated");

  // An adjustment after finalization: attendance corrected, reconciliation re-approved, then revised.
  await recordAttendanceCorrection({ eventId: ids.eventA, attendeeId: r3.attendees.Flo!, kind: "MARK_ATTENDED", reason: "Missed at the desk", actorUserId: ids.staff });
  assert(code(await failure(reviseInvoice({ eventId: ids.eventA, invoiceId: inv2.id, mode: "FROM_RECONCILIATION", reason: "Flo came", actorUserId: ids.staff }))) === "FACTS_CHANGED", "a revision from an approval whose facts changed is refused");
  const recon3 = await approveReconciled(ids.eventA);
  const run4 = await createInvoiceDrafts({ eventId: ids.eventA, actorUserId: ids.staff });
  assert(run4.finalized === 2 && run4.needRevision === 1 && run4.created === 0 && run4.regenerated === 0, "finalized invoices are not touched; the one that no longer matches is flagged");
  const staleView = await getInvoicesView(ids.eventA);
  assert(staleView.isDeferred && staleView.invoices.find((row) => row.invoiceId === inv2.id)?.amountsOutOfDate === true && staleView.invoices.find((row) => row.invoiceId === inv1.id)?.amountsOutOfDate === false, "the screen offers a revision where the amounts moved");
  const rev2 = await reviseInvoice({ eventId: ids.eventA, invoiceId: inv2.id, mode: "FROM_RECONCILIATION", reason: "Flo attended; corrected at the desk", actorUserId: ids.staff });
  const rev2Row = await prisma.invoiceVersion.findUniqueOrThrow({ where: { id: rev2.versionId } });
  assert(rev2Row.basis === "RECONCILIATION" && rev2Row.reconciliationVersionId === recon3 && rev2Row.amountDueCents === 2500 && rev2Row.supersedesVersionId === d2.id && rev2Row.revision === 1, "the revision is rebuilt from the new approval: $25");
  assert(code(await failure(finalize(ids.eventA, rev2.versionId, key("noperm"), { canFinalize: false, actor: ids.staff }))) === "FINALIZE_PERMISSION_REQUIRED", "a revision that changes an amount needs the permission");
  assert((await prisma.invoiceVersion.findUniqueOrThrow({ where: { id: d2.id } })).status === "FINALIZED", "the refused revision changed nothing");
  const rev2Settled = await Promise.allSettled(Array.from({ length: 4 }, (_, index) => finalize(ids.eventA, rev2.versionId, key(`r2-${index}`))));
  assert(rev2Settled.every((outcome) => outcome.status === "fulfilled"), "the amount-changing revision finalizes with the permission");
  const rev2Numbers = new Set(rev2Settled.map((outcome) => (outcome as PromiseFulfilledResult<Awaited<ReturnType<typeof finalize>>>).value.number));
  assert(rev2Numbers.size === 1 && [...rev2Numbers][0] === `${number2}-R1`, "its number is the base plus -R1");
  assert((await prisma.invoiceReceivable.findMany({ where: { invoiceId: inv2.id }, orderBy: { createdAt: "asc" } })).map((row) => `${row.status}:${row.amountCents}`).join() === "SUPERSEDED:0,OPEN:2500", "receivables: the old one superseded, the new one open");
  const stale2 = await failure(finalize(ids.eventA, rev2.versionId, key("again"), { actor: ids.staff, canFinalize: false }));
  assert(stale2 === null, "finalizing an already finalized revision returns its number again");

  // The invoice view reflects statuses.
  const finalView = await getInvoicesView(ids.eventA);
  assert(finalView.isDeferred && finalView.totals.finalizedCount === 2 && finalView.totals.finalizedCents === 12500 + 2500 && finalView.code.locked && finalView.code.explicit === CODE_A, "the view totals the live finalized versions");
  const detail = await getInvoiceDetail(ids.eventA, inv1.id, {});
  assert(detail !== null && detail.versions.length === 2 && detail.versions[0]!.number === `${number1}-R1` && detail.versions[1]!.status === "SUPERSEDED" && detail.change?.contactChanged === true && detail.change.amountsChanged === false, "the detail shows the version history and what the revision changed");

  // PER_CLUB grouping: one invoice per club, each to the church's contact; numbers per event.
  await setEventInvoiceCode({ eventId: ids.eventB, code: CODE_B, actorUserId: ids.staff });
  const b1 = await registration(ids.eventB, formB, ids.club1, ["Ann", "Bo"]);
  const b2 = await registration(ids.eventB, formB, ids.club2, ["Di"]);
  for (const entry of [b1.attendees.Ann!, b1.attendees.Bo!, b2.attendees.Di!]) await checkIn(ids.eventB, entry);
  await approveReconciled(ids.eventB);
  const runB = await createInvoiceDrafts({ eventId: ids.eventB, actorUserId: ids.staff });
  assert(runB.created === 2, "per-club grouping: one invoice per club");
  assert(code(await failure(reviseInvoice({ eventId: ids.eventB, invoiceId: inv1.id, mode: "CONTACT_ONLY", reason: "x", actorUserId: ids.staff }))) === "INVOICE_NOT_FOUND", "another event's invoice is refused");
  assert(code(await failure(regenerateInvoiceDraft({ eventId: ids.eventB, invoiceId: inv1.id, actorUserId: ids.staff }))) === "INVOICE_NOT_FOUND", "another event's invoice cannot be regenerated");
  const invoicesB = await prisma.invoice.findMany({ where: { eventId: ids.eventB }, include: { versions: true }, orderBy: { groupKey: "asc" } });
  assert(invoicesB.every((entry) => entry.invoiceGrouping === "PER_CLUB" && entry.clubId !== null && entry.versions[0]!.contactName === "Sam Successor"), "each club invoice goes to the church's current contact");
  assert(invoicesB.map((entry) => entry.versions[0]!.amountDueCents).sort((a, b) => a - b).join() === "2500,5000", "club amounts: $50 and $25");
  const bNumbers = [];
  for (const entry of invoicesB) bNumbers.push((await finalize(ids.eventB, entry.versions[0]!.id, key("b"))).number);
  assert(bNumbers.sort().join() === `${CODE_B}27-0001,${CODE_B}27-0002`, "event B counts from 0001 under its own code");
  // Changing the grouping after numbers were issued conflicts.
  await prisma.event.update({ where: { id: ids.eventB }, data: { invoiceGrouping: "PER_CHURCH" } });
  await approveReconciled(ids.eventB);
  assert(code(await failure(createInvoiceDrafts({ eventId: ids.eventB, actorUserId: ids.staff }))) === "GROUPING_CONFLICT", "drafting under a different grouping than the finalized invoices is refused");

  // The code of another event's series cannot be reused; a derived code is frozen and the counter restarts each year.
  await newEvent(ids.eventD, "Verify Other D", "2027-06-01T12:00:00Z", "PER_CHURCH");
  assert(code(await failure(setEventInvoiceCode({ eventId: ids.eventD, code: CODE_D_CLASH, actorUserId: ids.staff }))) === "CODE_IN_USE", "another event's code and year cannot be taken");
  const formC = await newEvent(ids.eventC, NAME_C, "2027-07-01T12:00:00Z", "PER_CHURCH");
  const c1 = await registration(ids.eventC, formC, ids.club1, ["Ann"]);
  const c3 = await registration(ids.eventC, formC, ids.club3, ["Flo"]);
  await checkIn(ids.eventC, c1.attendees.Ann!);
  await checkIn(ids.eventC, c3.attendees.Flo!);
  await approveReconciled(ids.eventC);
  await createInvoiceDrafts({ eventId: ids.eventC, actorUserId: ids.staff });
  const invoicesC = await prisma.invoice.findMany({ where: { eventId: ids.eventC }, include: { versions: true }, orderBy: { groupKey: "asc" } });
  assert(invoicesC.length === 2, "event C has two church invoices");
  const firstC = await finalize(ids.eventC, invoicesC[0]!.versions[0]!.id, key("c1"));
  assert(firstC.number === `${initialsC}27-0001`, `with no explicit code the number uses the event name's initials (${initialsC})`);
  assert((await prisma.event.findUniqueOrThrow({ where: { id: ids.eventC } })).invoiceCode === initialsC, "the derived code is frozen on the event with the first number");
  await prisma.event.update({ where: { id: ids.eventC }, data: { name: "Renamed Entirely", startsAt: new Date("2028-07-01T12:00:00Z") } });
  const secondC = await finalize(ids.eventC, invoicesC[1]!.versions[0]!.id, key("c2"));
  assert(secondC.number === `${initialsC}28-0001`, "a renamed event keeps its code, and the counter starts again for the new year");
  assert((await prisma.invoiceNumberCounter.count({ where: { eventId: ids.eventC } })) === 2, "one counter per code and year");

  // Grouping changed before the first finalization: a person-billed group has the same key under both groupings,
  // so its un-numbered invoice is reused and follows the current grouping (it must not be stuck on the old one).
  const formF = await newEvent(ids.eventF, "Verify Group F", "2029-03-01T12:00:00Z", "PER_CHURCH");
  const CODE_F = letters(hex(24), 5);
  await setEventInvoiceCode({ eventId: ids.eventF, code: CODE_F, actorUserId: ids.staff });
  const f1 = await registration(ids.eventF, formF, null, ["Ann", "Bo"]);
  for (const entry of [f1.attendees.Ann!, f1.attendees.Bo!]) await checkIn(ids.eventF, entry);
  await approveReconciled(ids.eventF);
  assert((await createInvoiceDrafts({ eventId: ids.eventF, actorUserId: ids.staff })).created === 1, "a group registration billed to a person gets a draft");
  const invF = await prisma.invoice.findFirstOrThrow({ where: { eventId: ids.eventF }, include: { versions: true } });
  assert(invF.groupKey === `person:${ids.holder}` && invF.invoiceGrouping === "PER_CHURCH" && invF.versions[0]!.contactEmail === `${P}.holder@contact.test`, "the person's group key is the same under either grouping");
  // Discard: the draft leaves the screens and counts; drafting again makes a fresh one; discarded rows are never reopened.
  const discarded = await discardInvoiceDraft({ eventId: ids.eventF, invoiceId: invF.id, actorUserId: ids.staff });
  const hiddenView = await getInvoicesView(ids.eventF);
  assert(hiddenView.isDeferred && hiddenView.invoices.length === 0 && hiddenView.totals.draftCount === 0 && hiddenView.groupsWithoutInvoice.length === 1, "a discarded draft is hidden and its group is not drafted");
  assert((await getInvoiceDetail(ids.eventF, invF.id)) === null, "an invoice with only discarded drafts is not shown");
  assert(code(await failure(discardInvoiceDraft({ eventId: ids.eventF, invoiceId: invF.id, actorUserId: ids.staff }))) === "NOT_A_DRAFT", "nothing left to discard");
  assert(code(await failure(finalize(ids.eventF, discarded.versionId, key("disc")))) === "NOT_A_DRAFT", "a discarded draft cannot be finalized");
  assert(code(await failure(discardInvoiceDraft({ eventId: ids.eventA, invoiceId: invF.id, actorUserId: ids.staff }))) === "INVOICE_NOT_FOUND", "another event's draft cannot be discarded");
  assert(await rejects(prisma.invoiceVersion.update({ where: { id: discarded.versionId }, data: { status: "DRAFT", discardedAt: null } })), "a discarded draft cannot be reopened");
  assert(await rejects(prisma.invoiceVersion.update({ where: { id: discarded.versionId }, data: { amountDueCents: 1 } })), "a discarded draft cannot be rewritten");
  assert((await createInvoiceDrafts({ eventId: ids.eventF, actorUserId: ids.staff })).created === 1, "drafting again makes a fresh draft for the same invoice");
  assert((await prisma.invoiceVersion.findMany({ where: { invoiceId: invF.id } })).map((row) => row.status).sort().join() === "DISCARDED,DRAFT", "the discarded draft stays on record beside the new one");
  // The grouping setting changes and the reconciliation is approved again.
  await prisma.event.update({ where: { id: ids.eventF }, data: { invoiceGrouping: "PER_CLUB" } });
  await approveReconciled(ids.eventF);
  const staleDraft = await prisma.invoiceVersion.findFirstOrThrow({ where: { invoiceId: invF.id, status: "DRAFT" } });
  assert(code(await failure(finalize(ids.eventF, staleDraft.id, key("f-stale")))) === "DRAFT_STALE", "a draft made under the old grouping cannot be finalized");
  const reGrouped = await createInvoiceDrafts({ eventId: ids.eventF, actorUserId: ids.staff });
  assert(reGrouped.regenerated === 1 && reGrouped.created === 0, "drafting under the new grouping refreshes the draft instead of conflicting");
  assert((await prisma.invoice.findUniqueOrThrow({ where: { id: invF.id } })).invoiceGrouping === "PER_CLUB", "the un-numbered invoice follows the current grouping");
  const fNumber = await finalize(ids.eventF, staleDraft.id, key("f1"));
  assert(fNumber.number === `${CODE_F}29-0001`, "the regrouped invoice finalizes");
  assert((await createInvoiceDrafts({ eventId: ids.eventF, actorUserId: ids.staff })).finalized === 1, "creating drafts again after finalizing does not conflict");
  // An adjustment after finalization is revised under the same grouping; a revision draft can be discarded and started again.
  await recordAttendanceCorrection({ eventId: ids.eventF, attendeeId: f1.attendees.Bo!, kind: "MARK_NOT_ATTENDED", reason: "Went home sick", actorUserId: ids.staff });
  await approveReconciled(ids.eventF);
  const fRev = await reviseInvoice({ eventId: ids.eventF, invoiceId: invF.id, mode: "FROM_RECONCILIATION", reason: "Bo did not attend", actorUserId: ids.staff });
  await discardInvoiceDraft({ eventId: ids.eventF, invoiceId: invF.id, actorUserId: ids.staff });
  assert((await prisma.invoiceVersion.findUniqueOrThrow({ where: { id: fNumber.versionId } })).status === "FINALIZED", "discarding a revision draft leaves the finalized invoice as it was");
  const fRev2 = await reviseInvoice({ eventId: ids.eventF, invoiceId: invF.id, mode: "FROM_RECONCILIATION", reason: "Bo did not attend", actorUserId: ids.staff });
  assert(fRev2.revision === fRev.revision && fRev2.versionId !== fRev.versionId, "a discarded revision frees its revision number");
  const fRevDone = await finalize(ids.eventF, fRev2.versionId, key("f2"));
  assert(fRevDone.number === `${fNumber.number}-R1` && fRevDone.amountDueCents === 2500, "the revision after the regrouping finalizes as -R1 for $25");
  assert((await createInvoiceDrafts({ eventId: ids.eventF, actorUserId: ids.staff })).finalized === 1, "and drafting again still does not conflict");

  // Permission grants: a role without finance access cannot be granted it; concurrent grants and strips of two
  // permissions on one membership never resurrect what was removed; the full membership edit paths strip both.
  const lowMembership = await prisma.eventMembership.create({ data: { eventId: ids.eventA, userId: ids.staff2, role: "READ_ONLY_STAFF", permissions: [] } });
  const lacking = await failure(setInvoiceFinalizationAccess(ids.eventA, lowMembership.id, ids.admin, true));
  assert(lacking instanceof InvoiceAccessGrantError && lacking.code === "ROLE_LACKS_FINANCE", "a role without finance access cannot be granted finalization");
  await prisma.eventMembership.update({ where: { id: lowMembership.id }, data: { role: "FINANCE_MANAGER", permissions: ["VIEW_HEALTH_INFORMATION", "FINALIZE_INVOICES"] } });
  for (let round = 0; round < 8; round += 1) {
    await prisma.eventMembership.update({ where: { id: lowMembership.id }, data: { permissions: ["VIEW_HEALTH_INFORMATION", "FINALIZE_INVOICES"] } });
    await Promise.all([
      prisma.$transaction(async (tx) => {
        const current = await tx.eventMembership.findUniqueOrThrow({ where: { id: lowMembership.id } });
        await stripInvoiceFinalizationAccess(tx, current, ids.admin, "ROLE_CHANGED");
      }),
      setHealthAccess(ids.eventA, lowMembership.id, ids.admin, false),
    ]);
    assert((await prisma.eventMembership.findUniqueOrThrow({ where: { id: lowMembership.id } })).permissions.length === 0, "a health revoke and a finalization strip at once leave neither permission");
  }
  await prisma.eventMembership.update({ where: { id: lowMembership.id }, data: { permissions: ["VIEW_HEALTH_INFORMATION", "FINALIZE_INVOICES"] } });
  await updateStaffMembership(ids.eventA, lowMembership.id, ids.admin, { role: "READ_ONLY_STAFF", status: "ACTIVE" });
  assert((await prisma.eventMembership.findUniqueOrThrow({ where: { id: lowMembership.id } })).permissions.length === 0, "changing the role removes both permissions");
  await prisma.eventMembership.update({ where: { id: lowMembership.id }, data: { role: "FINANCE_MANAGER", status: "INACTIVE", permissions: ["VIEW_HEALTH_INFORMATION", "FINALIZE_INVOICES"] } });
  await addStaffMembership(ids.eventA, ids.admin, { email: `${P}_staff2@example.test`, displayName: "Sue Staff", role: "FINANCE_MANAGER" });
  const readded = await prisma.eventMembership.findUniqueOrThrow({ where: { id: lowMembership.id } });
  assert(readded.status === "ACTIVE" && readded.permissions.length === 0, "adding the person again removes both permissions");
  const revokeAudits = await prisma.auditLog.findMany({ where: { eventId: ids.eventA, entityId: lowMembership.id, action: { in: ["INVOICE_FINALIZATION_ACCESS_REVOKED", "HEALTH_ACCESS_REVOKED"] } } });
  assert(revokeAudits.some((entry) => entry.action === "INVOICE_FINALIZATION_ACCESS_REVOKED") && revokeAudits.some((entry) => entry.action === "HEALTH_ACCESS_REVOKED"), "both removals are audited");

  // The Finalize invoices permission: only granted to named, active people, audited; no role carries it.
  const treasurerMembership = await prisma.eventMembership.create({ data: { eventId: ids.eventA, userId: ids.treasurer, role: "FINANCE_MANAGER", permissions: ["VIEW_HEALTH_INFORMATION"] } });
  const adminMembership = await prisma.eventMembership.create({ data: { eventId: ids.eventA, userId: ids.admin, role: "EVENT_ADMIN" } });
  const granted = await setInvoiceFinalizationAccess(ids.eventA, treasurerMembership.id, ids.admin, true);
  assert(granted.changed && (await prisma.eventMembership.findUniqueOrThrow({ where: { id: treasurerMembership.id } })).permissions.includes("FINALIZE_INVOICES"), "a system administrator can grant the permission");
  assert(!(await setInvoiceFinalizationAccess(ids.eventA, treasurerMembership.id, ids.admin, true)).changed, "granting again changes nothing");
  assert((await prisma.auditLog.count({ where: { eventId: ids.eventA, action: "INVOICE_FINALIZATION_ACCESS_GRANTED" } })) === 1, "the grant is audited once");
  assert((await failure(setInvoiceFinalizationAccess(ids.eventA, adminMembership.id, ids.admin, true))) instanceof InvoiceAccessGrantError, "a system administrator needs no grant");
  assert((await failure(setInvoiceFinalizationAccess(ids.eventB, treasurerMembership.id, ids.admin, true))) instanceof InvoiceAccessGrantError, "another event's staff assignment is refused");
  await prisma.$transaction(async (tx) => {
    const current = await tx.eventMembership.findUniqueOrThrow({ where: { id: treasurerMembership.id } });
    assert(await stripInvoiceFinalizationAccess(tx, current, ids.admin, "ROLE_CHANGED"), "a role change removes the permission");
  });
  const stripped = await prisma.eventMembership.findUniqueOrThrow({ where: { id: treasurerMembership.id } });
  assert(!stripped.permissions.includes("FINALIZE_INVOICES") && stripped.permissions.includes("VIEW_HEALTH_INFORMATION"), "stripping removes only that permission");
  assert((await prisma.auditLog.count({ where: { eventId: ids.eventA, entityId: treasurerMembership.id, action: "INVOICE_FINALIZATION_ACCESS_REVOKED" } })) === 1, "the removal is audited");
  assert(!(await setInvoiceFinalizationAccess(ids.eventA, treasurerMembership.id, ids.admin, false)).changed, "revoking what is not held changes nothing");

  // No audit row holds a contact's name or email.
  const audits = JSON.stringify(await prisma.auditLog.findMany({ where: { eventId: { in: events } } }));
  assert(audits.includes("INVOICE_FINALIZED") && audits.includes("INVOICE_DRAFTS_CREATED") && audits.includes("INVOICE_REVISION_STARTED") && audits.includes("INVOICE_CODE_SET"), "the actions are audited");
  assert(!audits.includes("Tina Treasurer") && !audits.includes("Sam Successor") && !audits.includes("Carl Clerk") && !audits.includes(EMAIL.first) && !audits.includes(EMAIL.second) && !audits.includes(EMAIL.third), "no audit row holds a contact's name or email");

  // Foreign-key actions: deleting the approver keeps their name on the invoice; deleting the event removes its invoices.
  await prisma.user.delete({ where: { id: ids.treasurer } });
  const approved = await prisma.invoiceVersion.findUniqueOrThrow({ where: { id: d1.id } });
  assert(approved.finalizedByUserId === null && approved.finalizedByName === "Tess Treasurer", "deleting the approver keeps the name they approved under");
  await prisma.event.delete({ where: { id: ids.eventA } });
  assert((await prisma.invoice.count({ where: { eventId: ids.eventA } })) === 0 && (await prisma.invoiceVersion.count({ where: { eventId: ids.eventA } })) === 0 && (await prisma.invoiceReceivable.count({ where: { eventId: ids.eventA } })) === 0 && (await prisma.invoiceNumberCounter.count({ where: { eventId: ids.eventA } })) === 0, "deleting an event removes its invoices, receivables and counters");

  console.log("Invoices verified: drafts only from a current approved reconciliation, one number per finalization under parallel requests, immutable finalized versions, contact-only and amount revisions with the permission rules, per-event and per-year counters, and audit without contact details.");
}

main()
  .then(async () => { await cleanup(); })
  .catch(async (error) => {
    console.error(error);
    await cleanup().catch(() => undefined);
    process.exitCode = 1;
  })
  .finally(async () => { await prisma.$disconnect(); });
