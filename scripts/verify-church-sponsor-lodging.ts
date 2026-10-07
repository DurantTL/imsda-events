/**
 * Proves that a lodging change on a church-sponsored registration updates the church's bill automatically (#813)
 * against a real PostgreSQL database, where unit tests cannot:
 *
 * - a staff edit that changes the lodging charge moves the sponsor's share of THAT edit into the church's amount owed in
 *   the same transaction: an increase, a decrease and a revert (back to exactly the starting amount), with a 50% and a
 *   100% church code, and with no code or a code that is not church-sponsored nothing moves;
 * - the registrant's own discount and total are untouched (the share lives in `sponsorLodgingChangeCents`), an amendment
 *   of the answers rewrites `discountAmountCents` and does not erase a lodging change, and the church-owed lines, their
 *   CSV and the overview tile all agree;
 * - a registrant's change request moves nothing until staff apply it, and applying it moves the church's share once;
 * - when the church's invoice is already finalized nothing is revised and nothing moves: a flag is raised for the finance
 *   office, listed until cleared, and cleared once; an invoice DRAFT is never touched and raises no flag;
 * - every church amount change has an audit row holding ids and amounts only;
 * - concurrent edits of one registration never double count (the church's total always equals the share of the final
 *   request), and a repeated edit changes nothing the second time.
 *
 * Uses fictitious rows it creates and removes itself.
 *
 *   npm run test:church-sponsor-lodging
 */
import { loadEnvConfig } from "@next/env";
import { randomUUID } from "node:crypto";
import { PrismaClient, RegistrationFormStatus } from "@prisma/client";
import { assertLocalDatabase } from "./support/local-only-guard";
import { fillBlankSyntheticEnv } from "./support/synthetic-env";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";
import { submitPublicRegistration } from "@/modules/forms/public-repository";
import type { PublicRegistrationInput } from "@/modules/forms/public-domain";
import { saveLodgingRequest, type Actor, type SaveRequestResult } from "@/modules/lodging/preferences-service";
import { selectEventProperty, setEventRate } from "@/modules/lodging/service";
import { syncLodgingTemplates } from "@/modules/lodging/sync";
import { updateLodgingSettings } from "@/modules/lodging/preferences-service";
import { chargeChangeSentence } from "@/modules/lodging/preferences-domain";
import { listChurchSponsoredPromoLines, sumChurchSponsoredPromoCents } from "@/modules/promo-codes/church-sponsored-repository";
import { billedSponsoredLines } from "@/modules/promo-codes/church-sponsored";
import { ChurchSponsorFlagError, clearChurchSponsorFlag, countOpenChurchSponsorFlags, listOpenChurchSponsorFlags } from "@/modules/promo-codes/church-sponsor-lodging";
import { churchAmountsOwedCsvRows } from "@/modules/club-registrations/church-owed";
import { getEventOverview } from "@/modules/events/repository";

loadEnvConfig(process.cwd());
assertLocalDatabase(process.env, "run this verification");
fillBlankSyntheticEnv("SECRET_ENCRYPTION_KEY", "verify-church-sponsor-lodging-synthetic-key-not-a-secret");

const prisma = new PrismaClient();
const P = `csl813_${randomUUID().slice(0, 8)}`;
const userId = `${P}_user`;
const eventId = `${P}_ev`;
const church = `${P}_church`;
const churchTwo = `${P}_church2`;
const surname = `Sponsor${P}`;
const formSlug = `${P}-form`;
const formId = `${P}_form`;
const versionId = `${P}_form_v1`;
const before = new Date("2027-05-20T12:00:00Z");
const staff: Actor = { kind: "STAFF", userId, canSeeSensitive: true };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}
async function caught(promise: Promise<unknown>) {
  return promise.then(() => null, (error: unknown) => error);
}

/** Amendment records are immutable by trigger; this script's own synthetic rows are removed with the trigger off for that one transaction (local database only, asserted above). */
async function clearLedger() {
  await prisma.$transaction([
    prisma.$executeRawUnsafe('ALTER TABLE "RegistrationOperation" DISABLE TRIGGER "RegistrationOperation_immutable"'),
    prisma.registrationOperation.deleteMany({ where: { eventId: { startsWith: `${P}_` } } }),
    prisma.$executeRawUnsafe('ALTER TABLE "RegistrationOperation" ENABLE TRIGGER "RegistrationOperation_immutable"'),
  ]);
}

