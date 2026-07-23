import {
  getAvailabilityMode,
  registrationFormDefinitionSchema,
} from "@/modules/forms/definition";
import type { OperationalHealthAccess } from "@/modules/operations/access";

export const PAYMENT_STUCK_AFTER_MINUTES = 15;
export const MESSAGE_OVERDUE_AFTER_MINUTES = 15;
export const CAPACITY_NEAR_PERCENT = 90;

const activeRegistrationStatuses = new Set(["SUBMITTED", "CONFIRMED"]);
const problemDeliveryStatuses = new Set(["BOUNCED", "COMPLAINED", "FAILED"]);

export type OperationalSeverity = "URGENT" | "WATCH";

export type OperationalHealthSource = {
  paymentAttempts: Array<{
    id: string;
    registrationId: string;
    confirmationCode: string;
    status: string;
    amountCents: number;
    failureCode: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>;
  messages: Array<{
    id: string;
    registrationId: string | null;
    confirmationCode: string | null;
    templateKey: string;
    status: string;
    providerDeliveryStatus: string | null;
    attemptCount: number;
    availableAt: Date;
    createdAt: Date;
    updatedAt: Date;
    hasRetry: boolean;
  }>;
  importRuns: Array<{
    id: string;
    fileName: string;
    status: string;
    warnings: number;
    errors: number;
    startedAt: Date;
    records: Array<{ status: string }>;
  }>;
  registrations: Array<{
    id: string;
    confirmationCode: string;
    status: string;
    totalAmountCents: number;
    submittedAt: Date | null;
    createdAt: Date;
    payments: Array<{
      amountCents: number;
      refunds: Array<{ amountCents: number }>;
    }>;
  }>;
  eventCapacity: {
    capacity: number | null;
    occupied: number;
  } | null;
  forms: Array<{
    id: string;
    name: string;
    versionId: string;
    definition: unknown;
  }>;
  capacityUsage: Array<{
    formId: string;
    fieldId: string;
    optionValue: string;
    used: number;
  }>;
};

export type PaymentAttemptIssue = {
  id: string;
  registrationId: string;
  confirmationCode: string;
  kind: "FAILED" | "STUCK";
  severity: OperationalSeverity;
  amountCents: number;
  status: string;
  failureCode: string | null;
  occurredAt: string;
  ageMinutes: number;
};

export type MessageIssue = {
  id: string;
  registrationId: string | null;
  confirmationCode: string | null;
  kind: "FAILED" | "BOUNCED" | "COMPLAINED" | "DELIVERY_FAILED" | "OVERDUE";
  severity: OperationalSeverity;
  templateKey: string;
  attemptCount: number;
  occurredAt: string;
  ageMinutes: number;
};

export type ImportIssue = {
  id: string;
  fileName: string;
  status: string;
  severity: OperationalSeverity;
  errors: number;
  warnings: number;
  startedAt: string;
};

export type BalanceIssue = {
  registrationId: string;
  confirmationCode: string;
  severity: "WATCH";
  totalAmountCents: number;
  paidCents: number;
  balanceCents: number;
  submittedAt: string | null;
};

export type CapacityIssue = {
  id: string;
  kind: "EVENT" | "CHOICE";
  severity: OperationalSeverity;
  label: string;
  detail: string;
  formId: string | null;
  used: number;
  limit: number;
  remaining: number;
  percentUsed: number;
};

export type OperationalHealth = {
  generatedAt: string;
  access: OperationalHealthAccess;
  summary: {
    total: number;
    urgent: number;
    watch: number;
  };
  paymentAttempts: PaymentAttemptIssue[];
  messages: MessageIssue[];
  imports: ImportIssue[];
  balances: BalanceIssue[];
  capacity: CapacityIssue[];
};

function ageMinutes(now: Date, then: Date) {
  return Math.max(0, Math.floor((now.getTime() - then.getTime()) / 60_000));
}

function severityRank(severity: OperationalSeverity) {
  return severity === "URGENT" ? 0 : 1;
}

function atOrNearCapacity(used: number, limit: number) {
  const safeUsed = Math.max(0, used);
  const remaining = Math.max(0, limit - safeUsed);
  const percentUsed = Math.round((safeUsed / limit) * 100);
  if (safeUsed >= limit) {
    return {
      severity: "URGENT" as const,
      remaining,
      percentUsed,
    };
  }
  const nearRemaining = Math.max(1, Math.ceil(limit * ((100 - CAPACITY_NEAR_PERCENT) / 100)));
  if (safeUsed > 0 && remaining <= nearRemaining) {
    return {
      severity: "WATCH" as const,
      remaining,
      percentUsed,
    };
  }
  return null;
}

function registrationBalance(
  registration: OperationalHealthSource["registrations"][number],
) {
  const paidCents = registration.payments.reduce((paymentTotal, payment) => {
    const refundedCents = payment.refunds.reduce(
      (refundTotal, refund) => refundTotal + refund.amountCents,
      0,
    );
    return paymentTotal + payment.amountCents - refundedCents;
  }, 0);
  return {
    paidCents,
    balanceCents: Math.max(registration.totalAmountCents - paidCents, 0),
  };
}

function paymentAttemptIssues(
  source: OperationalHealthSource,
  now: Date,
): PaymentAttemptIssue[] {
  const balances = new Map(
    source.registrations
      .filter((registration) => activeRegistrationStatuses.has(registration.status))
      .map((registration) => [
        registration.id,
        registrationBalance(registration).balanceCents,
      ]),
  );
  const latestByRegistration = new Map<
    string,
    OperationalHealthSource["paymentAttempts"][number]
  >();
  for (const attempt of source.paymentAttempts) {
    const current = latestByRegistration.get(attempt.registrationId);
    if (!current || attempt.updatedAt > current.updatedAt) {
      latestByRegistration.set(attempt.registrationId, attempt);
    }
  }

  return [...latestByRegistration.values()]
    .flatMap((attempt): PaymentAttemptIssue[] => {
      if ((balances.get(attempt.registrationId) ?? 0) <= 0) return [];
      const minutes = ageMinutes(now, attempt.updatedAt);
      if (attempt.status === "FAILED") {
        return [{
          id: attempt.id,
          registrationId: attempt.registrationId,
          confirmationCode: attempt.confirmationCode,
          kind: "FAILED",
          severity: "URGENT",
          amountCents: attempt.amountCents,
          status: attempt.status,
          failureCode: attempt.failureCode,
          occurredAt: attempt.updatedAt.toISOString(),
          ageMinutes: minutes,
        }];
      }
      if (
        (attempt.status === "PROCESSING" || attempt.status === "PENDING")
        && minutes >= PAYMENT_STUCK_AFTER_MINUTES
      ) {
        return [{
          id: attempt.id,
          registrationId: attempt.registrationId,
          confirmationCode: attempt.confirmationCode,
          kind: "STUCK",
          severity: "WATCH",
          amountCents: attempt.amountCents,
          status: attempt.status,
          failureCode: null,
          occurredAt: attempt.updatedAt.toISOString(),
          ageMinutes: minutes,
        }];
      }
      return [];
    })
    .sort((left, right) => (
      severityRank(left.severity) - severityRank(right.severity)
      || right.ageMinutes - left.ageMinutes
      || left.confirmationCode.localeCompare(right.confirmationCode)
    ));
}

function messageIssues(
  messages: OperationalHealthSource["messages"],
  now: Date,
): MessageIssue[] {
  return messages.flatMap((message): MessageIssue[] => {
    if (message.hasRetry) return [];
    const minutes = ageMinutes(
      now,
      message.status === "PENDING" ? message.availableAt : message.updatedAt,
    );
    const delivery = message.providerDeliveryStatus;
    if (delivery && problemDeliveryStatuses.has(delivery)) {
      const kind = delivery === "BOUNCED"
        ? "BOUNCED"
        : delivery === "COMPLAINED"
          ? "COMPLAINED"
          : "DELIVERY_FAILED";
      return [{
        id: message.id,
        registrationId: message.registrationId,
        confirmationCode: message.confirmationCode,
        kind,
        severity: "URGENT",
        templateKey: message.templateKey,
        attemptCount: message.attemptCount,
        occurredAt: message.updatedAt.toISOString(),
        ageMinutes: minutes,
      }];
    }
    if (message.status === "FAILED") {
      return [{
        id: message.id,
        registrationId: message.registrationId,
        confirmationCode: message.confirmationCode,
        kind: "FAILED",
        severity: "URGENT",
        templateKey: message.templateKey,
        attemptCount: message.attemptCount,
        occurredAt: message.updatedAt.toISOString(),
        ageMinutes: minutes,
      }];
    }
    if (
      message.status === "PENDING"
      && now.getTime() - message.availableAt.getTime()
        >= MESSAGE_OVERDUE_AFTER_MINUTES * 60_000
    ) {
      return [{
        id: message.id,
        registrationId: message.registrationId,
        confirmationCode: message.confirmationCode,
        kind: "OVERDUE",
        severity: "WATCH",
        templateKey: message.templateKey,
        attemptCount: message.attemptCount,
        occurredAt: message.availableAt.toISOString(),
        ageMinutes: minutes,
      }];
    }
    return [];
  }).sort((left, right) => (
    severityRank(left.severity) - severityRank(right.severity)
    || right.ageMinutes - left.ageMinutes
  ));
}

function importIssues(
  runs: OperationalHealthSource["importRuns"],
): ImportIssue[] {
  return runs.flatMap((run): ImportIssue[] => {
    if (run.status === "COMPLETED") return [];
    const recordErrors = run.records.filter((record) => record.status === "ERROR").length;
    const recordWarnings = run.records.filter((record) => record.status === "WARNING").length;
    const errors = Math.max(run.errors, recordErrors);
    const warnings = Math.max(run.warnings, recordWarnings);
    if (run.status !== "FAILED" && errors === 0 && warnings === 0) return [];
    return [{
      id: run.id,
      fileName: run.fileName,
      status: run.status,
      severity: run.status === "FAILED" || errors > 0 ? "URGENT" : "WATCH",
      errors,
      warnings,
      startedAt: run.startedAt.toISOString(),
    }];
  }).sort((left, right) => (
    severityRank(left.severity) - severityRank(right.severity)
    || new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime()
  ));
}

function balanceIssues(
  registrations: OperationalHealthSource["registrations"],
): BalanceIssue[] {
  return registrations.flatMap((registration): BalanceIssue[] => {
    if (!activeRegistrationStatuses.has(registration.status)) return [];
    const balance = registrationBalance(registration);
    if (balance.balanceCents <= 0) return [];
    return [{
      registrationId: registration.id,
      confirmationCode: registration.confirmationCode,
      severity: "WATCH",
      totalAmountCents: registration.totalAmountCents,
      paidCents: balance.paidCents,
      balanceCents: balance.balanceCents,
      submittedAt: registration.submittedAt?.toISOString() ?? null,
    }];
  }).sort((left, right) => (
    right.balanceCents - left.balanceCents
    || left.confirmationCode.localeCompare(right.confirmationCode)
  ));
}

function capacityIssues(source: OperationalHealthSource): CapacityIssue[] {
  const issues: CapacityIssue[] = [];
  if (source.eventCapacity?.capacity) {
    const state = atOrNearCapacity(
      source.eventCapacity.occupied,
      source.eventCapacity.capacity,
    );
    if (state) {
      issues.push({
        id: "event-capacity",
        kind: "EVENT",
        severity: state.severity,
        label: "Overall event capacity",
        detail: state.severity === "URGENT"
          ? "The event has reached its configured limit."
          : "The event is within the final 10% of its configured limit.",
        formId: null,
        used: source.eventCapacity.occupied,
        limit: source.eventCapacity.capacity,
        remaining: state.remaining,
        percentUsed: state.percentUsed,
      });
    }
  }

  const usage = new Map(
    source.capacityUsage.map((entry) => [
      `${entry.formId}\u0000${entry.fieldId}\u0000${entry.optionValue}`,
      entry.used,
    ]),
  );
  for (const form of source.forms) {
    const parsed = registrationFormDefinitionSchema.safeParse(form.definition);
    if (!parsed.success) continue;
    for (const field of parsed.data.sections.flatMap((section) => section.fields)) {
      if (getAvailabilityMode(field) !== "CAPACITY") continue;
      for (const [option, limit] of Object.entries(field.choiceLimits ?? {})) {
        const used = usage.get(`${form.id}\u0000${field.id}\u0000${option}`) ?? 0;
        const state = atOrNearCapacity(used, limit);
        if (!state) continue;
        issues.push({
          id: `${form.id}:${field.id}:${option}`,
          kind: "CHOICE",
          severity: state.severity,
          label: option,
          detail: `${form.name} · ${field.label}`,
          formId: form.id,
          used,
          limit,
          remaining: state.remaining,
          percentUsed: state.percentUsed,
        });
      }
    }
  }

  return issues.sort((left, right) => (
    severityRank(left.severity) - severityRank(right.severity)
    || right.percentUsed - left.percentUsed
    || left.label.localeCompare(right.label)
  ));
}

export function buildOperationalHealth(
  source: OperationalHealthSource,
  access: OperationalHealthAccess,
  now = new Date(),
): OperationalHealth {
  const paymentAttempts = access.finance
    ? paymentAttemptIssues(source, now)
    : [];
  const messages = access.communications
    ? messageIssues(source.messages, now)
    : [];
  const imports = access.imports ? importIssues(source.importRuns) : [];
  const balances = access.finance
    ? balanceIssues(source.registrations)
    : [];
  const capacity = access.capacity ? capacityIssues(source) : [];
  const allSeverities = [
    ...paymentAttempts,
    ...messages,
    ...imports,
    ...balances,
    ...capacity,
  ].map((issue) => issue.severity);

  return {
    generatedAt: now.toISOString(),
    access,
    summary: {
      total: allSeverities.length,
      urgent: allSeverities.filter((severity) => severity === "URGENT").length,
      watch: allSeverities.filter((severity) => severity === "WATCH").length,
    },
    paymentAttempts,
    messages,
    imports,
    balances,
    capacity,
  };
}
