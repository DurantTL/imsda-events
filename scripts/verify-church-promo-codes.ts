/**
 * Proves church-sponsored promo codes (#545) against a real PostgreSQL
 * database: staff link a code on a GENERAL event to an active CHURCH
 * organization (a club event, a club organization, and an inactive church are
 * refused) and both link and unlink are audited with ids only; a redemption
 * makes one owed line of exactly the recorded discount for the church; a
 * cancelled, waitlisted, or draft registration owes nothing, so cancelling
 * drops the line with nothing to delete; two redemptions at the same moment
 * neither lose nor duplicate a line and the last use goes to exactly one of
 * them; a code on a club event, or an event already billed to organizations,
 * never bills the church (no double billing); a used code cannot move to
 * another church; and the overview total and the staff CSV agree with the
 * lines. Uses fictitious rows it creates and removes itself.
 *
 *   npm run test:church-promo-codes
 */
import { loadEnvConfig } from "@next/env";
import { Prisma, PrismaClient } from "@prisma/client";
import { getEventOverview } from "../modules/events/repository";
import { churchAmountsOwedCsvRows } from "../modules/club-registrations/church-owed";
import { billedSponsoredLines } from "../modules/promo-codes/church-sponsored";
import {
  listChurchSponsoredPromoLines,
  sumChurchSponsoredPromoCents,
} from "../modules/promo-codes/church-sponsored-repository";
import {
  claimPromoCode,
  createPromoCode,
  recordPromoCodeRedemption,
  updatePromoCode,
} from "../modules/promo-codes/repository";

loadEnvConfig(process.cwd());

const prisma = new PrismaClient();
const P = "cpc";
const staffUserId = `${P}_staff`;
const churchA = `${P}_church_a`;
const churchB = `${P}_church_b`;
const churchInactive = `${P}_church_inactive`;
const clubOrg = `${P}_club`;
const events = {
  general: `${P}_event_general`,
  club: `${P}_event_club`,
  billedGeneral: `${P}_event_billed_general`,
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

async function expectCode(promise: Promise<unknown>, code: string, message: string) {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  assert(
    error && typeof error === "object" && "code" in error && (error as { code: string }).code === code,
    `${message}: expected ${code}, got ${String(error)}`,
  );
}

const startsWithP = { startsWith: `${P}_` };

async function cleanup() {
  await prisma.auditLog.deleteMany({ where: { actorUserId: staffUserId } });
  await prisma.event.deleteMany({ where: { id: startsWithP } });
  await prisma.registration.deleteMany({ where: { eventId: startsWithP } });
  await prisma.person.deleteMany({ where: { id: startsWithP } });
  await prisma.organization.deleteMany({ where: { id: startsWithP } });
  await prisma.user.deleteMany({ where: { id: staffUserId } });
}

const baseInput = {
  isActive: true,
  discountType: "FIXED_CENTS" as const,
  discountValue: 2_500,
  startsOn: null,
  endsOn: null,
  minimumSubtotalCents: null,
  maximumUses: null,
  maximumDiscountCents: null,
};

let registrationCounter = 0;

/** The same claim + record the public registration does, in a serializable transaction that retries like the app. */
async function redeem(eventId: string, code: string, status: "SUBMITTED" | "CONFIRMED" | "WAITLISTED" | "DRAFT" = "SUBMITTED") {
  registrationCounter += 1;
  const number = registrationCounter;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const claimed = await claimPromoCode(tx, {
          eventId,
          submittedCode: code,
          eligibleSubtotalCents: 10_000,
          pricingDate: "2026-10-01",
          fieldId: "promo_field",
        });
        const registration = await tx.registration.create({
          data: {
            eventId,
            accountHolderPersonId: `${P}_person`,
            confirmationCode: `CPC-${number}`,
            status,
            totalAmount: 75,
          },
        });
        await recordPromoCodeRedemption(tx, { eventId, registrationId: registration.id, claimed });
        return registration;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      const retryable = (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2034" || error.code === "P2002"))
        || (typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "PROMO_CODE_CLAIM_CONFLICT");
      if (!retryable || attempt === 7) throw error;
    }
  }
  throw new Error("unreachable");
}

