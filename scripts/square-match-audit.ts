/**
 * Every Square payment attached by hand, with the evidence needed to tell a
 * genuine second payment from the same money recorded twice.
 *
 * The WR26 import copied a "Square Payment ID" column out of the source
 * spreadsheet unverified, so a registration can already carry the right
 * payment under a reference Square does not recognise. Attaching the real
 * payment on top of that counts the money twice, and until the duplicate guard
 * existed nothing stopped it.
 *
 * Read-only by default.
 *
 * `--verify` asks Square whether the *other* reference on each registration is
 * a payment it knows. That is the fact the whole question turns on, and only
 * Square can answer it.
 *
 * `--void <ids>` reverses attachments, marking them VOIDED rather than
 * deleting: balances count only successful payments, so the money stops
 * counting while the history and its audit trail stay intact.
 *
 * `--relink <ids>` is the better repair where the import already recorded the
 * payment under a reference Square does not recognise. It moves the real
 * provider id onto that existing row and voids the attachment, so the money is
 * counted once *and* carries the id Square uses — which is what stops
 * reconciliation reporting it as missing on every future run. Voiding alone
 * leaves the bad reference in place and the report never goes quiet.
 */
import { loadEnvConfig } from "@next/env";
import { PrismaClient, type Prisma } from "@prisma/client";
import { getSquareConfiguration } from "@/modules/payments/square-config-domain";
import { getSquarePayment } from "@/modules/payments/square-http";

loadEnvConfig(process.cwd());

const USAGE = "Usage:\n"
  + "  npm run payments:match-audit\n"
  + "  npm run payments:match-audit -- --verify\n"
  + "  npm run payments:match-audit -- --relink <id>[,<id>...] --reason \"<why>\"\n"
  + "  npm run payments:match-audit -- --link <squareId>=<code>[,...] --reason \"<why>\"\n"
  + "  npm run payments:match-audit -- --void <id>[,<id>...] --reason \"<why>\"";

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(1);
}

function option(argv: string[], name: string) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) fail(`--${name} needs a value.`);
  return value;
}

