import type { PrismaClient } from "@prisma/client";
import { getEventPublishReadiness } from "@/modules/events/readiness";
import {
  checkOperationalReadiness,
  operationalReadinessSummary,
  type OperationalReadinessCheck,
  type OperationalReadinessFacts,
} from "@/modules/events/operational-readiness";
import { getSquareConfiguration } from "@/modules/payments/square-config-domain";
import { shirtSizeFromResponses } from "@/modules/registrations/shirt-sizes";

export const REQUIRED_READINESS_TEMPLATE_KEYS = [
  "REGISTRATION_CONFIRMATION_PAID",
  "REGISTRATION_CONFIRMATION_UNPAID",
  "PAYMENT_RECEIPT",
  "BALANCE_REMINDER",
  "SHIRT_SIZE_REQUEST",
] as const;

/**
 * A deferred-organization event never sends a paid/unpaid confirmation,
 * payment receipt, or balance reminder — it always sends the
 * organization-billed confirmation instead. Requiring the attendee-pay
 * templates here would permanently block publishing such an event.
 */
const DEFERRED_ORGANIZATION_REQUIRED_READINESS_TEMPLATE_KEYS = [
  "REGISTRATION_CONFIRMATION_ORGANIZATION_BILLED",
  "SHIRT_SIZE_REQUEST",
] as const;

export function requiredReadinessTemplateKeys(
  billingMode: "ATTENDEE_PAY" | "DEFERRED_ORGANIZATION_INVOICE",
) {
  return billingMode === "DEFERRED_ORGANIZATION_INVOICE"
    ? DEFERRED_ORGANIZATION_REQUIRED_READINESS_TEMPLATE_KEYS
    : REQUIRED_READINESS_TEMPLATE_KEYS;
}

export type EventReadinessReport = {
  event: { name: string; slug: string };
  activeRegistrationCount: number;
  checks: OperationalReadinessCheck[];
  summary: ReturnType<typeof operationalReadinessSummary>;
};

/** Collects a safe, aggregate report using database reads only. */
export async function collectEventReadinessReport(
  prisma: PrismaClient,
  slug: string,
  env: Record<string, string | undefined>,
): Promise<EventReadinessReport | null> {
  const event = await prisma.event.findUnique({
    where: { slug },
    select: { id: true, name: true, slug: true, startsAt: true, endsAt: true, timezone: true, location: true, publicInfoUrl: true, supportContact: true, isPublished: true, billingMode: true },
  });
  if (!event) return null;
  const isDeferredOrganizationBilling = event.billingMode === "DEFERRED_ORGANIZATION_INVOICE";

  const [publishedFormCount, settings, templates, registrations] = await Promise.all([
    prisma.registrationFormVersion.count({ where: { form: { eventId: event.id }, status: "PUBLISHED" } }),
    prisma.eventMessageSettings.findFirst({ where: { eventId: event.id }, select: { deliveryMode: true, senderEmail: true, replyToEmail: true } }),
    prisma.eventMessageTemplate.findMany({
      where: { eventId: event.id },
      select: { key: true, isEnabled: true, versions: { where: { status: "PUBLISHED" }, select: { id: true } } },
    }),
    prisma.registration.findMany({
      where: { eventId: event.id, status: { in: ["SUBMITTED", "CONFIRMED"] } },
      select: {
        totalAmount: true,
        attendees: { select: { formResponses: true } },
        payments: { where: { status: "SUCCEEDED" }, select: { amount: true, refunds: { where: { status: "SUCCEEDED" }, select: { amount: true } } } },
      },
    }),
  ]);

  let registrationsMissingShirtSize = 0;
  let registrationsWithBalanceDue = 0;
  for (const registration of registrations) {
    if (registration.attendees.some((attendee) => !shirtSizeFromResponses(attendee.formResponses))) registrationsMissingShirtSize += 1;
    // A deferred-organization registration's recorded amount is the
    // responsible organization's estimated rate, never an attendee balance,
    // so it must never count toward "no card path to pay it" alarms.
    if (isDeferredOrganizationBilling) continue;
    const paid = registration.payments.reduce((sum, payment) => {
      const refunded = payment.refunds.reduce((total, refund) => total + Number(refund.amount), 0);
      return sum + Math.max(Number(payment.amount) - refunded, 0);
    }, 0);
    if (Number(registration.totalAmount) - paid > 0) registrationsWithBalanceDue += 1;
  }

  const publishReadiness = getEventPublishReadiness({
    ...event,
    startsOn: event.startsAt.toISOString(),
    endsOn: event.endsAt.toISOString(),
  }, publishedFormCount);
  const publishChecks: OperationalReadinessCheck[] = publishReadiness.items.map((item) => ({
    code: `PUBLISH_${item.id.replaceAll("-", "_").toUpperCase()}`,
    label: item.label,
    severity: item.complete ? "READY" : "BLOCKER",
    detail: item.detail,
  }));

  const square = getSquareConfiguration(env);
  const facts: OperationalReadinessFacts = {
    isPublished: event.isPublished,
    hasPublishedFormVersion: publishedFormCount > 0,
    messaging: settings,
    templates: templates.map((template) => ({ key: template.key, isEnabled: template.isEnabled, hasPublishedVersion: template.versions.length > 0 })),
    requiredTemplateKeys: [...requiredReadinessTemplateKeys(event.billingMode)],
    emailProvider: { deliveryConfigured: Boolean(env.RESEND_API_KEY?.trim()), webhookConfigured: Boolean(env.RESEND_WEBHOOK_SECRET?.trim()) },
    square: { paymentConfigured: square.paymentConfigured, webhookConfigured: square.webhookConfigured, environment: square.environment, issue: square.issue },
    registrationsMissingShirtSize,
    registrationsWithBalanceDue,
  };
  const checks = [...publishChecks, ...checkOperationalReadiness(facts)];
  return { event: { name: event.name, slug: event.slug }, activeRegistrationCount: registrations.length, checks, summary: operationalReadinessSummary(checks) };
}
