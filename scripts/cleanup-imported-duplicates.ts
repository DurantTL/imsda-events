/**
 * Removes registrations left behind by a superseded import run.
 *
 * Re-importing the same bundle is safe: the importer matches on confirmation
 * code and updates in place. What is not safe is importing the *same people*
 * under a *different* identifier scheme — an earlier flat CSV keyed on the
 * legacy form-entry id, say, and a later bundle keyed on the real registration
 * id. Nothing matches, so every registration exists twice, the event's
 * registration count doubles, and every balance report counts the money twice.
 *
 * There is no delete endpoint for a registration, and cancelling is not a
 * substitute: a cancelled row still carries its totals into the event
 * reconciliation. So this is that path, and it deliberately requires shell
 * access to the deployment.
 *
 * Selection is by confirmation code alone, because that is the fact that
 * distinguishes the two import runs and it is verifiable by eye. Rows whose
 * code matches --keep-pattern are kept; every other row in the event is a
 * candidate. A candidate that has received money is never deleted unless its
 * code is named explicitly in --also-delete, so an accidental pattern can cost
 * you fictitious rows but never a payment you cannot see. "Received" is net of
 * successful refunds, matching how the rest of the application reads a balance.
 *
 * A candidate carrying transfer, substitution, amendment, or payment-choice
 * history is withheld unconditionally. Those rows are immutable by database
 * trigger and their foreign keys are ON DELETE RESTRICT, so the delete could
 * not succeed anyway — attempting it would abort the transaction and take
 * every other duplicate with it.
 *
 * Prints a full report and changes nothing unless --commit is passed.
 *
 * Usage:
 *   npm run registrations:cleanup -- --event womens-retreat-2026
 *   npm run registrations:cleanup -- --event womens-retreat-2026 --commit
 */
import { loadEnvConfig } from "@next/env";
import { PrismaClient, type Prisma } from "@prisma/client";
import { planImportCleanup, type CleanupCandidate } from "@/modules/registrations/import-cleanup";

loadEnvConfig(process.cwd());

const DEFAULT_KEEP_PATTERN = String.raw`^WR26-\d{13}-[0-9A-Fa-f]{4}$`;

function usage(message: string): never {
  console.error(`${message}

Usage:
  npm run registrations:cleanup -- --event <slug> [options]

  --event         Event slug to clean. Required.
  --keep-pattern  Regex for confirmation codes to KEEP.
                  Default: ${DEFAULT_KEEP_PATTERN}
  --also-delete   Comma-separated confirmation codes to delete even though they
                  have received money. Use for known test rows.
  --commit        Actually delete. Without this the script only reports.`);
  process.exit(1);
}

function readFlag(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) usage(`--${name} needs a value.`);
  return value;
}

