import { evaluateEventRegistrationPhase } from "@/modules/events/lifecycle";

const activeRegistrationStatuses = new Set(["SUBMITTED", "CONFIRMED"]);

export type SystemAdminEventSource = {
  id: string;
  slug: string;
  name: string;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  location: string | null;
  capacity: number | null;
  isPublished: boolean;
  registrationOpensOn: string | null;
  registrationClosesOn: string | null;
  waitlistEnabled: boolean;
  registrations: Array<{
    status: string;
    totalAmountCents: number;
    payments: Array<{
      amountCents: number;
      refunds: Array<{ amountCents: number }>;
    }>;
  }>;
  attendeeCount: number;
  checkedInCount: number;
  activeStaffCount: number;
  publishedFormCount: number;
  waitingCount: number;
  importIssueCount: number;
  deliveryIssueCount: number;
};

export type SystemAdminDashboardSource = {
  events: SystemAdminEventSource[];
  activeUserCount: number;
  pendingUserCount: number;
  systemAdminCount: number;
  unresolvedAlertCount: number;
};

function registrationBalance(registration: SystemAdminEventSource["registrations"][number]) {
  const paidCents = registration.payments.reduce((paymentTotal, payment) => {
    const refundedCents = payment.refunds.reduce(
      (refundTotal, refund) => refundTotal + refund.amountCents,
      0,
    );
    return paymentTotal + payment.amountCents - refundedCents;
  }, 0);
  return Math.max(registration.totalAmountCents - paidCents, 0);
}

function eventTiming(event: Pick<SystemAdminEventSource, "startsAt" | "endsAt">, now: Date) {
  if (event.endsAt < now) return "PAST" as const;
  if (event.startsAt > now) return "UPCOMING" as const;
  return "IN_PROGRESS" as const;
}

export function buildSystemAdminDashboard(source: SystemAdminDashboardSource, now = new Date()) {
  const events = source.events.map((event) => {
    const activeRegistrations = event.registrations.filter((registration) =>
      activeRegistrationStatuses.has(registration.status)
    );
    const ledgerBalanceCents = activeRegistrations.reduce(
      (total, registration) => total + registrationBalance(registration),
      0,
    );
    const setupWarnings = [
      !event.isPublished ? "Event is not published" : null,
      event.publishedFormCount === 0 ? "No published registration form" : null,
      event.importIssueCount > 0
        ? `${event.importIssueCount} import ${event.importIssueCount === 1 ? "issue" : "issues"}`
        : null,
      event.deliveryIssueCount > 0
        ? `${event.deliveryIssueCount} delivery ${event.deliveryIssueCount === 1 ? "issue" : "issues"}`
        : null,
    ].filter((warning): warning is string => Boolean(warning));

    return {
      ...event,
      activeRegistrationCount: activeRegistrations.length,
      ledgerBalanceCents,
      registrationPhase: evaluateEventRegistrationPhase(event, now),
      timing: eventTiming(event, now),
      setupWarnings,
      exceptionCount: event.importIssueCount + event.deliveryIssueCount,
    };
  }).sort((left, right) => {
    const timingRank = { IN_PROGRESS: 0, UPCOMING: 1, PAST: 2 } as const;
    return timingRank[left.timing] - timingRank[right.timing]
      || (left.timing === "PAST"
        ? right.startsAt.getTime() - left.startsAt.getTime()
        : left.startsAt.getTime() - right.startsAt.getTime());
  });

  return {
    generatedAt: now.toISOString(),
    events,
    summary: {
      eventCount: events.length,
      currentEventCount: events.filter((event) => event.timing !== "PAST").length,
      publishedEventCount: events.filter((event) => event.isPublished).length,
      registrationCount: events.reduce((total, event) => total + event.activeRegistrationCount, 0),
      attendeeCount: events.reduce((total, event) => total + event.attendeeCount, 0),
      checkedInCount: events.reduce((total, event) => total + event.checkedInCount, 0),
      ledgerBalanceCents: events.reduce((total, event) => total + event.ledgerBalanceCents, 0),
      operationalIssueCount: events.reduce((total, event) => total + event.exceptionCount, 0)
        + source.unresolvedAlertCount,
      unresolvedAlertCount: source.unresolvedAlertCount,
      activeUserCount: source.activeUserCount,
      pendingUserCount: source.pendingUserCount,
      systemAdminCount: source.systemAdminCount,
    },
  };
}

export type SystemAdminDashboard = ReturnType<typeof buildSystemAdminDashboard>;