async function cleanup() {
  await clearLedger();
  const registrationIds = (await prisma.registration.findMany({ where: { eventId: { startsWith: `${P}_` } }, select: { id: true } })).map((row) => row.id);
  await prisma.messageOutbox.deleteMany({ where: { registrationId: { in: registrationIds } } });
  await prisma.event.deleteMany({ where: { id: { startsWith: `${P}_` } } });
  await prisma.person.deleteMany({ where: { lastName: surname } });
  await prisma.organization.deleteMany({ where: { id: { in: [church, churchTwo] } } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ actorUserId: userId }, { eventId: { startsWith: `${P}_` } }] } });
  await prisma.person.deleteMany({ where: { normalizedEmail: { startsWith: `${P}.` } } });
  await prisma.user.deleteMany({ where: { id: userId } });
}

const formDefinition = registrationFormDefinitionSchema.parse({
  title: "Church sponsor lodging verification",
  description: "Temporary fictitious form used only by the church sponsor lodging check.",
  confirmationMessage: "Received.",
  attendeeRoster: { enabled: true, minAttendees: 1, maxAttendees: 8, attendeeLabel: "Attendee", addButtonLabel: "Add another attendee" },
  sections: [
    {
      id: `${P}_contact`, title: "Contact", description: "", fields: [
        { id: `${P}_f_first`, key: "primary_contact_first_name", label: "First name", helpText: "", type: "TEXT", scope: "REGISTRATION", required: true, options: [] },
        { id: `${P}_f_last`, key: "primary_contact_last_name", label: "Last name", helpText: "", type: "TEXT", scope: "REGISTRATION", required: true, options: [] },
        { id: `${P}_f_email`, key: "email", label: "Email", helpText: "", type: "EMAIL", scope: "REGISTRATION", required: true, options: [] },
        { id: `${P}_f_fee`, key: "registration_fee", label: "Registration fee", helpText: "", type: "CHECKBOX", scope: "REGISTRATION", required: false, options: [], priceCents: 5000 },
        { id: `${P}_f_promo`, key: "promo_code", label: "Promo code", helpText: "", type: "TEXT", scope: "REGISTRATION", required: false, options: [] },
      ],
    },
    {
      id: `${P}_attendees`, title: "Attendees", description: "", fields: [
        { id: `${P}_a_first`, key: "first_name", label: "First name", helpText: "", type: "TEXT", scope: "ATTENDEE", required: true, options: [] },
        { id: `${P}_a_last`, key: "last_name", label: "Last name", helpText: "", type: "TEXT", scope: "ATTENDEE", required: true, options: [] },
      ],
    },
  ],
});

let submissions = 0;
function formInput(people: number, lodging: unknown, responses: Record<string, unknown>): PublicRegistrationInput {
  submissions += 1;
  const n = submissions;
  return {
    versionId,
    idempotencyKey: randomUUID(),
    responses: { primary_contact_first_name: "Sp", primary_contact_last_name: `Holder${n}`, email: `${P}.sub${n}@sponsor.example.test`, ...responses },
    attendees: Array.from({ length: people }, (_, index) => ({ clientId: `p${index}`, responses: { first_name: `Guest${n}x${index}`, last_name: surname } })),
    lodging,
    website: "",
  } as PublicRegistrationInput;
}

/** A real public submission (the registration, its pricing snapshot, its redemption and its lodging request). */
async function submit(code: string | null, people = 3) {
  const result = await submitPublicRegistration(`${eventId}-slug`, formSlug, formInput(people, { category: "TENT", partySize: 1 }, { registration_fee: true, ...(code ? { promo_code: code } : {}) }), before);
  const registration = await prisma.registration.findFirstOrThrow({ where: { eventId, confirmationCode: result.confirmationCode }, include: { attendees: { include: { person: true }, orderBy: { position: "asc" } } } });
  return { id: registration.id, code: registration.confirmationCode, registration };
}

