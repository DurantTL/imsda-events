import "server-only";

import { getPrisma } from "@/lib/prisma";
import {
  buildSystemAdminDashboard,
  type SystemAdminEventSource,
} from "@/modules/system-admin/dashboard";

function moneyToCents(value: { toString(): string } | number) {
  return Math.round(Number(value) * 100);
}

export async function getSystemAdminDashboard(now = new Date()) {
  const prisma = getPrisma();
  const [events, activeUserCount, pendingUserCount, systemAdminCount, unresolvedAlertCount] =
    await Promise.all([
      prisma.event.findMany({
        orderBy: { startsAt: "asc" },
        select: {
          id: true,
          slug: true,
          name: true,
          startsAt: true,
          endsAt: true,
          timezone: true,
          location: true,
          capacity: true,
          isPublished: true,
          registrationOpensOn: true,
          registrationClosesOn: true,
          waitlistEnabled: true,
          registrations: {
            where: { status: { in: ["SUBMITTED", "CONFIRMED"] } },
            select: {
              status: true,
              totalAmount: true,
              payments: {
                where: { status: "SUCCEEDED" },
                select: {
                  amount: true,
                  refunds: {
                    where: { status: "SUCCEEDED" },
                    select: { amount: true },
                  },
                },
              },
            },
          },
          attendees: {
            where: { registration: { status: { in: ["SUBMITTED", "CONFIRMED"] } } },
            select: { id: true },
          },
          checkIns: {
            where: {
              undoneAt: null,
              attendee: { registration: { status: { in: ["SUBMITTED", "CONFIRMED"] } } },
            },
            select: { id: true },
          },
          memberships: {
            where: { status: "ACTIVE" },
            select: { id: true },
          },
          registrationForms: {
            where: { status: "PUBLISHED" },
            select: { id: true },
          },
          waitlistEntries: {
            where: { status: "WAITING" },
            select: { id: true },
          },
          importRuns: {
            where: {
              OR: [
                { status: "FAILED" },
                { errors: { gt: 0 } },
                { warnings: { gt: 0 } },
              ],
            },
            select: { id: true },
          },
          messageOutbox: {
            where: {
              OR: [
                { status: "FAILED" },
                { providerDeliveryStatus: { in: ["BOUNCED", "COMPLAINED", "FAILED"] } },
              ],
            },
            select: { id: true },
          },
        },
      }),
      prisma.user.count({ where: { accountStatus: "ACTIVE" } }),
      prisma.user.count({ where: { accountStatus: "PENDING_ACTIVATION" } }),
      prisma.user.count({ where: { globalRole: "SYSTEM_ADMIN", accountStatus: "ACTIVE" } }),
      prisma.alertNotification.count({ where: { resolvedAt: null } }),
    ]);

  const eventSources: SystemAdminEventSource[] = events.map((event) => ({
    id: event.id,
    slug: event.slug,
    name: event.name,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    timezone: event.timezone,
    location: event.location,
    capacity: event.capacity,
    isPublished: event.isPublished,
    registrationOpensOn: event.registrationOpensOn,
    registrationClosesOn: event.registrationClosesOn,
    waitlistEnabled: event.waitlistEnabled,
    registrations: event.registrations.map((registration) => ({
      status: registration.status,
      totalAmountCents: moneyToCents(registration.totalAmount),
      payments: registration.payments.map((payment) => ({
        amountCents: moneyToCents(payment.amount),
        refunds: payment.refunds.map((refund) => ({
          amountCents: moneyToCents(refund.amount),
        })),
      })),
    })),
    attendeeCount: event.attendees.length,
    checkedInCount: event.checkIns.length,
    activeStaffCount: event.memberships.length,
    publishedFormCount: event.registrationForms.length,
    waitingCount: event.waitlistEntries.length,
    importIssueCount: event.importRuns.length,
    deliveryIssueCount: event.messageOutbox.length,
  }));

  return buildSystemAdminDashboard({
    events: eventSources,
    activeUserCount,
    pendingUserCount,
    systemAdminCount,
    unresolvedAlertCount,
  }, now);
}