async function promoIdOf(eventId: string, code: string) {
  const promo = await prisma.promoCode.findUniqueOrThrow({ where: { eventId_normalizedCode: { eventId, normalizedCode: code } }, select: { id: true, updatedAt: true } });
  return promo;
}

async function main() {
  await cleanup();
  await prisma.user.create({ data: { id: staffUserId, email: `${P}-staff@example.test`, displayName: "Church Promo Check Staff", globalRole: "SYSTEM_ADMIN" } });
  await prisma.person.create({ data: { id: `${P}_person`, firstName: "Sample", lastName: "Registrant" } });
  await prisma.organization.createMany({
    data: [
      { id: churchA, type: "CHURCH", name: "Church Promo Check Church A", normalizedName: "church promo check church a" },
      { id: churchB, type: "CHURCH", name: "Church Promo Check Church B", normalizedName: "church promo check church b" },
      { id: churchInactive, type: "CHURCH", name: "Church Promo Check Closed Church", normalizedName: "church promo check closed church", isActive: false },
    ],
  });
  await prisma.organization.create({ data: { id: clubOrg, type: "CLUB", name: "Church Promo Check Club", normalizedName: "church promo check club", parentOrganizationId: churchA } });
  const day = 86_400_000;
  const now = Date.now();
  const mkEvent = (id: string, audience: "CLUB" | "GENERAL", billingMode: "ATTENDEE_PAY" | "DEFERRED_ORGANIZATION_INVOICE") => prisma.event.create({
    data: { id, slug: `${id}-slug`, name: `Church Promo Check ${id}`, startsAt: new Date(now + day), endsAt: new Date(now + 2 * day), isPublished: true, audience, billingMode },
  });
  await mkEvent(events.general, "GENERAL", "ATTENDEE_PAY");
  await mkEvent(events.club, "CLUB", "DEFERRED_ORGANIZATION_INVOICE");
  await mkEvent(events.billedGeneral, "GENERAL", "DEFERRED_ORGANIZATION_INVOICE");

  // Linking: only an active CHURCH organization, only on a GENERAL event.
  await createPromoCode(events.general, { ...baseInput, code: "CHURCHA", sponsoringOrganizationId: churchA }, staffUserId);
  await createPromoCode(events.general, { ...baseInput, code: "PLAIN" }, staffUserId);
  await expectCode(createPromoCode(events.club, { ...baseInput, code: "NOCLUB", sponsoringOrganizationId: churchA }, staffUserId), "PROMO_CODE_SPONSOR_INVALID", "club event cannot have a sponsor");
  await expectCode(createPromoCode(events.general, { ...baseInput, code: "NOCLUBORG", sponsoringOrganizationId: clubOrg }, staffUserId), "PROMO_CODE_SPONSOR_INVALID", "a club is not a sponsoring church");
  await expectCode(createPromoCode(events.general, { ...baseInput, code: "NOINACTIVE", sponsoringOrganizationId: churchInactive }, staffUserId), "PROMO_CODE_SPONSOR_INVALID", "an inactive church cannot sponsor");
  await expectCode(createPromoCode(events.general, { ...baseInput, code: "NOSUCH", sponsoringOrganizationId: `${P}_missing` }, staffUserId), "PROMO_CODE_SPONSOR_INVALID", "an unknown organization cannot sponsor");
  assert(await prisma.promoCode.count({ where: { eventId: { in: [events.club] } } }) === 0, "a refused create leaves no code behind");

  // Link and unlink an unused code, each audited once with ids only.
  const plain = await promoIdOf(events.general, "PLAIN");
  await updatePromoCode(events.general, plain.id, { ...baseInput, code: "PLAIN", sponsoringOrganizationId: churchB, expectedUpdatedAt: plain.updatedAt.toISOString() }, staffUserId);
  assert((await prisma.promoCode.findUniqueOrThrow({ where: { id: plain.id } })).sponsoringOrganizationId === churchB, "link stored");
  const linked = await promoIdOf(events.general, "PLAIN");
  await updatePromoCode(events.general, plain.id, { ...baseInput, code: "PLAIN", sponsoringOrganizationId: null, expectedUpdatedAt: linked.updatedAt.toISOString() }, staffUserId);
  assert((await prisma.promoCode.findUniqueOrThrow({ where: { id: plain.id } })).sponsoringOrganizationId === null, "unlink stored");
  const sponsorAudits = await prisma.auditLog.findMany({ where: { actorUserId: staffUserId, action: { in: ["PROMO_CODE_SPONSOR_LINKED", "PROMO_CODE_SPONSOR_UNLINKED"] } }, orderBy: { createdAt: "asc" } });
  assert(sponsorAudits.length === 3, `create+link and unlink audited (got ${sponsorAudits.length})`);
  for (const entry of sponsorAudits) {
    const metadata = entry.metadata as Record<string, unknown>;
    assert(Object.keys(metadata).sort().join() === "previousSponsoringOrganizationId,promoCodeId,sponsoringOrganizationId", "sponsor audit metadata is ids only");
    assert(!JSON.stringify(entry).includes("Church Promo Check"), "sponsor audit never carries a church name");
  }
  assert(sponsorAudits.filter((entry) => entry.action === "PROMO_CODE_SPONSOR_UNLINKED").length === 1, "one unlink audit");

  // Redemption makes one owed line of exactly the recorded discount.
  const first = await redeem(events.general, "CHURCHA", "CONFIRMED");
  let lines = await listChurchSponsoredPromoLines(events.general);
  assert(lines.length === 1 && lines[0].churchId === churchA && lines[0].amountCents === 2_500 && lines[0].confirmationCode === first.confirmationCode, "redemption creates one line for the church");
  assert(await sumChurchSponsoredPromoCents(events.general) === 2_500, "sum matches the line");
  assert((await prisma.promoCodeRedemption.findUniqueOrThrow({ where: { registrationId: first.id } })).discountAmountCents === 2_500, "the line is the recorded discount");
  // An unsponsored code never bills a church.
  await redeem(events.general, "PLAIN");
  assert((await listChurchSponsoredPromoLines(events.general)).length === 1, "an unsponsored code adds no line");

  // Waitlisted and draft registrations owe nothing until they are active.
  const waitlisted = await redeem(events.general, "CHURCHA", "WAITLISTED");
  await redeem(events.general, "CHURCHA", "DRAFT");
  assert(await sumChurchSponsoredPromoCents(events.general) === 2_500, "waitlisted and draft registrations owe nothing");
  await prisma.registration.update({ where: { id: waitlisted.id }, data: { status: "SUBMITTED" } });
  assert(await sumChurchSponsoredPromoCents(events.general) === 5_000, "promotion from the waitlist starts the line");

  // Cancelling drops the line automatically: nothing stored, nothing to delete.
  const redemptionsBefore = await prisma.promoCodeRedemption.count({ where: { eventId: events.general } });
  await prisma.registration.update({ where: { id: waitlisted.id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
  lines = await listChurchSponsoredPromoLines(events.general);
  assert(lines.length === 1 && await sumChurchSponsoredPromoCents(events.general) === 2_500, "cancellation drops the line");
  assert(await prisma.promoCodeRedemption.count({ where: { eventId: events.general } }) === redemptionsBefore, "the immutable redemption record is untouched");

  // Two redemptions at the same moment: none lost, none duplicated.
  await createPromoCode(events.general, { ...baseInput, code: "RACEOPEN", sponsoringOrganizationId: churchB }, staffUserId);
  const openRace = await Promise.all([1, 2, 3, 4].map(() => redeem(events.general, "RACEOPEN")));
  const openLines = (await listChurchSponsoredPromoLines(events.general)).filter((line) => line.churchId === churchB);
  assert(openLines.length === 4 && new Set(openLines.map((line) => line.confirmationCode)).size === 4, "four parallel redemptions make four distinct lines");
  assert(new Set(openRace.map((registration) => registration.id)).size === 4, "four registrations");
  const raceOpenPromo = await prisma.promoCode.findFirstOrThrow({ where: { eventId: events.general, normalizedCode: "RACEOPEN" } });
  assert(raceOpenPromo.redeemedCount === 4, `use count matches lines (got ${raceOpenPromo.redeemedCount})`);
  assert(openLines.reduce((sum, line) => sum + line.amountCents, 0) === 10_000, "no lost or duplicated amount");

  // The last use goes to exactly one of two simultaneous redemptions.
  await createPromoCode(events.general, { ...baseInput, code: "LASTONE", maximumUses: 1, sponsoringOrganizationId: churchB }, staffUserId);
  const settled = await Promise.allSettled([redeem(events.general, "LASTONE"), redeem(events.general, "LASTONE")]);
  assert(settled.filter((result) => result.status === "fulfilled").length === 1, "exactly one redemption gets the last use");
  assert(settled.filter((result) => result.status === "rejected").length === 1, "the other is refused");
  const lastLines = (await listChurchSponsoredPromoLines(events.general)).filter((line) => line.promoCode === "LASTONE");
  assert(lastLines.length === 1, "one line for the one use");
  assert((await prisma.promoCode.findFirstOrThrow({ where: { eventId: events.general, normalizedCode: "LASTONE" } })).redeemedCount === 1, "use count is one");

  // A used code cannot move or lose its sponsor.
  const used = await promoIdOf(events.general, "CHURCHA");
  await expectCode(updatePromoCode(events.general, used.id, { ...baseInput, code: "CHURCHA", sponsoringOrganizationId: churchB, expectedUpdatedAt: used.updatedAt.toISOString() }, staffUserId), "PROMO_CODE_SPONSOR_LOCKED", "a used code keeps its sponsor");
  await expectCode(updatePromoCode(events.general, used.id, { ...baseInput, code: "CHURCHA", sponsoringOrganizationId: null, expectedUpdatedAt: used.updatedAt.toISOString() }, staffUserId), "PROMO_CODE_SPONSOR_LOCKED", "a used code cannot be unlinked");
  await updatePromoCode(events.general, used.id, { ...baseInput, code: "CHURCHA", isActive: false, expectedUpdatedAt: used.updatedAt.toISOString() }, staffUserId);
  assert((await prisma.promoCode.findUniqueOrThrow({ where: { id: used.id } })).sponsoringOrganizationId === churchA, "deactivating without a sponsor field keeps the sponsor");

  // No double billing: a sponsored code on a club event, or on an event already
  // billed to organizations, never bills the church. (Created directly, as if
  // the event's audience or billing changed after the code was linked.)
  for (const eventId of [events.club, events.billedGeneral]) {
    await prisma.promoCode.create({ data: { eventId, code: "SNEAKY", normalizedCode: "SNEAKY", discountType: "FIXED_CENTS", discountValue: 2_500, sponsoringOrganizationId: churchA } });
    await redeem(eventId, "SNEAKY", "CONFIRMED");
    assert((await listChurchSponsoredPromoLines(eventId)).length === 0, `no sponsored line on ${eventId}`);
    assert(await sumChurchSponsoredPromoCents(eventId) === 0, `no sponsored total on ${eventId}`);
  }
  const clubOverview = await getEventOverview(events.club);
  assert(clubOverview?.metrics.churchSponsoredCents === 0, "club event overview adds nothing for sponsored codes");

  // Overview and CSV agree with the lines.
  const overview = await getEventOverview(events.general);
  const finalLines = await listChurchSponsoredPromoLines(events.general);
  const expectedTotal = finalLines.reduce((sum, line) => sum + line.amountCents, 0);
  assert(overview?.metrics.churchSponsoredCents === expectedTotal && expectedTotal === 2_500 + 10_000 + 2_500, `overview total matches (got ${overview?.metrics.churchSponsoredCents})`);
  const csv = churchAmountsOwedCsvRows([], billedSponsoredLines(finalLines));
  assert(csv.length === 1 + finalLines.length, "CSV has one row per sponsored line");
  assert(csv.slice(1).every((row) => row[8] === "Church-sponsored promo code; billed to the church after the event, not paid online" && row[5] === ""), "CSV rows are labelled and carry no attendee data");
  const churchBRow = csv.find((row) => row[0] === "Church Promo Check Church B");
  assert(churchBRow && churchBRow[7] === "125.00", "church total sums its lines");

  console.log("church-sponsored promo codes: all checks passed");
}

main()
  .then(async () => { await cleanup(); await prisma.$disconnect(); })
  .catch(async (error) => {
    console.error(error);
    await cleanup().catch(() => undefined);
    await prisma.$disconnect();
    process.exit(1);
  });