type Saved = Exclude<SaveRequestResult, { changeRequested: true }>;
/** Staff move the party of the tent request; tents are $40 a person, so each step moves the list charge by $40. */
async function staffParty(registrationId: string, party: number): Promise<Saved> {
  const result = await saveLodgingRequest({ eventId, registrationId, actor: staff, raw: { category: "TENT", partySize: party, reason: `Party of ${party}` }, now: before }, prisma);
  if (result.changeRequested) throw new Error("FAILED: a staff change was held for staff");
  return result;
}

const owedLines = async () => billedSponsoredLines(await listChurchSponsoredPromoLines(eventId, prisma));
async function owedFor(registrationId: string) {
  const row = await prisma.promoCodeRedemption.findUniqueOrThrow({ where: { registrationId }, select: { discountAmountCents: true, sponsorLodgingChangeCents: true } });
  return { discount: row.discountAmountCents, moved: row.sponsorLodgingChangeCents, owed: row.discountAmountCents + row.sponsorLodgingChangeCents };
}
const lineFor = async (confirmationCode: string) => (await owedLines()).find((line) => line.confirmationCode === confirmationCode);
const churchTotal = (churchId = church) => sumChurchSponsoredPromoCents(eventId, prisma, churchId);
const changeAudits = (registrationId: string) => prisma.auditLog.findMany({ where: { eventId, action: "CHURCH_SPONSOR_SHARE_CHANGED", metadata: { path: ["registrationId"], equals: registrationId } }, orderBy: { createdAt: "asc" } });

/** A finalized invoice version for a church on this event (an invoice version starts as a draft and is then finalized). */
async function invoiceFor(churchId: string, tag: string, finalize: boolean) {
  const reconciliation = await prisma.attendanceReconciliationVersion.create({
    data: { eventId, versionNumber: Math.floor(Math.random() * 1_000_000) + 1, fingerprint: `${P}-${tag}`, ruleVersion: "verify", invoiceGrouping: "PER_CHURCH", registeredCount: 0, checkedInCount: 0, noShowCount: 0, addedByStaffCount: 0, removedByStaffCount: 0, billableCount: 0, estimatedCents: 0, billableCents: 0, snapshot: {} },
  });
  const sequence = Math.floor(Math.random() * 8000) + 1000;
  const baseNumber = `VT27-${sequence}`;
  const invoice = await prisma.invoice.create({ data: { eventId, groupKey: `${P}:${tag}`, invoiceGrouping: "PER_CHURCH", partyKind: "ORGANIZATION", partyId: churchId } });
  const version = await prisma.invoiceVersion.create({
    data: { invoiceId: invoice.id, eventId, revision: 0, basis: "RECONCILIATION", reconciliationVersionId: reconciliation.id, groupTitle: "Fictitious church", organizationName: "Fictitious church", registeredCount: 0, billableCount: 0, amountDueCents: 12_345, amountsFingerprint: `${P}-${tag}`, snapshot: {} },
  });
  if (finalize) {
    await prisma.invoice.update({ where: { id: invoice.id }, data: { baseNumber, numberCode: "VT", numberYear: 2027, numberSequence: sequence } });
    await prisma.invoiceVersion.update({ where: { id: version.id }, data: { status: "FINALIZED", number: baseNumber, finalizedAt: new Date(), finalizedByName: "Fictitious finance", finalizeIdempotencyKey: `${P}-${tag}` } });
  }
  return { invoice, version };
}

