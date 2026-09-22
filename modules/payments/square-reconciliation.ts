/**
 * Read-only reconciliation between Square and IMSDA Events: every payment
 * Square accepted for the configured location in a window, checked against
 * what this database recorded.
 *
 * It exists because the webhook is the only thing that ever marks a card
 * payment paid, and a webhook that never arrives — or that arrives and finds
 * nothing to attach to — is otherwise completely silent. A registration can be
 * settled in Square and read as unpaid here forever.
 *
 * Deliberately free of the `server-only` guard so an operator can run it from
 * a terminal against Production. It takes no money and writes nothing.
 */
import type { PrismaClient } from "@prisma/client";
import {
  listSquarePayments,
  type Fetcher,
  type SquareListedPayment,
} from "@/modules/payments/square-http";
import type { SquareRuntimeConfiguration } from "@/modules/payments/square-config-domain";
import {
  registrationBalanceCents,
  squareConfirmationCodeCandidates,
} from "@/modules/payments/square-domain";

export type SquareReconciliationFindingCode =
  /** Square and this database agree. Nothing to do. */
  | "RECORDED"
  /**
   * Square took the money, this database never recorded it, and the
   * confirmation code and amount both resolve cleanly. Replaying the Square
   * webhook for this payment will now apply it.
   */
  | "APPLICABLE"
  /** Unrecorded, and the note and reference carry no confirmation code. */
  | "NO_CONFIRMATION_CODE"
  /** Unrecorded, and no payable registration carries the code it names. */
  | "NO_REGISTRATION"
  /** Unrecorded, and the code it names matches more than one registration. */
  | "AMBIGUOUS_REGISTRATION"
  /** Unrecorded, and the amount does not equal the outstanding balance. */
  | "AMOUNT_MISMATCH"
  /** Unrecorded, and taken at a Square location this app does not serve. */
  | "OTHER_LOCATION";

export type SquareReconciliationFinding = {
  code: SquareReconciliationFindingCode;
  providerPaymentId: string;
  amountCents: number;
  currency: string;
  createdAt: string | null;
  confirmationCode: string | null;
  balanceCents: number | null;
  detail: string;
};

export type SquareReconciliationReport = {
  environment: string;
  locationId: string;
  beginTime: string;
  endTime: string | null;
  /** Completed Square payments examined in the window. */
  examined: number;
  findings: SquareReconciliationFinding[];
  /**
   * Webhook deliveries this app received and declined to act on in the window.
   * A large count here means Square is reaching the endpoint but nothing is
   * attaching — a different failure from no findings at all, which means
   * Square is not reaching it.
   */
  ignoredWebhookEvents: Array<{
    eventType: string;
    objectId: string | null;
    reason: string | null;
    occurredAt: string;
  }>;
  unreachableSquare: boolean;
};

const actionableCodes = new Set<SquareReconciliationFindingCode>([
  "APPLICABLE",
  "NO_CONFIRMATION_CODE",
  "NO_REGISTRATION",
  "AMBIGUOUS_REGISTRATION",
  "AMOUNT_MISMATCH",
]);

export function isActionable(finding: SquareReconciliationFinding) {
  return actionableCodes.has(finding.code);
}