function money(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function cents(value: Prisma.Decimal | number) {
  return Math.round(Number(value) * 100);
}

async function report(prisma: PrismaClient) {
  const attachments = await prisma.auditLog.findMany({
    where: { action: "SQUARE_PAYMENT_MANUALLY_MATCHED" },
    orderBy: { createdAt: "desc" },
    select: {
      createdAt: true,
      entityId: true,
      actorUserId: true,
      metadata: true,
    },
  });
  if (attachments.length === 0) {
    console.log("No Square payment has been attached by hand.");
    return 0;
  }

  let suspect = 0;
  for (const attachment of attachments) {
    if (!attachment.entityId) continue;
    const payment = await prisma.payment.findUnique({
      where: { id: attachment.entityId },
      select: {
        id: true,
        amount: true,
        status: true,
        externalReference: true,
        registrationId: true,
        registration: { select: { confirmationCode: true } },
      },
    });
    if (!payment) continue;

    const siblings = await prisma.payment.findMany({
      where: {
        registrationId: payment.registrationId,
        id: { not: payment.id },
        status: "SUCCEEDED",
      },
      select: { id: true, amount: true, externalReference: true },
    });
    // Any other money on the registration is the signal, not a matching
    // amount. The import records a successful payment at the registration's
    // Final Amount while the external checkout charged the fee on top, so the
    // duplicate pair routinely differs by the fee.
    const voided = payment.status === "VOIDED";
    if (siblings.length > 0 && !voided) suspect += 1;

    const mark = voided ? "voided" : siblings.length > 0 ? "CHECK" : "ok";
    console.log(`[${mark}] ${payment.registration.confirmationCode} · ${money(cents(payment.amount))}`);
    console.log(`        attached ${attachment.createdAt.toISOString()} · payment ${payment.id}`);
    console.log(`        reference ${payment.externalReference ?? "none"}`);
    for (const sibling of siblings) {
      console.log(`        also on this registration: ${money(cents(sibling.amount))} · ${sibling.id}`);
      console.log(`            under reference ${sibling.externalReference ?? "none"}`);
    }
    if (siblings.length > 0 && !voided) {
      console.log(`        reverse with: npm run payments:match-audit -- --void ${payment.id} --reason "<why>"`);
    }
  }

  if (suspect > 0) {
    console.log("\nRun --verify first: it asks Square which of these references are real,");
    console.log("and prints the repair command for the ones that are not.");
  }
  console.log(suspect === 0
    ? "\nNo attachment sits on a registration that already had money."
    : `\n${suspect} attachment${suspect === 1 ? " sits" : "s sit"} on a registration that already had money. Compare each against the Square receipt before voiding — a group paying in instalments looks the same here.`);
  return suspect;
}

/**
 * The ids, assembled. A shell eats an unquoted <placeholder> as a redirect
 * before the script ever runs, so the only safe way to hand someone forty ids
 * is to print the command they can paste.
 */
function printRepairCommand(paymentIds: string[]) {
  if (paymentIds.length === 0) return;
  console.log("\nRepair them all with:\n");
  console.log(`  npm run payments:match-audit -- --relink ${paymentIds.join(",")} \\`);
  console.log(`    --reason "imported payment carried a reference Square does not recognise"`);
}

/**
 * Ask Square about the reference already on each registration. A reference
 * Square does not know is the spreadsheet's, and the attachment beside it is
 * the same money a second time.
 */
async function verify(prisma: PrismaClient) {
  const configuration = getSquareConfiguration();
  if (!configuration.paymentConfigured) {
    fail(`Square is not configured (${configuration.issue}).`);
  }
  const pairs = await attachedPairs(prisma);
  if (pairs.length === 0) {
    console.log("No attachment sits beside another payment.");
    return 0;
  }
  let unknown = 0;
  const repairable: string[] = [];
  for (const pair of pairs) {
    const reference = pair.sibling.externalReference;
    if (!reference) {
      unknown += 1;
      console.log(`[no reference] ${pair.code} · the existing ${money(cents(pair.sibling.amount))} payment carries no reference at all.`);
      continue;
    }
    let known: boolean;
    try {
      known = Boolean(await getSquarePayment(configuration, reference));
    } catch {
      console.log(`[unreachable]  ${pair.code} · Square did not answer for ${reference}.`);
      continue;
    }
    if (known) {
      console.log(`[real]         ${pair.code} · Square knows ${reference}. Two genuine payments — do not void without checking.`);
    } else {
      unknown += 1;
      repairable.push(pair.attached.id);
      console.log(`[not in Square] ${pair.code} · Square has no payment ${reference}.`);
    }
  }
  console.log(`\n${unknown} registration${unknown === 1 ? "" : "s"} carry a reference Square does not recognise.`);
  printRepairCommand(repairable);
  return unknown;
}

/** Each hand-attached payment that sits beside exactly one same-amount payment. */
async function attachedPairs(prisma: PrismaClient) {
  const attachments = await prisma.auditLog.findMany({
    where: { action: "SQUARE_PAYMENT_MANUALLY_MATCHED" },
    orderBy: { createdAt: "desc" },
    select: { entityId: true },
  });
  const pairs = [];
  for (const attachment of attachments) {
    if (!attachment.entityId) continue;
    const attached = await prisma.payment.findUnique({
      where: { id: attachment.entityId },
      select: {
        id: true,
        eventId: true,
        amount: true,
        status: true,
        externalReference: true,
        registrationId: true,
        registration: { select: { confirmationCode: true } },
      },
    });
    if (!attached || attached.status === "VOIDED") continue;
    const siblings = await prisma.payment.findMany({
      where: {
        registrationId: attached.registrationId,
        id: { not: attached.id },
        status: "SUCCEEDED",
      },
      select: { id: true, amount: true, externalReference: true },
    });
    const sameAmount = siblings.filter(
      (sibling) => cents(sibling.amount) === cents(attached.amount),
    );
    // Only an unambiguous pair is repairable without a person choosing.
    if (sameAmount.length !== 1) continue;
    pairs.push({
      code: attached.registration.confirmationCode,
      attached,
      sibling: sameAmount[0]!,
    });
  }
  return pairs;
}

async function relink(
  prisma: PrismaClient,
  paymentIds: string[],
  reason: string,
) {
  const pairs = await attachedPairs(prisma);
  const byAttachedId = new Map(pairs.map((pair) => [pair.attached.id, pair]));
  for (const paymentId of paymentIds) {
    const pair = byAttachedId.get(paymentId);
    if (!pair) {
      console.log(`[skipped] ${paymentId} — not a hand-attached payment sitting beside exactly one same-amount payment.`);
      continue;
    }
    const realReference = pair.attached.externalReference;
    if (!realReference) {
      console.log(`[skipped] ${paymentId} — the attachment carries no provider reference to move.`);
      continue;
    }
    await prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: pair.sibling.id },
        data: { externalReference: realReference },
      });
      await tx.payment.update({
        where: { id: pair.attached.id },
        data: { status: "VOIDED" },
      });
      await tx.auditLog.create({
        data: {
          eventId: pair.attached.eventId,
          action: "SQUARE_PAYMENT_RELINKED",
          entityType: "Payment",
          entityId: pair.sibling.id,
          correlationId: crypto.randomUUID(),
          summary: `Moved the Square provider reference onto the imported payment for registration ${pair.code}, and voided the duplicate attachment.`,
          metadata: {
            reason,
            amountCents: cents(pair.attached.amount),
            adoptedReference: realReference,
            replacedReference: pair.sibling.externalReference,
            voidedPaymentId: pair.attached.id,
          },
        },
      });
    });
    console.log(`[relinked] ${pair.code} · ${money(cents(pair.attached.amount))}`);
    console.log(`           ${pair.sibling.id} now carries ${realReference}`);
    console.log(`           ${pair.attached.id} voided`);
  }
}