async function main() {
  await cleanup();
  await prisma.user.create({ data: { id: userId, email: `${P}@sponsor.example.test`, displayName: "Sponsor verifier" } });
  for (const [id, name] of [[church, "Sponsor Check Church"], [churchTwo, "Sponsor Check Second Church"]] as const) {
    await prisma.organization.create({ data: { id, type: "CHURCH", name: `${name} ${P}`, normalizedName: `${name} ${P}`.toLowerCase() } });
  }
  await syncLodgingTemplates(prisma);
  await prisma.event.create({
    data: {
      id: eventId, slug: `${eventId}-slug`, name: `Church sponsor lodging check ${eventId}`,
      startsAt: new Date("2027-06-15T15:00:00Z"), endsAt: new Date("2027-06-19T15:00:00Z"), timezone: "America/Chicago",
      registrationClosesOn: "2027-06-01", attendeeEditPolicy: "TIERED", isPublished: true,
    },
  });
  await selectEventProperty(eventId, userId, { propertyKey: "sunnydale-academy" }, prisma);
  await updateLodgingSettings(eventId, userId, { collectsPreferences: true }, prisma);
  await setEventRate(eventId, userId, { category: "TENT", rate: { amountCents: 4000, basis: "PER_PERSON_PER_EVENT", minimumNights: null } }, prisma);
  await prisma.registrationForm.create({
    data: {
      id: formId, eventId, createdByUserId: userId, name: formDefinition.title, slug: formSlug, status: RegistrationFormStatus.PUBLISHED,
      versions: { create: { id: versionId, createdByUserId: userId, versionNumber: 1, status: RegistrationFormStatus.PUBLISHED, publishedAt: new Date(), definition: formDefinition } },
    },
  });
  const promo = (codeText: string, bps: number, sponsor: string | null) => prisma.promoCode.create({ data: { eventId, code: codeText, normalizedCode: codeText, discountType: "PERCENT_BPS", discountValue: bps, sponsoringOrganizationId: sponsor } });
  await promo("HALFCHURCH", 5000, church);
  await promo("FULLCHURCH", 10_000, church);
  await promo("HALFOTHER", 5000, churchTwo);
  await promo("HALFPLAIN", 5000, null);

  // ---- 50% church code: increase, decrease and revert --------------------------------------------------------------
  const half = await submit("HALFCHURCH");
  const start = await owedFor(half.id);
  assert(start.discount === 4500 && start.moved === 0 && start.owed === 4500, `a 50% code on the $50 fee and $40 tent owes $45 to start: ${JSON.stringify(start)}`);
  assert((await lineFor(half.code))?.amountCents === 4500 && await churchTotal() === 4500, "the church-owed line and the church total show it");
  const registrationTotal = Number((await prisma.registration.findUniqueOrThrow({ where: { id: half.id } })).totalAmount);
  assert(registrationTotal === 45, `the registrant owes $45 after the code: ${registrationTotal}`);

  const up = await staffParty(half.id, 2);
  assert(up.priceNeedsReview === true && up.chargeDeltaCents === 4000 && up.registrantDeltaCents === 2000 && up.sponsorDeltaCents === 2000, `an increase: list +$40, registrant +$20, church +$20: ${JSON.stringify(up)}`);
  assert(up.churchShare?.status === "UPDATED" && up.churchShare.deltaCents === 2000 && up.churchShare.registrationOwedCents === 6500, `the church's share was updated automatically to $65: ${JSON.stringify(up.churchShare)}`);
  assert((await owedFor(half.id)).owed === 6500 && (await lineFor(half.code))?.amountCents === 6500 && await churchTotal() === 6500, "the church-owed line and total moved in the same save");
  const afterUp = await owedFor(half.id);
  assert(afterUp.discount === 4500 && afterUp.moved === 2000, "the registrant's recorded discount is untouched; the share is its own column");
  assert(Number((await prisma.registration.findUniqueOrThrow({ where: { id: half.id } })).totalAmount) === 45, "and the registrant's total is unchanged (staff record the registrant's share in Payments)");
  const sentence = chargeChangeSentence(up);
  assert(sentence.includes("The amount to record for the registrant is +$20.00.") && sentence.includes("was updated automatically") && !/finance office/i.test(sentence), `staff are told the registrant's share to record and that the church was updated: ${sentence}`);

  const upAgain = await staffParty(half.id, 3);
  assert(upAgain.churchShare?.status === "UPDATED" && upAgain.churchShare.deltaCents === 2000 && upAgain.churchShare.registrationOwedCents === 8500, "a second increase moves only its own +$20");
  const down = await staffParty(half.id, 2);
  assert(down.sponsorDeltaCents === -2000 && down.churchShare?.status === "UPDATED" && down.churchShare.deltaCents === -2000 && (await owedFor(half.id)).owed === 6500, "a decrease takes its own $20 back");
  const revert = await staffParty(half.id, 1);
  const reverted = await owedFor(half.id);
  assert(revert.churchShare?.status === "UPDATED" && revert.churchShare.deltaCents === -2000 && reverted.owed === 4500 && reverted.moved === 0 && await churchTotal() === 4500, `a revert returns the church to exactly where it started: ${JSON.stringify(reverted)}`);

  // Every church amount change is audited with ids and amounts only.
  const audits = await changeAudits(half.id);
  assert(audits.length === 4, `four edits, four audit rows, got ${audits.length}`);
  const allowedKeys = ["registrationId", "redemptionId", "churchId", "lodgingRequestVersionId", "fromCents", "toCents", "deltaCents", "requestedDeltaCents"].sort();
  for (const row of audits) {
    const metadata = row.metadata as Record<string, unknown>;
    assert(JSON.stringify(Object.keys(metadata).sort()) === JSON.stringify(allowedKeys), `the audit row holds ids and amounts only: ${Object.keys(metadata).join()}`);
    assert(Object.values(metadata).every((value) => typeof value === "number" || (typeof value === "string" && value.length > 0 && !/\s/.test(value))), "every value is an id or an amount, never text");
    assert(!JSON.stringify(row).includes(half.code) && !JSON.stringify(row).includes(surname), "no confirmation code, no name");
  }
  assert(audits.map((row) => (row.metadata as { deltaCents: number }).deltaCents).join() === "2000,2000,-2000,-2000", "in order, the audit rows are the four deltas");
  assert((audits[0]!.metadata as { fromCents: number }).fromCents === 4500 && (audits[0]!.metadata as { toCents: number }).toCents === 6500, "from and to amounts are recorded");

  // A repeated edit changes nothing the second time.
  const repeated = await staffParty(half.id, 1);
  assert(repeated.changed === false && (await changeAudits(half.id)).length === 4 && (await owedFor(half.id)).owed === 4500, "an unchanged edit adds no change and no audit row");

  // ---- 100% church code ------------------------------------------------------------------------------------------
  const full = await submit("FULLCHURCH");
  assert((await owedFor(full.id)).owed === 9000, "a 100% code: the church owes the whole $90 subtotal");
  const fullUp = await staffParty(full.id, 2);
  assert(fullUp.registrantDeltaCents === 0 && fullUp.sponsorDeltaCents === 4000 && fullUp.churchShare?.status === "UPDATED" && fullUp.churchShare.registrationOwedCents === 13_000, `the church carries the whole list change: ${JSON.stringify(fullUp)}`);
  const fullDown = await staffParty(full.id, 1);
  assert(fullDown.churchShare?.status === "UPDATED" && fullDown.churchShare.registrationOwedCents === 9000 && (await owedFor(full.id)).moved === 0, "and gives it back on a revert");
  assert(await churchTotal() === 4500 + 9000, "the church total is the sum of its registrations");

  // ---- A code that is not church-sponsored, and no code, move nothing -----------------------------------------------
  const plain = await submit("HALFPLAIN");
  const plainEdit = await staffParty(plain.id, 2);
  assert(plainEdit.priceNeedsReview === true && plainEdit.churchShare === undefined && await prisma.promoCodeRedemption.count({ where: { registrationId: plain.id, sponsorLodgingChangeCents: 0 } }) === 1, "a code that is not church-sponsored moves no church amount");
  const none = await submit(null);
  const noneEdit = await staffParty(none.id, 2);
  assert(noneEdit.priceNeedsReview === true && noneEdit.churchShare === undefined && await churchTotal() === 4500 + 9000, "no code: nothing moves");
  assert(!(await owedLines()).some((line) => line.confirmationCode === plain.code || line.confirmationCode === none.code), "neither is a church-owed line");

  // ---- The other views agree ----------------------------------------------------------------------------------------
  await staffParty(half.id, 2);
  const lines = await owedLines();
  assert(lines.find((line) => line.confirmationCode === half.code)?.amountCents === 6500, "the line follows the edit");
  const overview = await getEventOverview(eventId);
  assert(overview?.metrics.churchSponsoredCents === 6500 + 9000 && overview.metrics.churchSponsoredCents === await churchTotal(), `the overview tile agrees: ${overview?.metrics.churchSponsoredCents}`);
  const csv = churchAmountsOwedCsvRows([], lines).map((row) => row.join("|")).join("\n");
  assert(csv.includes(`${half.code}`) && csv.includes("65.00") && csv.includes("90.00") && csv.includes("155.00"), `the CSV carries the moved amount and the church subtotal:\n${csv}`);
  // An amendment of the registrant's answers rewrites the recorded discount from the form; the church's lodging change stays on top.
  const amendments = await import("../modules/registrations/amendments-repository");
  const answers = await amendments.currentRegistrationAnswers(eventId, half.id);
  assert(answers, "the answers load");
  const amendInput = {
    clientRequestId: randomUUID(), expectedUpdatedAt: answers.updatedAt, reason: "Fix a spelling", responses: answers.responses, previewOnly: true as boolean,
    attendees: half.registration.attendees.map((row, index) => ({ attendeeId: row.id, clientId: `amend-${index}`, responses: { first_name: row.person.firstName, last_name: row.person.lastName } })),
  };
  const quote = await amendments.previewRegistrationAmendment(eventId, half.id, amendInput);
  await amendments.amendRegistration(eventId, half.id, { ...amendInput, previewOnly: false, quoteFingerprint: quote.quoteFingerprint }, { kind: "STAFF", id: userId, displayName: "Sponsor verifier" }, before);
  const afterAmend = await owedFor(half.id);
  assert(afterAmend.moved === 2000 && afterAmend.owed === afterAmend.discount + 2000 && (await lineFor(half.code))?.amountCents === afterAmend.discount + 2000, `an amendment never erases a lodging change: ${JSON.stringify(afterAmend)}`);
  await staffParty(half.id, 1);
  assert((await owedFor(half.id)).moved === 0, "and a later revert still lands back at the start");

  // ---- A registrant's change request moves nothing until staff apply it ---------------------------------------------
  const asked = await submit("HALFCHURCH");
  const askedBefore = await owedFor(asked.id);
  const registrantActor: Actor = { kind: "REGISTRANT", accessTokenId: `${P}_tok_asked` };
  const requested = await saveLodgingRequest({ eventId, registrationId: asked.id, actor: registrantActor, raw: { category: "TENT", partySize: 2 }, now: before }, prisma);
  assert(requested.changeRequested === true, "a registrant's priced change is held for staff");
  assert((await owedFor(asked.id)).owed === askedBefore.owed && (await changeAudits(asked.id)).length === 0, "a change request moves nothing and writes no church audit row");
  assert(await prisma.eventLodgingChangeRequest.count({ where: { registrationId: asked.id, resolvedAt: null } }) === 1, "the request waits in the review queue");
  const approved = await staffParty(asked.id, 2);
  assert(approved.churchShare?.status === "UPDATED" && approved.churchShare.registrationOwedCents === askedBefore.owed + 2000, "staff applying the request moves the church's share");
  assert(await prisma.eventLodgingChangeRequest.count({ where: { registrationId: asked.id, resolvedAt: null } }) === 0, "and resolves the change request");
  assert((await changeAudits(asked.id)).length === 1, "exactly one church audit row for the approved change");

  // ---- Races: concurrent edits of one registration never double count ------------------------------------------------
  const raced = await submit("HALFCHURCH");
  const racedStart = (await owedFor(raced.id)).owed;
  const sizes = [2, 3, 2, 3, 1, 3];
  const outcomes = await Promise.all(sizes.map((party) => caught(staffParty(raced.id, party))));
  assert(outcomes.every((outcome) => outcome === null), `every concurrent edit applies in turn: ${outcomes.map(String).join()}`);
  const finalRequest = await prisma.eventLodgingRequest.findFirstOrThrow({ where: { registrationId: raced.id }, select: { currentVersion: true } });
  const finalVersion = await prisma.eventLodgingRequestVersion.findFirstOrThrow({ where: { requestId: (await prisma.eventLodgingRequest.findFirstOrThrow({ where: { registrationId: raced.id } })).id, version: finalRequest.currentVersion } });
  const expected = racedStart + (finalVersion.partySize - 1) * 2000;
  const racedNow = await owedFor(raced.id);
  assert(racedNow.owed === expected, `after ${sizes.length} racing edits the church owes exactly the share of the final request (party ${finalVersion.partySize}): expected ${expected}, got ${racedNow.owed}`);
  const racedAudits = await changeAudits(raced.id);
  assert(racedAudits.reduce((sum, row) => sum + (row.metadata as { deltaCents: number }).deltaCents, 0) === racedNow.owed - racedStart, "and the audit rows add up to the same change");
  assert(new Set(racedAudits.map((row) => (row.metadata as { lodgingRequestVersionId: string }).lodgingRequestVersionId)).size === racedAudits.length, "each request version moved the church's share once");
  // The same edit sent twice at once changes the church once.
  const twice = await submit("HALFCHURCH");
  const twiceStart = (await owedFor(twice.id)).owed;
  await Promise.all([staffParty(twice.id, 3), staffParty(twice.id, 3), staffParty(twice.id, 3)]);
  assert((await owedFor(twice.id)).owed === twiceStart + 4000 && (await changeAudits(twice.id)).length === 1, "three identical edits at once move the church once");

  // ---- A finalized church invoice: flagged, never revised, never moved ------------------------------------------------
  // Another church's invoice DRAFT: nothing is finalized, so the church's amount owed moves and no flag is raised.
  const draftChurch = await submit("HALFOTHER");
  const draft = await invoiceFor(churchTwo, "D", false);
  const draftEdit = await staffParty(draftChurch.id, 2);
  assert(draftEdit.churchShare?.status === "UPDATED" && (await owedFor(draftChurch.id)).owed === 6500, "before finalization the church's amount owed moves");
  const draftAfter = await prisma.invoiceVersion.findUniqueOrThrow({ where: { id: draft.version.id } });
  assert(draftAfter.status === "DRAFT" && draftAfter.amountDueCents === 12_345 && draftAfter.regenerationCount === 0, "an invoice draft is never touched by the edit (its total changes only by regeneration)");
  assert(await countOpenChurchSponsorFlags(eventId, prisma, churchTwo) === 0, "and no flag is raised while the invoice is a draft");

  const finalized = await invoiceFor(church, "F", true);
  const frozen = await prisma.invoiceVersion.findUniqueOrThrow({ where: { id: finalized.version.id } });
  assert(frozen.status === "FINALIZED", "the church's invoice is finalized");
  const beforeFlag = await owedFor(half.id);
  const totalBefore = await churchTotal();
  const flagged = await staffParty(half.id, 2);
  assert(flagged.priceNeedsReview === true && flagged.registrantDeltaCents === 2000 && flagged.sponsorDeltaCents === 2000, "the registrant's share is still told to staff");
  assert(flagged.churchShare?.status === "FLAGGED" && flagged.churchShare.deltaCents === 2000, `the church's share is flagged, not applied: ${JSON.stringify(flagged.churchShare)}`);
  assert(JSON.stringify(await owedFor(half.id)) === JSON.stringify(beforeFlag) && await churchTotal() === totalBefore, "the church's amount owed did not move");
  const afterFinal = await prisma.invoiceVersion.findUniqueOrThrow({ where: { id: finalized.version.id } });
  assert(JSON.stringify(afterFinal) === JSON.stringify(frozen), "the finalized invoice is exactly as it was");
  assert(await prisma.invoiceVersion.count({ where: { invoiceId: finalized.invoice.id } }) === 1 && await prisma.invoice.count({ where: { eventId, partyId: church } }) === 1, "no revision, no new invoice");
  const sentenceFlagged = chargeChangeSentence(flagged);
  assert(sentenceFlagged.includes("already finalized") && sentenceFlagged.includes("flagged") && !sentenceFlagged.includes("updated automatically"), `staff are told: ${sentenceFlagged}`);
  const open = await listOpenChurchSponsorFlags(eventId, prisma);
  assert(open.length === 1 && open[0]!.churchId === church && open[0]!.confirmationCode === half.code && open[0]!.deltaCents === 2000 && open[0]!.invoiceVersionId === finalized.version.id, `the finance office sees one open flag: ${JSON.stringify(open)}`);
  assert(await countOpenChurchSponsorFlags(eventId, prisma) === 1, "and the notice count is one");
  assert(await prisma.auditLog.count({ where: { eventId, action: "CHURCH_SPONSOR_SHARE_FLAGGED" } }) === 1, "the flag is audited");
  const flagAudit = await prisma.auditLog.findFirstOrThrow({ where: { eventId, action: "CHURCH_SPONSOR_SHARE_FLAGGED" } });
  assert(!JSON.stringify(flagAudit).includes(surname) && !JSON.stringify(flagAudit).includes(half.code), "the flag audit row holds ids and amounts only");
  // Another edit after finalization is its own flag (the revert is a separate -$20); the amount never moves.
  const flaggedRevert = await staffParty(half.id, 1);
  assert(flaggedRevert.churchShare?.status === "FLAGGED" && flaggedRevert.churchShare.deltaCents === -2000 && (await owedFor(half.id)).moved === beforeFlag.moved, "a revert after finalization is flagged too and moves nothing");
  assert((await listOpenChurchSponsorFlags(eventId, prisma)).length === 2 && (await listOpenChurchSponsorFlags(eventId, prisma)).reduce((sum, row) => sum + row.deltaCents, 0) === 0, "the two flags net to nothing for the finance office");
  // The 100% church is flagged the same way.
  const fullFlag = await staffParty(full.id, 2);
  assert(fullFlag.churchShare?.status === "FLAGGED" && fullFlag.churchShare.deltaCents === 4000 && (await owedFor(full.id)).moved === 0, "a 100% code after finalization is flagged and unchanged");
  await staffParty(full.id, 1);
  // A different church is not blocked by this church's finalized invoice.
  const otherStillMoves = await staffParty(draftChurch.id, 3);
  assert(otherStillMoves.churchShare?.status === "UPDATED", "another church's draft is unaffected by this church's finalized invoice");

  // The finance office clears a flag once, with a note; clearing changes no amount and no invoice.
  const [first, ...rest] = await listOpenChurchSponsorFlags(eventId, prisma);
  const totalAtClear = await churchTotal();
  await clearChurchSponsorFlag({ eventId, flagId: first!.id, actorUserId: userId, note: "Revised through the invoice revision path" }, prisma);
  const cleared = await prisma.churchSponsorFinanceReview.findUniqueOrThrow({ where: { id: first!.id } });
  assert(cleared.clearedAt !== null && cleared.clearedByUserId === userId && cleared.clearNote === "Revised through the invoice revision path", "the flag records who cleared it and the note");
  assert((await listOpenChurchSponsorFlags(eventId, prisma)).length === rest.length && await churchTotal() === totalAtClear, "it leaves the open list, and no amount moved");
  const again = await caught(clearChurchSponsorFlag({ eventId, flagId: first!.id, actorUserId: userId }, prisma));
  assert(again instanceof ChurchSponsorFlagError && again.code === "ALREADY_CLEARED", "a flag is cleared once");
  const otherEvent = await caught(clearChurchSponsorFlag({ eventId: `${P}_nope`, flagId: rest[0]!.id, actorUserId: userId }, prisma));
  assert(otherEvent instanceof ChurchSponsorFlagError && otherEvent.code === "FLAG_NOT_FOUND", "a flag of another event is not found");
  assert(await prisma.auditLog.count({ where: { eventId, action: "CHURCH_SPONSOR_FLAG_CLEARED" } }) === 1, "clearing is audited");

  // Flags and the redemption column go with their event.
  await clearLedger();
  await prisma.event.delete({ where: { id: eventId } });
  assert(await prisma.churchSponsorFinanceReview.count({ where: { eventId } }) === 0, "flags go with their event");
  console.log("Church sponsor lodging verified.");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await cleanup(); } catch (error) { console.error("Cleanup failed:", error instanceof Error ? error.message : error); process.exitCode = 1; }
    await prisma.$disconnect();
  });