async function classify(
  prisma: PrismaClient,
  configuration: SquareRuntimeConfiguration,
  payment: SquareListedPayment,
): Promise<SquareReconciliationFinding> {
  const base = {
    providerPaymentId: payment.id,
    amountCents: payment.amountCents,
    currency: payment.currency,
    createdAt: payment.createdAt,
    confirmationCode: null as string | null,
    balanceCents: null as number | null,
  };

  const recorded = await prisma.payment.findFirst({
    where: { externalReference: payment.id },
    select: { id: true, registration: { select: { confirmationCode: true } } },
  });
  if (recorded) {
    return {
      ...base,
      code: "RECORDED",
      confirmationCode: recorded.registration.confirmationCode,
      detail: "Recorded in IMSDA Events.",
    };
  }
  const attempt = await prisma.paymentAttempt.findFirst({
    where: { providerPaymentId: payment.id },
    select: { status: true, registration: { select: { confirmationCode: true } } },
  });
  if (attempt) {
    return {
      ...base,
      code: "RECORDED",
      confirmationCode: attempt.registration.confirmationCode,
      detail: `Tracked by a payment attempt in state ${attempt.status}.`,
    };
  }
  if (payment.locationId && payment.locationId !== configuration.locationId) {
    return {
      ...base,
      code: "OTHER_LOCATION",
      detail: "Taken at a Square location this app does not serve.",
    };
  }

  const candidates = squareConfirmationCodeCandidates({
    note: payment.note,
    reference_id: payment.referenceId,
  });
  if (candidates.length === 0) {
    return {
      ...base,
      code: "NO_CONFIRMATION_CODE",
      detail: "Neither the note nor the reference names a confirmation code.",
    };
  }
  const registrations = await prisma.registration.findMany({
    where: {
      confirmationCode: { in: candidates },
      status: { in: ["SUBMITTED", "CONFIRMED"] },
    },
    select: {
      confirmationCode: true,
      totalAmount: true,
      payments: {
        where: { status: "SUCCEEDED" },
        select: {
          amount: true,
          refunds: { where: { status: "SUCCEEDED" }, select: { amount: true } },
        },
      },
    },
    take: 2,
  });
  if (registrations.length === 0) {
    return {
      ...base,
      code: "NO_REGISTRATION",
      detail: `No payable registration is named ${candidates.join(" or ")}.`,
    };
  }
  if (registrations.length > 1) {
    return {
      ...base,
      code: "AMBIGUOUS_REGISTRATION",
      detail: "More than one registration carries the confirmation code it names.",
    };
  }
  const registration = registrations[0]!;
  const balanceCents = registrationBalanceCents(registration);
  if (payment.amountCents !== balanceCents) {
    return {
      ...base,
      code: "AMOUNT_MISMATCH",
      confirmationCode: registration.confirmationCode,
      balanceCents,
      detail: "The amount does not equal the outstanding balance, so it needs a human decision.",
    };
  }
  return {
    ...base,
    code: "APPLICABLE",
    confirmationCode: registration.confirmationCode,
    balanceCents,
    detail: "Unrecorded here, and it settles the balance exactly. Replay the Square webhook to apply it.",
  };
}

export async function collectSquareReconciliationReport(
  prisma: PrismaClient,
  configuration: SquareRuntimeConfiguration,
  options: { beginTime: string; endTime?: string; maxPages?: number },
  fetcher: Fetcher = fetch,
): Promise<SquareReconciliationReport> {
  const findings: SquareReconciliationFinding[] = [];
  const maxPages = options.maxPages ?? 20;
  let cursor: string | null = null;
  let examined = 0;
  let unreachableSquare = false;

  for (let page = 0; page < maxPages; page += 1) {
    let batch: Awaited<ReturnType<typeof listSquarePayments>>;
    try {
      batch = await listSquarePayments(
        configuration,
        {
          beginTime: options.beginTime,
          endTime: options.endTime,
          cursor,
        },
        fetcher,
      );
    } catch {
      // A report that lists what the webhook already declined is still worth
      // printing when Square itself cannot be reached.
      unreachableSquare = true;
      break;
    }
    for (const payment of batch.payments) {
      if (payment.status !== "COMPLETED") continue;
      examined += 1;
      findings.push(await classify(prisma, configuration, payment));
    }
    cursor = batch.cursor;
    if (!cursor) break;
  }

  const ignored = await prisma.squareWebhookEvent.findMany({
    where: {
      status: "IGNORED",
      occurredAt: {
        gte: new Date(options.beginTime),
        ...(options.endTime ? { lte: new Date(options.endTime) } : {}),
      },
    },
    orderBy: { occurredAt: "desc" },
    take: 100,
    select: {
      eventType: true,
      objectId: true,
      reason: true,
      occurredAt: true,
    },
  });

  return {
    environment: configuration.environment,
    locationId: configuration.locationId,
    beginTime: options.beginTime,
    endTime: options.endTime ?? null,
    examined,
    findings,
    ignoredWebhookEvents: ignored.map((row) => ({
      eventType: row.eventType,
      objectId: row.objectId,
      reason: row.reason,
      occurredAt: row.occurredAt.toISOString(),
    })),
    unreachableSquare,
  };
}