/**
 * Point an imported payment at the Square payment it has always been.
 *
 * `--relink` only reaches payments someone attached by hand, because it finds
 * the pair through that attachment. A channel that never carried a
 * confirmation code leaves no such trail: reconciliation reports the Square
 * payment as unrecorded, the money is already on the registration under a
 * reference Square does not recognise, and nothing in the data connects them.
 * Only a person reading the Square receipt can say which registration it is,
 * so they name it here.
 *
 * Refuses when the existing reference *is* a payment Square knows — that is
 * two real payments, not one mislabelled, and overwriting would erase a true
 * reference.
 */
async function link(
  prisma: PrismaClient,
  pairs: Array<{ providerPaymentId: string; confirmationCode: string }>,
  reason: string,
) {
  const configuration = getSquareConfiguration();
  if (!configuration.paymentConfigured) {
    fail(`Square is not configured (${configuration.issue}).`);
  }
  for (const pair of pairs) {
    const provider = await getSquarePayment(
      configuration,
      pair.providerPaymentId,
    ).catch(() => null);
    if (!provider) {
      console.log(`[skipped] ${pair.providerPaymentId} — Square has no such payment.`);
      continue;
    }
    if (provider.status !== "COMPLETED") {
      console.log(`[skipped] ${pair.providerPaymentId} — Square reports it as ${provider.status.toLowerCase()}.`);
      continue;
    }
    if (provider.locationId && provider.locationId !== configuration.locationId) {
      console.log(`[skipped] ${pair.providerPaymentId} — taken at another Square location.`);
      continue;
    }

    const registration = await prisma.registration.findFirst({
      where: { confirmationCode: pair.confirmationCode },
      select: {
        id: true,
        eventId: true,
        confirmationCode: true,
        payments: {
          where: { status: "SUCCEEDED" },
          select: { id: true, amount: true, externalReference: true },
        },
      },
    });
    if (!registration) {
      console.log(`[skipped] ${pair.confirmationCode} — no registration carries that confirmation code.`);
      continue;
    }
    const candidates = registration.payments.filter(
      (payment) => cents(payment.amount) === provider.amountCents,
    );
    if (candidates.length === 0) {
      console.log(`[skipped] ${pair.confirmationCode} — no successful ${money(provider.amountCents)} payment to point at.`);
      console.log("           Attach it through Finance instead; the money is not recorded here.");
      continue;
    }
    if (candidates.length > 1) {
      console.log(`[skipped] ${pair.confirmationCode} — more than one ${money(provider.amountCents)} payment. Pick one by hand.`);
      continue;
    }
    const existing = candidates[0]!;
    if (existing.externalReference === provider.id) {
      console.log(`[already] ${pair.confirmationCode} — already points at ${provider.id}.`);
      continue;
    }
    if (existing.externalReference) {
      const known = await getSquarePayment(
        configuration,
        existing.externalReference,
      ).catch(() => null);
      if (known) {
        console.log(`[refused] ${pair.confirmationCode} — its current reference ${existing.externalReference} is a real Square payment.`);
        console.log("           Two genuine payments, not one mislabelled. Nothing changed.");
        continue;
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: existing.id },
        data: { externalReference: provider.id },
      });
      await tx.auditLog.create({
        data: {
          eventId: registration.eventId,
          action: "SQUARE_PAYMENT_RELINKED",
          entityType: "Payment",
          entityId: existing.id,
          correlationId: crypto.randomUUID(),
          summary: `Pointed the imported payment for registration ${registration.confirmationCode} at the Square payment it records.`,
          metadata: {
            reason,
            amountCents: provider.amountCents,
            adoptedReference: provider.id,
            replacedReference: existing.externalReference,
            source: "MANUAL_LINK",
          },
        },
      });
    });
    console.log(`[linked]  ${registration.confirmationCode} · ${money(provider.amountCents)}`);
    console.log(`          ${existing.id} now carries ${provider.id}`);
  }
}

