/**
 * Reports what still stops an event from running for real.
 *
 * Run it before a cutover and after any environment change. It reads only —
 * nothing here writes — so it is safe against production.
 *
 * Usage:
 *   npm run event:readiness -- --event womens-retreat-2026
 */
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import {
  checkOperationalReadiness,
  operationalReadinessSummary,
  type OperationalReadinessFacts,
} from "@/modules/events/operational-readiness";
import { getSquareConfiguration } from "@/modules/payments/square-config-domain";
import { shirtSizeFromResponses } from "@/modules/registrations/shirt-sizes";

loadEnvConfig(process.cwd());

/** Templates an event cannot sensibly run without. */
const REQUIRED_TEMPLATE_KEYS = [
  "REGISTRATION_CONFIRMATION_PAID",
  "REGISTRATION_CONFIRMATION_UNPAID",
  "PAYMENT_RECEIPT",
  "BALANCE_REMINDER",
  "SHIRT_SIZE_REQUEST",
];

const SEVERITY_MARK = { BLOCKER: "x", WARNING: "!", READY: "." } as const;

function usage(message: string): never {
  console.error(`${message}

Usage:
  npm run event:readiness -- --event <slug>`);
  process.exit(1);
}

function readFlag(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) usage(`--${name} needs a value.`);
  return value;
}

async function main() {
  const slug = readFlag("event");
  if (!slug) usage("--event is required.");

  const prisma = new PrismaClient();
  try {
    const event = await prisma.event.findUnique({ where: { slug } });
    if (!event) usage(`No event has the slug "${slug}".`);

    const [publishedForm, settings, templates, registrations] = await Promise.all([
      prisma.registrationFormVersion.findFirst({
        where: { form: { eventId: event.id }, status: "PUBLISHED" },
        select: { id: true },
      }),
      prisma.eventMessageSettings.findFirst({ where: { eventId: event.id } }),
      prisma.eventMessageTemplate.findMany({
        where: { eventId: event.id },
        select: { key: true, isEnabled: true, versions: { where: { status: "PUBLISHED" }, select: { id: true } } },
      }),
      prisma.registration.findMany({
        where: { eventId: event.id, status: { in: ["SUBMITTED", "CONFIRMED"] } },
        select: {
          totalAmount: true,
          attendees: { select: { formResponses: true } },
          payments: {
            where: { status: "SUCCEEDED" },
            select: { amount: true, refunds: { where: { status: "SUCCEEDED" }, select: { amount: true } } },
          },
        },
      }),
    ]);

    let missingShirtSize = 0;
    let balanceDue = 0;
    for (const registration of registrations) {
      if (registration.attendees.some((attendee) => !shirtSizeFromResponses(attendee.formResponses))) {
        missingShirtSize += 1;
      }
      // Net of successful refunds: a fully refunded payment leaves the balance
      // owed again, and counting it as paid would downgrade a missing Square
      // configuration from blocker to warning.
      const paid = registration.payments.reduce((sum, payment) => {
        const refunded = payment.refunds.reduce((total, refund) => total + Number(refund.amount), 0);
        return sum + Math.max(Number(payment.amount) - refunded, 0);
      }, 0);
      if (Number(registration.totalAmount) - paid > 0) balanceDue += 1;
    }

    // The same evaluation the checkout path performs, so this cannot report a
    // configuration the payment code would reject.
    const square = getSquareConfiguration(process.env);
    const facts: OperationalReadinessFacts = {
      isPublished: event.isPublished,
      hasPublishedFormVersion: Boolean(publishedForm),
      messaging: settings
        ? {
            deliveryMode: settings.deliveryMode,
            senderEmail: settings.senderEmail,
            replyToEmail: settings.replyToEmail,
          }
        : null,
      templates: templates.map((template) => ({
        key: template.key,
        isEnabled: template.isEnabled,
        hasPublishedVersion: template.versions.length > 0,
      })),
      requiredTemplateKeys: REQUIRED_TEMPLATE_KEYS,
      emailProvider: {
        // Mirrors getResendEmailAvailability, which lives behind server-only.
        deliveryConfigured: Boolean(process.env.RESEND_API_KEY?.trim()),
        webhookConfigured: Boolean(process.env.RESEND_WEBHOOK_SECRET?.trim()),
      },
      square: {
        paymentConfigured: square.paymentConfigured,
        webhookConfigured: square.webhookConfigured,
        environment: square.environment,
        issue: square.issue,
      },
      registrationsMissingShirtSize: missingShirtSize,
      registrationsWithBalanceDue: balanceDue,
    };

    const checks = checkOperationalReadiness(facts);
    const summary = operationalReadinessSummary(checks);

    console.log(`${event.name} (${event.slug})`);
    console.log(`${registrations.length} active registrations\n`);
    for (const check of checks) {
      console.log(`  [${SEVERITY_MARK[check.severity]}] ${check.label}`);
      if (check.severity !== "READY") console.log(`        ${check.detail}`);
    }
    console.log(
      summary.isReady
        ? `\nNo blockers. ${summary.warnings} warning${summary.warnings === 1 ? "" : "s"}.`
        : `\n${summary.blockers} blocker${summary.blockers === 1 ? "" : "s"}, ${summary.warnings} warning${summary.warnings === 1 ? "" : "s"}.`,
    );
    process.exitCode = summary.isReady ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
