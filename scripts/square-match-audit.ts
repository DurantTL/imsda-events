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
 * Read-only by default. `--void <paymentId>` reverses exactly one attachment,
 * by marking that payment VOIDED rather than deleting it: balances count only
 * successful payments, so the money stops counting while the history and its
 * audit trail stay intact.
 */
import { loadEnvConfig } from "@next/env";
import { PrismaClient, type Prisma } from "@prisma/client";

loadEnvConfig(process.cwd());

const USAGE = "Usage:\n"
  + "  npm run payments:match-audit\n"
  + "  npm run payments:match-audit -- --void <paymentId> --reason \"<why>\"";

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

  console.log(suspect === 0
    ? "\nNo attachment sits on a registration that already had money."
    : `\n${suspect} attachment${suspect === 1 ? " sits" : "s sit"} on a registration that already had money. Compare each against the Square receipt before voiding — a group paying in instalments looks the same here.`);
  return suspect;
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

async function main() {
  const argv = process.argv.slice(2);
  const target = option(argv, "void");
  const prisma = new PrismaClient();
  try {
    if (target) {
      const reason = option(argv, "reason");
      if (!reason) fail("--reason is required when voiding a payment.");
      await voidPayment(prisma, target, reason);
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