async function voidPayment(
  prisma: PrismaClient,
  paymentId: string,
  reason: string,
) {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: {
      id: true,
      eventId: true,
      amount: true,
      status: true,
      externalReference: true,
      registrationId: true,
      registration: { select: { confirmationCode: true } },
    },
  });
  if (!payment) fail(`No payment has the id ${paymentId}.`);
  if (payment.status === "VOIDED") {
    console.log("That payment is already voided. Nothing changed.");
    return;
  }
  const attached = await prisma.auditLog.findFirst({
    where: {
      action: "SQUARE_PAYMENT_MANUALLY_MATCHED",
      entityId: paymentId,
    },
    select: { id: true },
  });
  if (!attached) {
    // Refusing here keeps this from becoming a general-purpose way to erase
    // payments: it reverses hand-attachments and nothing else.
    fail("That payment was not attached by hand, so this cannot reverse it.");
  }

  await prisma.$transaction(async (tx) => {
    await tx.payment.update({
      where: { id: paymentId },
      data: { status: "VOIDED" },
    });
    await tx.auditLog.create({
      data: {
        eventId: payment.eventId,
        action: "SQUARE_PAYMENT_MATCH_REVERSED",
        entityType: "Payment",
        entityId: paymentId,
        correlationId: crypto.randomUUID(),
        summary: `Voided a hand-attached Square payment on registration ${payment.registration.confirmationCode}.`,
        metadata: {
          reason,
          amountCents: cents(payment.amount),
          externalReference: payment.externalReference,
          previousStatus: payment.status,
        },
      },
    });
  });
  console.log(`Voided ${money(cents(payment.amount))} on ${payment.registration.confirmationCode}.`);
  console.log("Balances count only successful payments, so this no longer counts as received.");
}

function idList(value: string) {
  const ids = value.split(",").map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0) fail("No payment id was given.");
  if (ids.some((id) => id.startsWith("<"))) {
    fail("Replace the <paymentId> placeholder with a real id from the report.");
  }
  return ids;
}

async function main() {
  const argv = process.argv.slice(2);
  const prisma = new PrismaClient();
  try {
    if (argv.includes("--verify")) {
      process.exitCode = (await verify(prisma)) === 0 ? 0 : 1;
      return;
    }
    const toRelink = option(argv, "relink");
    if (toRelink) {
      const reason = option(argv, "reason");
      if (!reason) fail("--reason is required when relinking a payment.");
      await relink(prisma, idList(toRelink), reason);
      return;
    }
    const toLink = option(argv, "link");
    if (toLink) {
      const reason = option(argv, "reason");
      if (!reason) fail("--reason is required when linking a payment.");
      const pairs = idList(toLink).map((entry) => {
        const [providerPaymentId, confirmationCode] = entry.split("=");
        if (!providerPaymentId || !confirmationCode) {
          fail(`Each --link entry must read <squareId>=<confirmationCode>; got "${entry}".`);
        }
        return {
          providerPaymentId,
          confirmationCode: confirmationCode.toUpperCase(),
        };
      });
      await link(prisma, pairs, reason);
      return;
    }
    const target = option(argv, "void");
    if (target) {
      const reason = option(argv, "reason");
      if (!reason) fail("--reason is required when voiding a payment.");
      for (const id of idList(target)) {
        await voidPayment(prisma, id, reason);
      }
      return;
    }
    process.exitCode = (await report(prisma)) === 0 ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(() => {
  console.error(`The attachment audit could not be completed.\n\n${USAGE}`);
  process.exit(1);
});