function money(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function toCents(value: Prisma.Decimal | number | null) {
  return Math.round(Number(value ?? 0) * 100);
}

/**
 * Money actually received: successful payments less successful refunds, the
 * same net the rest of the application computes. Counting the gross would
 * withhold a registration whose payment was refunded in full.
 */
function netPaidCents(
  payments: Array<{ amount: Prisma.Decimal | number; refunds: Array<{ amount: Prisma.Decimal | number }> }>,
) {
  return payments.reduce((total, payment) => {
    const refunded = payment.refunds.reduce((sum, refund) => sum + toCents(refund.amount), 0);
    return total + Math.max(toCents(payment.amount) - refunded, 0);
  }, 0);
}

async function main() {
  const eventSlug = readFlag("event");
  if (!eventSlug) usage("--event is required.");
  const commit = process.argv.includes("--commit");
  const keepPatternSource = readFlag("keep-pattern") ?? DEFAULT_KEEP_PATTERN;
  const alsoDelete = new Set(
    (readFlag("also-delete") ?? "")
      .split(",")
      .map((code) => code.trim())
      .filter(Boolean),
  );

  let keepPattern: RegExp;
  try {
    keepPattern = new RegExp(keepPatternSource);
  } catch {
    usage(`--keep-pattern is not a valid regular expression: ${keepPatternSource}`);
  }

  const prisma = new PrismaClient();
  try {
    const event = await prisma.event.findUnique({ where: { slug: eventSlug } });
    if (!event) usage(`No event has the slug "${eventSlug}".`);

    const registrations = await prisma.registration.findMany({
      where: { eventId: event.id },
      select: {
        id: true,
        confirmationCode: true,
        status: true,
        totalAmount: true,
        accountHolderPerson: { select: { firstName: true, lastName: true } },
        attendees: { select: { id: true } },
        payments: {
          where: { status: "SUCCEEDED" },
          select: { amount: true, refunds: { where: { status: "SUCCEEDED" }, select: { amount: true } } },
        },
        _count: { select: { operations: true, paymentChoiceOperations: true } },
      },
      orderBy: { confirmationCode: "asc" },
    });

    const describe = (registration: (typeof registrations)[number]): CleanupCandidate => ({
      id: registration.id,
      confirmationCode: registration.confirmationCode,
      accountHolder: [
        registration.accountHolderPerson.firstName,
        registration.accountHolderPerson.lastName,
      ].join(" ").trim(),
      status: registration.status,
      attendeeCount: registration.attendees.length,
      totalCents: toCents(registration.totalAmount),
      netPaidCents: netPaidCents(registration.payments),
      hasImmutableHistory: registration._count.operations > 0
        || registration._count.paymentChoiceOperations > 0,
    });

    const plan = planImportCleanup(
      registrations.map(describe),
      keepPattern,
      alsoDelete,
    );
    const { kept, deleting, withheld } = plan;

    const received = (rows: CleanupCandidate[]) => (
      rows.reduce((total, row) => total + row.netPaidCents, 0)
    );

    console.log(`Event: ${event.name} (${event.slug})`);
    console.log(`Keep pattern: ${keepPatternSource}\n`);
    console.log(`  keeping   ${String(kept.length).padStart(4)} registrations  total ${money(plan.keptTotalCents)}  received ${money(received(kept))}`);
    console.log(`  deleting  ${String(deleting.length).padStart(4)} registrations  total ${money(plan.deletingTotalCents)}  received ${money(received(deleting))}`);
    const withheldForMoney = withheld.filter((row) => row.reason === "RECEIVED_MONEY");
    const withheldForHistory = withheld.filter((row) => row.reason === "IMMUTABLE_HISTORY");
    if (withheld.length > 0) {
      console.log(`  withheld  ${String(withheld.length).padStart(4)} registrations (${withheldForMoney.length} received money, ${withheldForHistory.length} have immutable history)`);
    }

    if (deleting.length > 0) {
      console.log("\nWould delete:");
      for (const row of deleting) {
        const paidNote = row.netPaidCents > 0
          ? `  ** received ${money(row.netPaidCents)}, named in --also-delete **`
          : "";
        console.log(`  ${row.confirmationCode.padEnd(28)} ${row.accountHolder.padEnd(26)} ${row.status.padEnd(11)} ${String(row.attendeeCount).padStart(2)} att  ${money(row.totalCents).padStart(10)}${paidNote}`);
      }
    }

    if (withheldForMoney.length > 0) {
      console.log("\nWithheld — received money, not named in --also-delete:");
      for (const row of withheldForMoney) {
        console.log(`  ${row.confirmationCode.padEnd(28)} ${row.accountHolder.padEnd(26)} received ${money(row.netPaidCents)}`);
      }
    }

    if (withheldForHistory.length > 0) {
      console.log("\nWithheld — transfer, substitution, amendment, or payment-choice history:");
      console.log("  These rows are immutable by database trigger and cannot be deleted at all.");
      for (const row of withheldForHistory) {
        console.log(`  ${row.confirmationCode.padEnd(28)} ${row.accountHolder.padEnd(26)} ${row.status}`);
      }
    }

    console.log(`\nEvent total before ${money(plan.beforeTotalCents)} -> after ${money(plan.afterTotalCents)}`);
    console.log(`Registration count before ${plan.beforeCount} -> after ${plan.afterCount}`);

    if (deleting.length === 0) {
      console.log("\nNothing to delete.");
      return;
    }

    if (!commit) {
      console.log("\nDry run. Nothing was changed. Re-run with --commit to apply.");
      return;
    }

    const ids = deleting.map((row) => row.id);
    const allowedPaidCodes = new Set(
      deleting.filter((row) => alsoDelete.has(row.confirmationCode)).map((row) => row.id),
    );

    const removed = await prisma.$transaction(async (tx) => {
      /**
       * The payment guard above was computed from a read taken before this
       * transaction opened. A pending Square payment settling in between would
       * otherwise let a registration that has since received money be deleted,
       * cascading the payment with it. Re-read under the transaction and abort
       * rather than silently breaking the guarantee this script advertises.
       */
      const nowPaid = await tx.registration.findMany({
        where: { id: { in: ids }, payments: { some: { status: "SUCCEEDED" } } },
        select: {
          id: true,
          confirmationCode: true,
          payments: {
            where: { status: "SUCCEEDED" },
            select: { amount: true, refunds: { where: { status: "SUCCEEDED" }, select: { amount: true } } },
          },
        },
      });
      const newlyPaid = nowPaid.filter((registration) => (
        !allowedPaidCodes.has(registration.id)
        && netPaidCents(registration.payments) > 0
      ));
      if (newlyPaid.length > 0) {
        throw new Error(
          `Aborted: ${newlyPaid.map((r) => r.confirmationCode).join(", ")} received money after the preview was taken. Re-run to review the current state.`,
        );
      }

      /**
       * PromoCodeRedemption cascades with the registration, but redeemedCount
       * is denormalised and does not. Left stale it keeps consuming a code's
       * maximumUses, so a later valid registration is refused a discount that
       * is actually available. Recompute from the surviving rows.
       */
      const affectedPromoCodeIds = (await tx.promoCodeRedemption.findMany({
        where: { registrationId: { in: ids } },
        select: { promoCodeId: true },
      })).map((redemption) => redemption.promoCodeId);

      const result = await tx.registration.deleteMany({
        where: { id: { in: ids }, eventId: event.id },
      });

      for (const promoCodeId of new Set(affectedPromoCodeIds)) {
        const redeemedCount = await tx.promoCodeRedemption.count({ where: { promoCodeId } });
        await tx.promoCode.update({ where: { id: promoCodeId }, data: { redeemedCount } });
      }

      return { count: result.count, promoCodesRepaired: new Set(affectedPromoCodeIds).size };
    });

    console.log(`\nDeleted ${removed.count} registration${removed.count === 1 ? "" : "s"}.`);
    if (removed.promoCodesRepaired > 0) {
      console.log(`Recomputed redeemedCount on ${removed.promoCodesRepaired} promo code${removed.promoCodesRepaired === 1 ? "" : "s"}.`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
