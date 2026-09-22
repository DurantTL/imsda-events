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
  /** Import runs that failed or rejected rows. */
  importIssueCount: number;
  /** Import runs that completed with warnings only — worth a look, not an exception. */
  importWarningCount: number;
  deliveryIssueCount: number;
};

export type SetupWarningKind = "UNPUBLISHED" | "NO_PUBLISHED_FORM" | "IMPORT_ISSUES" | "IMPORT_WARNINGS" | "DELIVERY_ISSUES";

export type SetupWarning = {
  kind: SetupWarningKind;
  label: string;
  /** Counted in "operational exceptions". Import warnings are listed but not counted. */
  exception: boolean;
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
    const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
    const setupWarnings: SetupWarning[] = [
      !event.isPublished
        ? { kind: "UNPUBLISHED" as const, label: "Event is not published", exception: false }
        : null,
      event.publishedFormCount === 0
        ? { kind: "NO_PUBLISHED_FORM" as const, label: "No published registration form", exception: false }
        : null,
      event.importIssueCount > 0
        ? { kind: "IMPORT_ISSUES" as const, label: plural(event.importIssueCount, "import run failed or rejected rows", "import runs failed or rejected rows"), exception: true }
        : null,
      event.importWarningCount > 0
        ? { kind: "IMPORT_WARNINGS" as const, label: plural(event.importWarningCount, "import run has warnings", "import runs have warnings"), exception: false }
        : null,
      event.deliveryIssueCount > 0
        ? { kind: "DELIVERY_ISSUES" as const, label: plural(event.deliveryIssueCount, "email failed or bounced", "emails failed or bounced"), exception: true }
        : null,
    ].filter((warning): warning is SetupWarning => warning !== null);
    const timing = eventTiming(event, now);

    return {
      ...event,
      activeRegistrationCount: activeRegistrations.length,
      ledgerBalanceCents,
      registrationPhase: evaluateEventRegistrationPhase(event, now),
      timing,
      /** Whole days until the event starts; null once it has started. */
      daysUntilStart: timing === "UPCOMING"
        ? Math.ceil((event.startsAt.getTime() - now.getTime()) / 86_400_000)
        : null,
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
