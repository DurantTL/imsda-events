import "server-only";

import { randomUUID } from "node:crypto";
import {
  Prisma,
  type PaymentAttemptStatus,
  type PrismaClient,
  type RefundStatus,
} from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { dispatchAlerts, type Alert } from "@/modules/operations/alerting";
import {
  flushHostedDeletionsAfterResponse,
  invalidateHostedCheckoutsInTransaction,
} from "@/modules/payments/square-hosted-invalidation";
import {
  createSquarePayment,
  SquareAdapterError,
  type SquarePaymentResult,
} from "@/modules/payments/square-adapter";
import {
  getSquareConfiguration,
  publicSquareConfiguration,
  type SquareRuntimeConfiguration,
} from "@/modules/payments/square-config";
import {
  promotedWaitlistPaymentQuote,
  type PromotedWaitlistPaymentChoiceView,
} from "@/modules/payments/payment-choice-domain";
import {
  cardSurchargeForBalance,
  duplicateChargeEvidence,
  hostedPaymentStaleReason,
  internalPaymentState,
  internalRefundStatus,
  moneyToCents,
  providerIdempotencyKey,
  registrationBalanceCents,
  selectedCardPayment,
  squareConfirmationCodeCandidates,
  type ParsedSquareWebhookEvent,
  type SquareCheckoutView,
  type SquarePaymentInput,
} from "@/modules/payments/square-domain";
import { processQueuedMessageIdsAfterCommit } from "@/modules/communications/messaging-repository";
import {
  enqueuePaymentReceiptMessage,
  enqueueRefundNoticeMessage,
} from "@/modules/communications/transactional-messages";
import { authorizeRegistrationAccessToken } from "@/modules/public-access/repository";
import { logError } from "@/lib/logger";

export type PaymentClient = Prisma.TransactionClient | PrismaClient;
export type PaymentAccess = {
  accessTokenId: string | null;
  registrationId: string;
  eventId: string;
};
export type PaymentAuthorization =
  | { kind: "private-link"; token: string }
  | { kind: "attendee-account"; access: PaymentAccess };

export type SquarePaymentOperationErrorCode =
  | "REGISTRATION_ACCESS_UNAVAILABLE"
  | "SQUARE_NOT_CONFIGURED"
  | "PAYMENT_NOT_ELIGIBLE"
  | "CARD_PAYMENT_NOT_SELECTED"
  | "PAYMENT_ALREADY_COMPLETE"
  | "PAYMENT_IN_PROGRESS"
  | "PAYMENT_IDEMPOTENCY_CONFLICT"
  | "PAYMENT_ATTEMPT_FAILED"
  | "PAYMENT_DECLINED"
  | "PAYMENT_RESULT_UNCERTAIN"
  | "PAYMENT_REQUIRES_REVIEW"
  | "PAYMENT_OPERATION_CONFLICT";

export class SquarePaymentOperationError extends Error {
  constructor(
    public readonly code: SquarePaymentOperationErrorCode,
    message: string,
    public readonly retryable = false,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "SquarePaymentOperationError";
  }
}

const checkoutRegistrationSelect = {
  id: true,
  eventId: true,
  confirmationCode: true,
  status: true,
  totalAmount: true,
  contactSnapshot: true,
  event: {
    select: { billingMode: true, hostedPaymentLinkEnabled: true },
  },
  accountHolderPerson: {
    select: {
      firstName: true,
      lastName: true,
      normalizedEmail: true,
      phone: true,
    },
  },
  payments: {
    where: { status: "SUCCEEDED" as const },
    select: {
      amount: true,
      refunds: {
        where: { status: "SUCCEEDED" as const },
        select: { amount: true },
      },
    },
  },
  paymentAttempts: {
    where: {
      status: { in: ["PROCESSING", "PENDING", "SUCCEEDED"] as const },
      // A Pay on Square link nobody has paid through yet is an offer, not a started payment: it
      // must not lock the payment choice. It is withdrawn when the choice changes.
      NOT: { channel: "HOSTED_LINK" as const, providerPaymentId: null },
    },
    take: 1,
    select: { id: true, status: true },
  },
  waitlistEntry: {
    select: { status: true },
  },
  paymentChoiceOperations: {
    orderBy: { sequence: "desc" as const },
    take: 1,
    select: {
      id: true,
      choice: true,
      baseSubtotalCents: true,
      processingFeeCents: true,
      resultingTotalCents: true,
    },
  },
  publicFormSubmission: {
    select: {
      responses: true,
      pricingSnapshot: true,
      formVersion: {
        select: {
          status: true,
          definition: true,
          form: { select: { versions: { where: { status: "PUBLISHED" }, select: { id: true }, take: 1 } } },
        },
      },
    },
  },
} satisfies Prisma.RegistrationSelect;

export type CheckoutRegistration = Prisma.RegistrationGetPayload<{
  select: typeof checkoutRegistrationSelect;
}>;

export const attemptInclude = {
  payment: true,
  registration: {
    select: {
      confirmationCode: true,
    },
  },
} satisfies Prisma.PaymentAttemptInclude;

export type AttemptRecord = Prisma.PaymentAttemptGetPayload<{
  include: typeof attemptInclude;
}>;

type AppliedProviderPayment = {
  attempt: AttemptRecord;
  pendingMessageIds: string[];
  /** Raised after the transaction commits: a duplicate charge pages staff. */
  alerts?: Alert[];
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function billingContact(registration: CheckoutRegistration) {
  const snapshot = record(registration.contactSnapshot);
  const accountHolder = registration.accountHolderPerson;
  return {
    givenName: nonEmptyString(snapshot.firstName)
      ?? accountHolder.firstName,
    familyName: nonEmptyString(snapshot.lastName)
      ?? accountHolder.lastName,
    email: nonEmptyString(snapshot.email)?.toLowerCase()
      ?? accountHolder.normalizedEmail
      ?? "",
    phone: typeof snapshot.phone === "string"
      ? snapshot.phone.trim()
      : accountHolder.phone ?? "",
  };
}

export function checkoutFromRegistration(
  registration: CheckoutRegistration,
  configuration: SquareRuntimeConfiguration,
): SquareCheckoutView {
  if (registration.event.billingMode === "DEFERRED_ORGANIZATION_INVOICE") {
    // A deferred-organization event must never take an online card payment, even if a form were
    // misconfigured with payment enabled: it bills the responsible organization directly. Nothing
    // about what is owed is returned, so the endpoint cannot leak a total (#621).
    return {
      state: "NOT_ELIGIBLE",
      message: "This event bills the responsible organization directly. No online payment is available.",
      currency: "USD",
    };
  }
  const submission = registration.publicFormSubmission;
  const promotedWaitlist = registration.waitlistEntry?.status === "PROMOTED";
  const promotedQuote = promotedWaitlist && submission
    ? promotedWaitlistPaymentQuote(
        submission.formVersion.definition,
        submission.pricingSnapshot,
      )
    : null;
  const latestPaymentChoice = registration.paymentChoiceOperations[0] ?? null;
  const promotedChoiceConsistent = Boolean(
    promotedQuote
    && moneyToCents(registration.totalAmount)
      === (
        latestPaymentChoice?.resultingTotalCents
        ?? promotedQuote.payLaterTotalCents
      )
    && (
      !latestPaymentChoice
      || (
        latestPaymentChoice.baseSubtotalCents
          === promotedQuote.baseSubtotalCents
        && latestPaymentChoice.resultingTotalCents
          === latestPaymentChoice.baseSubtotalCents
            + latestPaymentChoice.processingFeeCents
      )
    )
  );
  const paymentChoice: PromotedWaitlistPaymentChoiceView | null =
    promotedWaitlist && promotedQuote
      ? {
          available: (
            registration.status === "SUBMITTED"
            || registration.status === "CONFIRMED"
          ) && promotedChoiceConsistent,
          locked: registration.paymentAttempts.length > 0
            || registration.payments.length > 0,
          selected: latestPaymentChoice?.choice ?? null,
          currentOperationId: latestPaymentChoice?.id ?? null,
          ...promotedQuote,
        }
      : null;
  const paymentSelection = promotedWaitlist
    ? {
        configured: Boolean(promotedQuote),
        cardSelected: latestPaymentChoice?.choice === "CARD",
      }
    : submission
    ? selectedCardPayment({
        definition: submission.formVersion.definition,
        responses: submission.responses,
        formHasPublishedVersion: submission.formVersion.form.versions.length > 0,
      })
    : { configured: false, cardSelected: false };
  const balanceCents = registrationBalanceCents(registration);
  // A registration priced for card already carries its fee in the total. One
  // that chose pay-later does not, so settling it by card now adds the same
  // surcharge the card path always charged — computed on what is actually
  // being run through the card, which is the outstanding balance.
  //
  // A promoted waitlist registration is excluded because it already owns this
  // decision: its payment choice re-prices the total and records the fee as an
  // operation, and it asserts the total still matches that record. Two things
  // writing one total is how a registration ends up disagreeing with itself,
  // so a promoted registrant adds the fee by switching their choice to card,
  // not by being surcharged here.
  const surchargeCents = promotedWaitlist
    || paymentSelection.cardSelected
    || !submission
    ? 0
    : cardSurchargeForBalance(
        submission.formVersion.definition,
        balanceCents,
      );
  const amountCents = balanceCents + surchargeCents;
  const base = {
    amountCents,
    balanceCents,
    surchargeCents,
    currency: "USD" as const,
    cardSelected: paymentSelection.cardSelected,
    hostedLink: false,
    paymentChoice,
    square: null,
    billingContact: billingContact(registration),
  };

  if (!paymentSelection.configured) {
    return {
      ...base,
      state: "FORM_UNAVAILABLE",
      message: "This registration does not have an active published card-payment configuration. Contact the event team for payment options.",
    };
  }
  if (promotedWaitlist && !promotedChoiceConsistent) {
    return {
      ...base,
      state: "FORM_UNAVAILABLE",
      message: "The promoted waitlist payment total needs review. Contact the event team before paying.",
    };
  }
  if (
    registration.status !== "SUBMITTED"
    && registration.status !== "CONFIRMED"
  ) {
    return {
      ...base,
      state: "NOT_ELIGIBLE",
      message: registration.status === "WAITLISTED"
        ? "No payment is due while this registration is on the waitlist."
        : "This registration is not currently eligible for online payment.",
    };
  }
  if (promotedWaitlist && !latestPaymentChoice) {
    return {
      ...base,
      state: "CHOICE_REQUIRED",
      message: "A place is now available. Choose how you want to pay before continuing.",
    };
  }
  if (balanceCents <= 0) {
    return {
      ...base,
      state: "NO_BALANCE",
      message: "The registration has no remaining balance.",
    };
  }
  const square = publicSquareConfiguration(configuration);
  if (!square) {
    return {
      ...base,
      state: "NOT_CONFIGURED",
      message: "Online card payment is not configured yet. The registration is saved, and the event team can provide another payment option.",
    };
  }
  return {
    ...base,
    state: "READY",
    // "Pay on Square" (#327) is a per-event setting, off unless staff turn it on, and is offered
    // exactly when the embedded form is: same state, same amount.
    hostedLink: registration.event.hostedPaymentLinkEnabled,
    // Choosing pay-later at registration decides how the total was priced —
    // it never decided whether a card may be used afterwards. A balance
    // reminder that says "pay now" has to land on a page that can take the
    // payment, so an outstanding balance opens the card form either way. The
    // total is untouched: no card processing fee is added after the fact.
    message: paymentSelection.cardSelected || surchargeCents === 0
      ? "Secure card payment is available through Square."
      : "This registration chose to pay later. The balance can still be paid by card now, with the same card processing fee a card registration is charged.",
    square,
  };
}

export async function loadCheckoutRegistration(
  client: PaymentClient,
  registrationId: string,
) {
  return client.registration.findUnique({
    where: { id: registrationId },
    select: checkoutRegistrationSelect,
  });
}

export async function getPublicSquareCheckout(
  token: string,
  options: {
    now?: Date;
    client?: PaymentClient;
    configuration?: SquareRuntimeConfiguration;
  } = {},
) {
  const client = options.client ?? getPrisma();
  const access = await authorizeRegistrationAccessToken(token, {
    now: options.now,
    client,
  });
  if (!access) return null;
  const registration = await loadCheckoutRegistration(
    client,
    access.registrationId
  );
  if (!registration || registration.eventId !== access.eventId) return null;
  return checkoutFromRegistration(
    registration,
    options.configuration ?? getSquareConfiguration()
  );
}

export async function getAttendeeSquareCheckout(
  access: Omit<PaymentAccess, "accessTokenId">,
  options: {
    client?: PaymentClient;
    configuration?: SquareRuntimeConfiguration;
  } = {},
) {
  const client = options.client ?? getPrisma();
  const registration = await loadCheckoutRegistration(client, access.registrationId);
  if (!registration || registration.eventId !== access.eventId) return null;
  return checkoutFromRegistration(
    registration,
    options.configuration ?? getSquareConfiguration(),
  );
}

function operationErrorForCheckout(checkout: SquareCheckoutView): never {
  if (checkout.state === "NOT_CONFIGURED") {
    throw new SquarePaymentOperationError(
      "SQUARE_NOT_CONFIGURED",
      checkout.message
    );
  }
  if (
    checkout.state === "CHOICE_REQUIRED"
    || checkout.state === "FORM_UNAVAILABLE"
  ) {
    throw new SquarePaymentOperationError(
      "CARD_PAYMENT_NOT_SELECTED",
      checkout.message
    );
  }
  if (checkout.state === "NO_BALANCE") {
    throw new SquarePaymentOperationError(
      "PAYMENT_ALREADY_COMPLETE",
      checkout.message
    );
  }
  throw new SquarePaymentOperationError(
    "PAYMENT_NOT_ELIGIBLE",
    checkout.message
  );
}

function retryableTransactionError(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError
    && (error.code === "P2034" || error.code === "P2002")
  )
    // Two payment paths settling one balance can lock the same rows in opposite orders; the
    // loser is rolled back by PostgreSQL (deadlock 40P01, serialization failure 40001) and runs
    // again against what the winner committed.
    || (
      error instanceof Prisma.PrismaClientUnknownRequestError
      && /40P01|40001|deadlock detected/.test(error.message)
    );
}

export async function runSerializable<T>(
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  const prisma = getPrisma();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (!retryableTransactionError(error)) throw error;
    }
  }
  throw new SquarePaymentOperationError(
    "PAYMENT_OPERATION_CONFLICT",
    "Another payment changed this registration at the same time. Refresh and try again.",
    true
  );
}

type PreparedPaymentAttempt = {
  operation: "CALL_PROVIDER" | "RETURN_EXISTING";
  attempt: AttemptRecord;
};

export function resultFromAttempt(attempt: AttemptRecord) {
  const status = attempt.status === "SUCCEEDED"
    ? "SUCCEEDED" as const
    : attempt.status === "FAILED"
      ? "FAILED" as const
      : attempt.status === "CANCELED"
        ? "CANCELED" as const
        : "PENDING" as const;
  return {
    status,
    amountCents: attempt.amountCents,
    currency: "USD" as const,
    message: attempt.duplicateReason
      ? "This registration's balance was already paid, so this extra payment is not counted. The event team has been alerted and will refund it."
      : status === "SUCCEEDED"
      ? "Square confirmed the card payment."
      : status === "PENDING"
        ? "Square is still confirming the payment. Do not submit a second payment."
        : "Square did not complete the payment.",
  };
}

async function preparePaymentAttempt(
  tx: Prisma.TransactionClient,
  authorization: PaymentAuthorization,
  input: SquarePaymentInput,
  configuration: SquareRuntimeConfiguration,
  now: Date,
): Promise<PreparedPaymentAttempt> {
  const access = authorization.kind === "private-link"
    ? await authorizeRegistrationAccessToken(authorization.token, {
        now,
        client: tx,
      })
    : authorization.access;
  if (!access) {
    throw new SquarePaymentOperationError(
      "REGISTRATION_ACCESS_UNAVAILABLE",
      "This private registration link is invalid or no longer active."
    );
  }

  const existing = await tx.paymentAttempt.findUnique({
    where: { clientIdempotencyKey: input.idempotencyKey },
    include: attemptInclude,
  });
  if (existing) {
    if (
      existing.registrationId !== access.registrationId
      || existing.registrationAccessTokenId !== access.accessTokenId
      || existing.environment !== configuration.environment
    ) {
      throw new SquarePaymentOperationError(
        "PAYMENT_IDEMPOTENCY_CONFLICT",
        "That payment request key belongs to a different operation."
      );
    }
    if (existing.status === "FAILED" || existing.status === "CANCELED") {
      throw new SquarePaymentOperationError(
        "PAYMENT_ATTEMPT_FAILED",
        existing.failureMessage
          ?? "That payment attempt has finished. Start a new payment attempt."
      );
    }
    if (existing.status !== "PROCESSING") {
      return { operation: "RETURN_EXISTING", attempt: existing };
    }
    const retried = await tx.paymentAttempt.update({
      where: { id: existing.id },
      data: {
        requestCount: { increment: 1 },
        lastRequestedAt: now,
      },
      include: attemptInclude,
    });
    return { operation: "CALL_PROVIDER", attempt: retried };
  }

  const registration = await loadCheckoutRegistration(
    tx,
    access.registrationId
  );
  if (!registration || registration.eventId !== access.eventId) {
    throw new SquarePaymentOperationError(
      "REGISTRATION_ACCESS_UNAVAILABLE",
      "This private registration link is invalid or no longer active."
    );
  }
  const checkout = checkoutFromRegistration(registration, configuration);
  if (checkout.state !== "READY") operationErrorForCheckout(checkout);

  const activeAttempt = await tx.paymentAttempt.findUnique({
    where: { activeRegistrationKey: registration.id },
    select: { id: true, status: true },
  });
  if (activeAttempt) {
    throw new SquarePaymentOperationError(
      "PAYMENT_IN_PROGRESS",
      "A card payment is already being confirmed for this registration. Wait for that result before trying again.",
      true,
      { attemptStatus: activeAttempt.status }
    );
  }

  // A hosted "Pay on Square" link already handed out must not stay payable beside this attempt:
  // two paths charging one balance is the failure the first-payment-wins rule exists to prevent.
  await invalidateHostedCheckoutsInTransaction(tx, {
    registrationId: registration.id,
    reason: "EMBEDDED_ATTEMPT_STARTED",
    now,
  });

  const providerKey = providerIdempotencyKey(
    registration.id,
    input.idempotencyKey
  );
  const attempt = await tx.paymentAttempt.create({
    data: {
      eventId: registration.eventId,
      registrationId: registration.id,
      registrationAccessTokenId: access.accessTokenId,
      provider: "SQUARE",
      environment: configuration.environment,
      clientIdempotencyKey: input.idempotencyKey,
      providerIdempotencyKey: providerKey,
      activeRegistrationKey: registration.id,
      amountCents: checkout.amountCents,
      surchargeCents: checkout.surchargeCents,
      currency: "USD",
      status: "PROCESSING",
      requestCount: 1,
      lastRequestedAt: now,
    },
    include: attemptInclude,
  });
  await tx.auditLog.create({
    data: {
      eventId: registration.eventId,
      action: "SQUARE_PAYMENT_ATTEMPT_STARTED",
      entityType: "PaymentAttempt",
      entityId: attempt.id,
      correlationId: randomUUID(),
      summary: `Started a Square ${configuration.environment} card payment for registration ${registration.confirmationCode}.`,
      metadata: {
        provider: "SQUARE",
        environment: configuration.environment,
        amountCents: checkout.amountCents,
        balanceCents: checkout.balanceCents,
        surchargeCents: checkout.surchargeCents,
        currency: "USD",
        registrationAccessTokenId: access.accessTokenId,
      },
    },
  });
  return { operation: "CALL_PROVIDER", attempt };
}

function providerTimestamp(value: string | null, fallback: Date) {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? fallback : parsed;
}

function auditActionForAttemptStatus(status: PaymentAttemptStatus) {
  if (status === "SUCCEEDED") return "SQUARE_PAYMENT_COMPLETED";
  if (status === "FAILED") return "SQUARE_PAYMENT_FAILED";
  if (status === "CANCELED") return "SQUARE_PAYMENT_CANCELED";
  return "SQUARE_PAYMENT_PENDING";
}

/**
 * Whether the money in this attempt still fits the registration. The first payment recorded for a
 * balance wins; an attempt that succeeds after another payment settled that balance (or after the
 * registration stopped being payable) is a duplicate. Read inside the transaction that would record
 * the payment, so two simultaneous successes cannot both pass.
 */
async function successConflict(
  tx: Prisma.TransactionClient,
  attempt: AttemptRecord,
) {
  const registration = await tx.registration.findUnique({
    where: { id: attempt.registrationId },
    select: {
      status: true,
      totalAmount: true,
      payments: {
        where: { status: "SUCCEEDED" },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          amount: true,
          refunds: {
            where: { status: "SUCCEEDED" },
            select: { amount: true },
          },
        },
      },
    },
  });
  if (!registration) return null;
  const reason = hostedPaymentStaleReason({
    registrationStatus: registration.status,
    balanceCents: registrationBalanceCents(registration),
    quotedBalanceCents: attempt.amountCents - attempt.surchargeCents,
  });
  return reason
    ? { reason, winningPaymentId: registration.payments[0]?.id ?? null }
    : null;
}

const duplicateReasonText: Record<string, string> = {
  BALANCE_ALREADY_PAID: "the balance had already been paid",
  BALANCE_CHANGED: "the balance had fallen below the amount charged",
  REGISTRATION_NOT_PAYABLE: "the registration was no longer payable",
  SECOND_PAYMENT_ON_ORDER: "a payment had already been recorded through the same link",
  AMOUNT_MISMATCH: "its amount was not the amount quoted for the link",
};

/** The webhook row's reason for a payment the hosted page declined; read back to order late updates. */
const hostedDeclineReason = "A payment on the hosted page did not complete; the link stays payable.";

/**
 * Keeps the evidence of a processor-level exception and stops it counting as a valid payment: the
 * payment row stays PENDING (so the balance ignores it, no receipt is sent, no fee joins the
 * total), a `SquareDuplicateCharge` holds Square's identifiers, and staff are paged. Refunding it
 * stays a human action in Square; the refund webhook then resolves the record.
 *
 * `holdOnAttempt` is the usual case: the attempt itself is the late payment, so it carries the
 * payment. Without it (a second or split payment through an order whose attempt is already
 * settled, or still open) the winner's attempt is left exactly as it is and the new payment gets
 * its own row.
 */
async function recordDuplicateCharge(
  tx: Prisma.TransactionClient,
  attempt: AttemptRecord,
  provider: SquarePaymentResult & { orderId?: string | null },
  providerStatusAt: Date,
  now: Date,
  source: "CREATE_PAYMENT" | "WEBHOOK",
  conflict: { reason: string; winningPaymentId: string | null },
  options: { holdOnAttempt: boolean } = { holdOnAttempt: true },
): Promise<AppliedProviderPayment> {
  // A repeat of the same payment never records it twice.
  const alreadyRecorded = await tx.squareDuplicateCharge.findUnique({
    where: { providerPaymentId: provider.id },
    select: { id: true },
  });
  if (alreadyRecorded) return { attempt, pendingMessageIds: [] };

  const paymentData = {
    amount: provider.amountCents / 100,
    status: "PENDING" as const,
    method: "CARD_REFERENCE" as const,
    externalReference: provider.id,
    receivedAt: providerStatusAt,
  };
  const reusePayment = options.holdOnAttempt ? attempt.payment : null;
  const payment = reusePayment
    ? await tx.payment.update({ where: { id: reusePayment.id }, data: paymentData })
    : await tx.payment.create({
        data: {
          eventId: attempt.eventId,
          registrationId: attempt.registrationId,
          ...paymentData,
        },
      });
  let updated = attempt;
  if (options.holdOnAttempt) {
    updated = await tx.paymentAttempt.update({
      where: { id: attempt.id },
      data: {
        paymentId: payment.id,
        providerPaymentId: provider.id,
        providerStatus: provider.status,
        providerStatusAt,
        status: "SUCCEEDED",
        activeRegistrationKey: null,
        duplicateReason: conflict.reason,
        failureCode: "DUPLICATE_CHARGE",
        failureMessage: "Square took this payment after the balance had already been paid.",
        completedAt: now,
      },
      include: attemptInclude,
    });
    await tx.squareHostedCheckout.updateMany({
      where: { paymentAttemptId: attempt.id },
      data: { status: "PAID" },
    });
  }
  const evidence = duplicateChargeEvidence({
    id: provider.id,
    status: provider.status,
    amount_money: { amount: provider.amountCents, currency: provider.currency },
    order_id: provider.orderId ?? undefined,
    created_at: provider.createdAt ?? undefined,
    updated_at: provider.updatedAt ?? undefined,
  });
  await tx.squareDuplicateCharge.create({
    data: {
      eventId: attempt.eventId,
      registrationId: attempt.registrationId,
      paymentAttemptId: attempt.id,
      paymentId: payment.id,
      providerPaymentId: provider.id,
      providerOrderId: provider.orderId ?? null,
      environment: attempt.environment,
      reason: conflict.reason,
      amountCents: provider.amountCents,
      currency: provider.currency,
      winningPaymentId: conflict.winningPaymentId,
      evidence,
    },
  });
  const why = duplicateReasonText[conflict.reason] ?? conflict.reason;
  await tx.auditLog.create({
    data: {
      eventId: attempt.eventId,
      action: "SQUARE_DUPLICATE_CHARGE_DETECTED",
      entityType: "Payment",
      entityId: payment.id,
      correlationId: randomUUID(),
      summary: `Square took a ${attempt.channel === "HOSTED_LINK" ? "Pay on Square" : "card"} payment for registration ${attempt.registration.confirmationCode} that cannot be counted: ${why}. It needs a refund in Square.`,
      metadata: {
        priority: "HIGH",
        provider: "SQUARE",
        environment: attempt.environment,
        providerPaymentId: provider.id,
        providerOrderId: provider.orderId ?? null,
        paymentAttemptId: attempt.id,
        channel: attempt.channel,
        amountCents: provider.amountCents,
        quotedAmountCents: attempt.amountCents,
        reason: conflict.reason,
        winningPaymentId: conflict.winningPaymentId,
        source,
      },
    },
  });
  return {
    attempt: updated,
    pendingMessageIds: [],
    alerts: [{
      key: `payments.duplicate-charge.${provider.id}`,
      severity: "URGENT",
      summary: `Square took a payment for registration ${attempt.registration.confirmationCode} that cannot be counted`,
      detail: `Square payment ${provider.id} for ${(provider.amountCents / 100).toFixed(2)} USD: ${why}. It is not counted toward the balance. Review it and refund what is not owed in Square (a human action); IMSDA Events updates when Square confirms the refund.`,
      context: {
        registrationId: attempt.registrationId,
        providerPaymentId: provider.id,
        amountCents: provider.amountCents,
        reason: conflict.reason,
      },
    }],
  };
}

async function applyProviderPayment(
  tx: Prisma.TransactionClient,
  attempt: AttemptRecord,
  provider: SquarePaymentResult & { orderId?: string | null },
  providerStatusAt: Date,
  now: Date,
  source: "CREATE_PAYMENT" | "WEBHOOK",
): Promise<AppliedProviderPayment> {
  const state = internalPaymentState(provider.status);
  const stale = Boolean(
    attempt.providerStatusAt
    && attempt.providerStatusAt.getTime() > providerStatusAt.getTime()
  );
  const terminalRegression = attempt.status === "SUCCEEDED"
    && state.attemptStatus !== "SUCCEEDED";
  // A duplicate charge keeps its evidence and is never re-applied by a replayed webhook.
  if (stale || terminalRegression || attempt.duplicateReason) {
    return { attempt, pendingMessageIds: [] };
  }

  if (state.attemptStatus === "SUCCEEDED" && attempt.status !== "SUCCEEDED") {
    const conflict = await successConflict(tx, attempt);
    if (conflict) {
      return recordDuplicateCharge(
        tx,
        attempt,
        provider,
        providerStatusAt,
        now,
        source,
        conflict,
      );
    }
  }

  // An approved-but-unsettled hosted payment holds the registration's single in-flight slot only
  // when it is free; if an embedded attempt has it, the settled result decides who wins.
  let activeRegistrationKey: string | null = null;
  if (!state.terminal) {
    activeRegistrationKey = attempt.registrationId;
    if (attempt.channel === "HOSTED_LINK") {
      const holder = await tx.paymentAttempt.findUnique({
        where: { activeRegistrationKey: attempt.registrationId },
        select: { id: true },
      });
      if (holder && holder.id !== attempt.id) activeRegistrationKey = null;
    }
  }

  const priorStatus = attempt.status;
  const payment = attempt.payment
    ? await tx.payment.update({
        where: { id: attempt.payment.id },
        data: {
          amount: attempt.amountCents / 100,
          status: state.paymentStatus,
          method: "CARD_REFERENCE",
          externalReference: provider.id,
          receivedAt: state.paymentStatus === "SUCCEEDED"
            ? attempt.payment.receivedAt ?? providerStatusAt
            : attempt.payment.receivedAt,
        },
      })
    : await tx.payment.create({
        data: {
          eventId: attempt.eventId,
          registrationId: attempt.registrationId,
          amount: attempt.amountCents / 100,
          status: state.paymentStatus,
          method: "CARD_REFERENCE",
          externalReference: provider.id,
          receivedAt: state.paymentStatus === "SUCCEEDED"
            ? providerStatusAt
            : null,
        },
      });
  const updated = await tx.paymentAttempt.update({
    where: { id: attempt.id },
    data: {
      paymentId: payment.id,
      providerPaymentId: provider.id,
      providerStatus: provider.status,
      providerStatusAt,
      status: state.attemptStatus,
      activeRegistrationKey,
      failureCode: state.attemptStatus === "FAILED"
        ? "SQUARE_PAYMENT_FAILED"
        : null,
      failureMessage: state.attemptStatus === "FAILED"
        ? "Square reported that the payment failed."
        : null,
      completedAt: state.terminal ? now : null,
    },
    include: attemptInclude,
  });

  if (
    priorStatus !== state.attemptStatus
    || attempt.providerPaymentId !== provider.id
  ) {
    await tx.auditLog.create({
      data: {
        eventId: attempt.eventId,
        action: auditActionForAttemptStatus(state.attemptStatus),
        entityType: "Payment",
        entityId: payment.id,
        correlationId: randomUUID(),
        summary: `Square marked the card payment for registration ${attempt.registration.confirmationCode} as ${provider.status.toLowerCase()}.`,
        metadata: {
          provider: "SQUARE",
          environment: attempt.environment,
          providerPaymentId: provider.id,
          providerStatus: provider.status,
          amountCents: attempt.amountCents,
          currency: attempt.currency,
          paymentAttemptId: attempt.id,
          source,
        },
      },
    });
  }
  const becameSuccessful = priorStatus !== "SUCCEEDED"
    && state.attemptStatus === "SUCCEEDED";
  if (becameSuccessful) {
    await tx.squareHostedCheckout.updateMany({
      where: { paymentAttemptId: attempt.id },
      data: { status: "PAID" },
    });
    // The balance just moved: every other open Pay on Square link was quoted against the old one.
    await invalidateHostedCheckoutsInTransaction(tx, {
      registrationId: attempt.registrationId,
      reason: "ANOTHER_PAYMENT_RECORDED",
      now,
      exceptPaymentAttemptId: attempt.id,
    });
  }

  // The surcharge joins the registration total only now, on the transition to
  // succeeded, which is also what makes it idempotent: a webhook repeating a
  // success the create call already applied does not add it twice, and an
  // attempt the payer abandoned never adds it at all. Without this the
  // registration would show the surcharge as an overpayment forever.
  if (becameSuccessful && attempt.surchargeCents > 0) {
    const registration = await tx.registration.update({
      where: { id: attempt.registrationId },
      data: {
        totalAmount: { increment: attempt.surchargeCents / 100 },
      },
      select: { totalAmount: true },
    });
    await tx.auditLog.create({
      data: {
        eventId: attempt.eventId,
        action: "REGISTRATION_CARD_SURCHARGE_APPLIED",
        entityType: "Registration",
        entityId: attempt.registrationId,
        correlationId: randomUUID(),
        summary: `Added the card processing fee to registration ${attempt.registration.confirmationCode} when its pay-later balance was settled by card.`,
        metadata: {
          paymentAttemptId: attempt.id,
          paymentId: payment.id,
          surchargeCents: attempt.surchargeCents,
          chargedAmountCents: attempt.amountCents,
          resultingTotalCents: moneyToCents(registration.totalAmount),
          source,
        },
      },
    });
  }

  const receipt = becameSuccessful
    ? await enqueuePaymentReceiptMessage(tx, {
        eventId: attempt.eventId,
        registrationId: attempt.registrationId,
        paymentId: payment.id,
        paymentAttemptId: attempt.id,
        amountCents: attempt.amountCents,
        providerPaymentId: provider.id,
      })
    : null;
  return {
    attempt: updated,
    pendingMessageIds: receipt?.pendingMessageIds ?? [],
  };
}

async function processPaymentMessagesAfterCommit(messageIds: string[]) {
  if (messageIds.length === 0) return;
  try {
    await processQueuedMessageIdsAfterCommit(messageIds);
  } catch (error) {
    logError("Payment receipt processing failed after payment commit", error);
  }
}

async function dispatchPaymentAlerts(alerts: Alert[] | undefined) {
  if (!alerts || alerts.length === 0) return;
  try {
    await dispatchAlerts(alerts);
  } catch (error) {
    logError("Payment alert dispatch failed after payment commit", error);
  }
}

async function recordAdapterFailure(
  attemptId: string,
  error: SquareAdapterError,
  now: Date,
) {
  return runSerializable(async (tx) => {
    const attempt = await tx.paymentAttempt.findUnique({
      where: { id: attemptId },
      include: attemptInclude,
    });
    if (!attempt) {
      throw new SquarePaymentOperationError(
        "PAYMENT_OPERATION_CONFLICT",
        "The durable payment attempt could not be reloaded.",
        true
      );
    }
    if (attempt.status !== "PROCESSING") return attempt;

    const failureMessage = error.message.slice(0, 500);
    const updated = await tx.paymentAttempt.update({
      where: { id: attempt.id },
      data: error.retryable
        ? {
            failureCode: error.providerCode ?? error.code,
            failureMessage,
            lastRequestedAt: now,
          }
        : {
            status: "FAILED",
            activeRegistrationKey: null,
            failureCode: error.providerCode ?? error.code,
            failureMessage,
            completedAt: now,
          },
      include: attemptInclude,
    });
    await tx.auditLog.create({
      data: {
        eventId: attempt.eventId,
        action: error.retryable
          ? "SQUARE_PAYMENT_REQUEST_UNCERTAIN"
          : "SQUARE_PAYMENT_FAILED",
        entityType: "PaymentAttempt",
        entityId: attempt.id,
        correlationId: randomUUID(),
        summary: error.retryable
          ? `Square did not confirm the card payment request for registration ${attempt.registration.confirmationCode}.`
          : `Square rejected the card payment request for registration ${attempt.registration.confirmationCode}.`,
        metadata: {
          provider: "SQUARE",
          environment: attempt.environment,
          amountCents: attempt.amountCents,
          currency: attempt.currency,
          providerCode: error.providerCode,
          retryable: error.retryable,
        },
      },
    });
    return updated;
  });
}

async function markAmountMismatchForReview(
  attemptId: string,
  provider: SquarePaymentResult,
  now: Date,
) {
  return runSerializable(async (tx) => {
    const attempt = await tx.paymentAttempt.findUnique({
      where: { id: attemptId },
      include: attemptInclude,
    });
    if (!attempt) {
      throw new SquarePaymentOperationError(
        "PAYMENT_OPERATION_CONFLICT",
        "The durable payment attempt could not be reloaded.",
        true
      );
    }
    const updated = await tx.paymentAttempt.update({
      where: { id: attempt.id },
      data: {
        status: "PENDING",
        activeRegistrationKey: attempt.registrationId,
        providerPaymentId: provider.id,
        providerStatus: provider.status,
        providerStatusAt: providerTimestamp(provider.updatedAt, now),
        failureCode: "PROVIDER_AMOUNT_MISMATCH",
        failureMessage: "The provider response did not match the server-owned payment quote.",
      },
      include: attemptInclude,
    });
    await tx.auditLog.create({
      data: {
        eventId: attempt.eventId,
        action: "SQUARE_PAYMENT_REQUIRES_REVIEW",
        entityType: "PaymentAttempt",
        entityId: attempt.id,
        correlationId: randomUUID(),
        summary: `Square returned an amount or currency mismatch for registration ${attempt.registration.confirmationCode}.`,
        metadata: {
          provider: "SQUARE",
          providerPaymentId: provider.id,
          quotedAmountCents: attempt.amountCents,
          quotedCurrency: attempt.currency,
          returnedAmountCents: provider.amountCents,
          returnedCurrency: provider.currency,
        },
      },
    });
    return updated;
  });
}

async function createSquarePaymentWithAuthorization(
  authorization: PaymentAuthorization,
  input: SquarePaymentInput,
  options: {
    now?: Date;
    configuration?: SquareRuntimeConfiguration;
    createPayment?: typeof createSquarePayment;
  } = {},
) {
  const now = options.now ?? new Date();
  const configuration = options.configuration ?? getSquareConfiguration();
  if (!configuration.paymentConfigured) {
    throw new SquarePaymentOperationError(
      "SQUARE_NOT_CONFIGURED",
      "Online card payment is not configured for this site."
    );
  }
  const prepared = await runSerializable((tx) => (
    preparePaymentAttempt(tx, authorization, input, configuration, now)
  ));
  if (prepared.operation === "RETURN_EXISTING") {
    return resultFromAttempt(prepared.attempt);
  }
  // Links withdrawn by starting this attempt are deleted at Square without holding the payment up.
  await flushHostedDeletionsAfterResponse({
    registrationId: prepared.attempt.registrationId,
    configuration,
  });

  let provider: SquarePaymentResult;
  try {
    provider = await (options.createPayment ?? createSquarePayment)(
      configuration,
      {
        sourceId: input.sourceId,
        idempotencyKey: prepared.attempt.providerIdempotencyKey,
        amountCents: prepared.attempt.amountCents,
        currency: "USD",
        locationId: configuration.locationId,
        referenceId: prepared.attempt.id,
        note: `IMSDA registration ${prepared.attempt.registration.confirmationCode}`,
      }
    );
  } catch (error) {
    if (!(error instanceof SquareAdapterError)) throw error;
    const attempt = await recordAdapterFailure(prepared.attempt.id, error, now);
    if (attempt.status !== "PROCESSING") return resultFromAttempt(attempt);
    throw new SquarePaymentOperationError(
      "PAYMENT_RESULT_UNCERTAIN",
      error.message,
      true
    );
  }

  if (
    provider.amountCents !== prepared.attempt.amountCents
    || provider.currency !== prepared.attempt.currency
  ) {
    await markAmountMismatchForReview(prepared.attempt.id, provider, now);
    throw new SquarePaymentOperationError(
      "PAYMENT_REQUIRES_REVIEW",
      "Square returned a result that does not match the registration balance. No additional payment should be attempted until the event team reviews it."
    );
  }

  const applied = await runSerializable(async (tx) => {
    const attempt = await tx.paymentAttempt.findUnique({
      where: { id: prepared.attempt.id },
      include: attemptInclude,
    });
    if (!attempt) {
      throw new SquarePaymentOperationError(
        "PAYMENT_OPERATION_CONFLICT",
        "The durable payment attempt could not be reloaded.",
        true
      );
    }
    return applyProviderPayment(
      tx,
      attempt,
      provider,
      providerTimestamp(provider.updatedAt ?? provider.createdAt, now),
      now,
      "CREATE_PAYMENT"
    );
  });
  await processPaymentMessagesAfterCommit(applied.pendingMessageIds);
  await dispatchPaymentAlerts(applied.alerts);
  if (applied.attempt.status === "SUCCEEDED") {
    await flushHostedDeletionsAfterResponse({
      registrationId: applied.attempt.registrationId,
      configuration,
    });
  }
  const result = resultFromAttempt(applied.attempt);
  if (result.status === "FAILED" || result.status === "CANCELED") {
    throw new SquarePaymentOperationError(
      "PAYMENT_DECLINED",
      result.message
    );
  }
  return result;
}

export function createPublicSquarePayment(
  token: string,
  input: SquarePaymentInput,
  options: {
    now?: Date;
    configuration?: SquareRuntimeConfiguration;
    createPayment?: typeof createSquarePayment;
  } = {},
) {
  return createSquarePaymentWithAuthorization(
    { kind: "private-link", token },
    input,
    options,
  );
}

export function createAttendeeSquarePayment(
  access: Omit<PaymentAccess, "accessTokenId">,
  input: SquarePaymentInput,
  options: {
    now?: Date;
    configuration?: SquareRuntimeConfiguration;
    createPayment?: typeof createSquarePayment;
  } = {},
) {
  return createSquarePaymentWithAuthorization(
    { kind: "attendee-account", access: { ...access, accessTokenId: null } },
    input,
    options,
  );
}

async function storeIgnoredWebhook(
  tx: Prisma.TransactionClient,
  event: ParsedSquareWebhookEvent,
  payloadHash: string,
  receivedAt: Date,
  reason: string,
  objectId: string | null,
) {
  await tx.squareWebhookEvent.create({
    data: {
      providerEventId: event.providerEventId,
      eventType: event.eventType,
      objectId,
      payloadHash,
      status: "IGNORED",
      reason: reason.slice(0, 500),
      occurredAt: event.occurredAt,
      receivedAt,
      processedAt: receivedAt,
    },
  });
  return { status: "IGNORED" as const, duplicate: false };
}

/**
 * A Square payment with no IMSDA payment attempt behind it — an invoice, a
 * payment link, or a Virtual Terminal charge taken by staff outside the app.
 * These used to be dropped on the floor with an IGNORED row, which is how a
 * registration could be settled in Square and still read as unpaid here.
 *
 * It is applied only when the provider payment is unambiguous on every axis:
 * completed, in USD, carrying exactly one confirmation code that resolves to
 * exactly one payable registration, for exactly that registration's
 * outstanding balance. Anything short of that is recorded as IGNORED with the
 * reason that stopped it, which is what `npm run payments:reconcile` reports
 * for a human to settle by hand. Guessing at a partial amount or an ambiguous
 * code would mark the wrong registration paid, and nothing downstream would
 * catch it.
 */
async function applyExternalSquarePayment(
  tx: Prisma.TransactionClient,
  event: ParsedSquareWebhookEvent,
  payloadHash: string,
  receivedAt: Date,
) {
  const payment = event.payment!;
  const unmatched = "No IMSDA Square payment attempt matches this provider payment";
  const ignore = (detail: string) => storeIgnoredWebhook(
    tx,
    event,
    payloadHash,
    receivedAt,
    `${unmatched}, and ${detail}`,
    payment.id,
  );

  if (internalPaymentState(payment.status).paymentStatus !== "SUCCEEDED") {
    return ignore(`Square reports it as ${payment.status.toLowerCase()}.`);
  }
  if (payment.amount_money.currency !== "USD") {
    return ignore("it is not in USD.");
  }

  // Square sends payment.created and payment.updated for the same payment, and
  // each carries its own event id, so the caller's duplicate check does not
  // cover this. The provider payment id does.
  const alreadyApplied = await tx.payment.findFirst({
    where: { externalReference: payment.id, method: "CARD_REFERENCE" },
    select: { id: true, eventId: true },
  });
  if (alreadyApplied) {
    await tx.squareWebhookEvent.create({
      data: {
        eventId: alreadyApplied.eventId,
        providerEventId: event.providerEventId,
        eventType: event.eventType,
        objectId: payment.id,
        payloadHash,
        status: "PROCESSED",
        reason: "This provider payment was already recorded.",
        occurredAt: event.occurredAt,
        receivedAt,
        processedAt: receivedAt,
      },
    });
    return { status: "PROCESSED" as const, duplicate: false };
  }

  const candidates = squareConfirmationCodeCandidates(payment);
  if (candidates.length === 0) {
    return ignore("its note and reference carry no confirmation code.");
  }

  // `take: 2` is the ambiguity check: a confirmation code is unique within an
  // event, not across the database, so two events can legitimately share one.
  const registrations = await tx.registration.findMany({
    where: {
      confirmationCode: { in: candidates },
      status: { in: ["SUBMITTED", "CONFIRMED"] },
    },
    select: {
      id: true,
      eventId: true,
      confirmationCode: true,
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
    take: 2,
  });
  if (registrations.length === 0) {
    return ignore("no payable registration carries the confirmation code it names.");
  }
  if (registrations.length > 1) {
    return ignore("the confirmation code it names matches more than one registration.");
  }

  const registration = registrations[0]!;
  const balanceCents = registrationBalanceCents(registration);
  if (balanceCents === 0) {
    return ignore(`registration ${registration.confirmationCode} has no outstanding balance.`);
  }
  if (payment.amount_money.amount !== balanceCents) {
    return ignore(`its amount does not equal the outstanding balance on registration ${registration.confirmationCode}.`);
  }

  const receivedAtProvider = providerTimestamp(
    payment.updated_at ?? payment.created_at ?? null,
    event.occurredAt,
  );
  const created = await tx.payment.create({
    data: {
      eventId: registration.eventId,
      registrationId: registration.id,
      amount: balanceCents / 100,
      status: "SUCCEEDED",
      method: "CARD_REFERENCE",
      externalReference: payment.id,
      receivedAt: receivedAtProvider,
    },
  });
  await tx.auditLog.create({
    data: {
      eventId: registration.eventId,
      action: "SQUARE_EXTERNAL_PAYMENT_APPLIED",
      entityType: "Payment",
      entityId: created.id,
      correlationId: randomUUID(),
      summary: `Applied a Square payment taken outside IMSDA Events to registration ${registration.confirmationCode}.`,
      metadata: {
        provider: "SQUARE",
        providerPaymentId: payment.id,
        providerStatus: payment.status,
        amountCents: balanceCents,
        currency: payment.amount_money.currency,
        matchedConfirmationCode: registration.confirmationCode,
        candidateCount: candidates.length,
        source: "WEBHOOK",
      },
    },
  });
  const receipt = await enqueuePaymentReceiptMessage(tx, {
    eventId: registration.eventId,
    registrationId: registration.id,
    paymentId: created.id,
    amountCents: balanceCents,
    providerPaymentId: payment.id,
  });
  await tx.squareWebhookEvent.create({
    data: {
      eventId: registration.eventId,
      providerEventId: event.providerEventId,
      eventType: event.eventType,
      objectId: payment.id,
      payloadHash,
      status: "PROCESSED",
      reason: "Matched by confirmation code to a payment taken outside IMSDA Events.",
      occurredAt: event.occurredAt,
      receivedAt,
      processedAt: receivedAt,
    },
  });
  return {
    status: "PROCESSED" as const,
    duplicate: false,
    paymentStatus: "SUCCEEDED" as const,
    pendingMessageIds: receipt.pendingMessageIds,
  };
}

async function applyPaymentWebhook(
  tx: Prisma.TransactionClient,
  event: ParsedSquareWebhookEvent,
  payloadHash: string,
  configuration: SquareRuntimeConfiguration,
  receivedAt: Date,
) {
  const payment = event.payment!;
  if (
    payment.location_id
    && payment.location_id !== configuration.locationId
  ) {
    return storeIgnoredWebhook(
      tx,
      event,
      payloadHash,
      receivedAt,
      "The Square location does not match this application.",
      payment.id
    );
  }
  // A payment made through a hosted "Pay on Square" link has an `order_id` and no `reference_id`;
  // the order id stored when the link was created is how it finds its attempt (#327).
  const hosted = payment.order_id
    ? await tx.squareHostedCheckout.findUnique({
        where: { providerOrderId: payment.order_id },
        select: { paymentAttemptId: true },
      })
    : null;
  const attempt = await tx.paymentAttempt.findFirst({
    where: {
      provider: "SQUARE",
      environment: configuration.environment,
      OR: [
        { providerPaymentId: payment.id },
        ...(payment.reference_id ? [{ id: payment.reference_id }] : []),
        ...(hosted ? [{ id: hosted.paymentAttemptId }] : []),
      ],
    },
    include: attemptInclude,
  });
  if (!attempt) {
    return applyExternalSquarePayment(
      tx,
      event,
      payloadHash,
      receivedAt,
    );
  }
  const provider = {
    id: payment.id,
    status: payment.status,
    amountCents: payment.amount_money.amount,
    currency: payment.amount_money.currency,
    createdAt: payment.created_at ?? null,
    updatedAt: payment.updated_at ?? null,
    orderId: payment.order_id ?? null,
  };
  const amountMismatch = payment.amount_money.amount !== attempt.amountCents
    || payment.amount_money.currency !== attempt.currency;
  if (
    attempt.channel === "HOSTED_LINK"
    && internalPaymentState(payment.status).attemptStatus === "SUCCEEDED"
  ) {
    // Money Square has taken through a hosted order that does not fit the one quote this link
    // stands for: a second payment on an order that already has one, or an amount other than the
    // quote (a split payment). Neither is a valid payment of this balance; both are held as
    // evidence for staff, and the winner's attempt is left exactly as it is.
    const secondPayment = attempt.status === "SUCCEEDED"
      && attempt.providerPaymentId !== null
      && attempt.providerPaymentId !== payment.id;
    if (secondPayment || amountMismatch) {
      const reason = secondPayment ? "SECOND_PAYMENT_ON_ORDER" : "AMOUNT_MISMATCH";
      const held = await recordDuplicateCharge(
        tx,
        attempt,
        provider,
        providerTimestamp(payment.updated_at ?? payment.created_at ?? null, event.occurredAt),
        receivedAt,
        "WEBHOOK",
        { reason, winningPaymentId: attempt.paymentId },
        { holdOnAttempt: false },
      );
      await tx.squareWebhookEvent.create({
        data: {
          eventId: attempt.eventId,
          paymentAttemptId: attempt.id,
          providerEventId: event.providerEventId,
          eventType: event.eventType,
          objectId: payment.id,
          payloadHash,
          status: "PROCESSED",
          reason: `Held for review: ${duplicateReasonText[reason]}.`,
          occurredAt: event.occurredAt,
          receivedAt,
          processedAt: receivedAt,
        },
      });
      return {
        status: "PROCESSED" as const,
        duplicate: false,
        paymentStatus: attempt.status,
        pendingMessageIds: held.pendingMessageIds,
        alerts: held.alerts ?? [],
        registrationId: attempt.registrationId,
      };
    }
  }
  if (amountMismatch) {
    await tx.auditLog.create({
      data: {
        eventId: attempt.eventId,
        action: "SQUARE_WEBHOOK_AMOUNT_MISMATCH",
        entityType: "PaymentAttempt",
        entityId: attempt.id,
        correlationId: randomUUID(),
        summary: `Ignored a Square webhook amount mismatch for registration ${attempt.registration.confirmationCode}.`,
        metadata: {
          providerPaymentId: payment.id,
          quotedAmountCents: attempt.amountCents,
          returnedAmountCents: payment.amount_money.amount,
          quotedCurrency: attempt.currency,
          returnedCurrency: payment.amount_money.currency,
        },
      },
    });
    await tx.squareWebhookEvent.create({
      data: {
        eventId: attempt.eventId,
        paymentAttemptId: attempt.id,
        providerEventId: event.providerEventId,
        eventType: event.eventType,
        objectId: payment.id,
        payloadHash,
        status: "IGNORED",
        reason: "The provider amount or currency did not match the immutable quote.",
        occurredAt: event.occurredAt,
        receivedAt,
        processedAt: receivedAt,
      },
    });
    return { status: "IGNORED" as const, duplicate: false };
  }
  if (attempt.channel === "HOSTED_LINK") {
    const incoming = internalPaymentState(payment.status).attemptStatus;
    if (incoming === "PENDING") {
      // Square does not promise delivery in order: an approval that arrives after the decline of
      // the same payment is older news and must not put the attempt back in flight.
      const declined = await tx.squareWebhookEvent.findFirst({
        where: {
          paymentAttemptId: attempt.id,
          objectId: payment.id,
          reason: hostedDeclineReason,
          occurredAt: { gte: event.occurredAt },
        },
        select: { id: true },
      });
      if (declined) {
        await tx.squareWebhookEvent.create({
          data: {
            eventId: attempt.eventId,
            paymentAttemptId: attempt.id,
            providerEventId: event.providerEventId,
            eventType: event.eventType,
            objectId: payment.id,
            payloadHash,
            status: "IGNORED",
            reason: "Older than a decline already recorded for this payment.",
            occurredAt: event.occurredAt,
            receivedAt,
            processedAt: receivedAt,
          },
        });
        return { status: "IGNORED" as const, duplicate: false };
      }
    }
    if (incoming === "FAILED" || incoming === "CANCELED") {
      // A declined card on Square's hosted page is not the end of the link: the payer can try
      // again on the same page. Only an attempt already tracking this very payment steps back.
      if (attempt.providerPaymentId === payment.id && attempt.status === "PENDING") {
        await tx.paymentAttempt.update({
          where: { id: attempt.id },
          data: {
            status: "PROCESSING",
            providerPaymentId: null,
            providerStatus: payment.status,
            providerStatusAt: providerTimestamp(
              payment.updated_at ?? payment.created_at ?? null,
              event.occurredAt,
            ),
            activeRegistrationKey: null,
          },
        });
        if (attempt.payment) {
          await tx.payment.update({
            where: { id: attempt.payment.id },
            data: { status: "FAILED" },
          });
        }
      }
      await tx.squareWebhookEvent.create({
        data: {
          eventId: attempt.eventId,
          paymentAttemptId: attempt.id,
          providerEventId: event.providerEventId,
          eventType: event.eventType,
          objectId: payment.id,
          payloadHash,
          status: "PROCESSED",
          reason: hostedDeclineReason,
          occurredAt: event.occurredAt,
          receivedAt,
          processedAt: receivedAt,
        },
      });
      return { status: "PROCESSED" as const, duplicate: false };
    }
  }
  const applied = await applyProviderPayment(
    tx,
    attempt,
    provider,
    providerTimestamp(
      payment.updated_at ?? payment.created_at ?? null,
      event.occurredAt,
    ),
    receivedAt,
    "WEBHOOK"
  );
  await tx.squareWebhookEvent.create({
    data: {
      eventId: attempt.eventId,
      paymentAttemptId: attempt.id,
      providerEventId: event.providerEventId,
      eventType: event.eventType,
      objectId: payment.id,
      payloadHash,
      status: "PROCESSED",
      reason: applied.attempt.duplicateReason
        ? `Duplicate charge: ${duplicateReasonText[applied.attempt.duplicateReason] ?? applied.attempt.duplicateReason}.`
        : null,
      occurredAt: event.occurredAt,
      receivedAt,
      processedAt: receivedAt,
    },
  });
  return {
    status: "PROCESSED" as const,
    duplicate: false,
    paymentStatus: applied.attempt.status,
    pendingMessageIds: applied.pendingMessageIds,
    alerts: applied.alerts ?? [],
    registrationId: attempt.registrationId,
  };
}

function refundWouldExceedPayment(input: {
  paymentAmountCents: number;
  refundAmountCents: number;
  existingRefundId: string | null;
  refunds: Array<{
    id: string;
    status: RefundStatus;
    amount: { toString(): string };
  }>;
}) {
  const alreadyRefunded = input.refunds.reduce((total, refund) => (
    refund.status === "SUCCEEDED" && refund.id !== input.existingRefundId
      ? total + Math.round(Number(refund.amount) * 100)
      : total
  ), 0);
  return alreadyRefunded + input.refundAmountCents > input.paymentAmountCents;
}

async function applyRefundWebhook(
  tx: Prisma.TransactionClient,
  event: ParsedSquareWebhookEvent,
  payloadHash: string,
  configuration: SquareRuntimeConfiguration,
  receivedAt: Date,
) {
  const providerRefund = event.refund!;
  if (
    providerRefund.location_id
    && providerRefund.location_id !== configuration.locationId
  ) {
    return storeIgnoredWebhook(
      tx,
      event,
      payloadHash,
      receivedAt,
      "The Square location does not match this application.",
      providerRefund.id
    );
  }
  const refundedPaymentInclude = {
    paymentAttempt: true,
    refunds: true,
    registration: { select: { confirmationCode: true } },
  } satisfies Prisma.PaymentInclude;
  // A payment held as evidence (#327) may sit beside the attempt rather than on it.
  const heldCandidate = await tx.squareDuplicateCharge.findUnique({
    where: { providerPaymentId: providerRefund.payment_id },
    select: { paymentId: true, reason: true, environment: true },
  });
  // Only this environment's records: a Sandbox refund never resolves a Production exception.
  const heldRecord = heldCandidate?.environment === configuration.environment
    ? heldCandidate
    : null;
  const payment = (await tx.payment.findFirst({
    where: {
      externalReference: providerRefund.payment_id,
      method: "CARD_REFERENCE",
      paymentAttempt: {
        is: {
          provider: "SQUARE",
          environment: configuration.environment,
          providerPaymentId: providerRefund.payment_id,
        },
      },
    },
    include: refundedPaymentInclude,
  })) ?? (heldRecord?.paymentId
    ? await tx.payment.findFirst({
        where: { id: heldRecord.paymentId, method: "CARD_REFERENCE" },
        include: refundedPaymentInclude,
      })
    : null);
  if (!payment) {
    return storeIgnoredWebhook(
      tx,
      event,
      payloadHash,
      receivedAt,
      "No IMSDA Square payment matches this provider refund.",
      providerRefund.id
    );
  }
  const existing = await tx.refund.findFirst({
    where: {
      paymentId: payment.id,
      externalReference: providerRefund.id,
    },
  });
  const status = internalRefundStatus(providerRefund.status);
  const amountCents = providerRefund.amount_money.amount;
  const invalidAmount = amountCents <= 0
    || providerRefund.amount_money.currency !== "USD"
    || (existing && Math.round(Number(existing.amount) * 100) !== amountCents)
    || (status === "SUCCEEDED" && refundWouldExceedPayment({
      paymentAmountCents: Math.round(Number(payment.amount) * 100),
      refundAmountCents: amountCents,
      existingRefundId: existing?.id ?? null,
      refunds: payment.refunds,
    }));
  if (invalidAmount) {
    return storeIgnoredWebhook(
      tx,
      event,
      payloadHash,
      receivedAt,
      "The provider refund amount or currency was invalid for this payment.",
      providerRefund.id
    );
  }

  const terminalExisting = existing?.status === "SUCCEEDED"
    || existing?.status === "FAILED";
  const effectiveStatus = terminalExisting ? existing.status : status;
  const refund = existing
    ? await tx.refund.update({
        where: { id: existing.id },
        data: { status: effectiveStatus },
      })
    : await tx.refund.create({
        data: {
          eventId: payment.eventId,
          paymentId: payment.id,
          amount: amountCents / 100,
          status,
          externalReference: providerRefund.id,
          reason: "Square card refund",
        },
      });
  // A surcharge that has been refunded in full was never really charged, so
  // the total gives it back. Without this, fully refunding a pay-later card
  // payment leaves the registration owing exactly the processing fee.
  //
  // Only on a full reversal, and only on the transition into SUCCEEDED: a
  // partial refund leaves the fee, because the card transaction it paid for
  // did happen.
  const duplicateReason = heldRecord?.reason
    ?? payment.paymentAttempt?.duplicateReason
    ?? null;
  // A duplicate charge never added its surcharge to the total, so refunding it gives none back.
  const surchargeCents = duplicateReason
    ? 0
    : payment.paymentAttempt?.surchargeCents ?? 0;
  if (
    surchargeCents > 0
    && effectiveStatus === "SUCCEEDED"
    && existing?.status !== "SUCCEEDED"
  ) {
    const paymentAmountCents = Math.round(Number(payment.amount) * 100);
    const refundedCents = payment.refunds.reduce(
      (total, priorRefund) => total + (
        priorRefund.id !== refund.id && priorRefund.status === "SUCCEEDED"
          ? Math.round(Number(priorRefund.amount) * 100)
          : 0
      ),
      amountCents,
    );
    if (refundedCents >= paymentAmountCents) {
      const registration = await tx.registration.update({
        where: { id: payment.registrationId },
        data: { totalAmount: { decrement: surchargeCents / 100 } },
        select: { totalAmount: true },
      });
      await tx.auditLog.create({
        data: {
          eventId: payment.eventId,
          action: "REGISTRATION_CARD_SURCHARGE_REVERSED",
          entityType: "Registration",
          entityId: payment.registrationId,
          correlationId: randomUUID(),
          summary: `Removed the card processing fee from registration ${payment.registration.confirmationCode} after its card payment was fully refunded.`,
          metadata: {
            paymentId: payment.id,
            refundId: refund.id,
            surchargeCents,
            refundedCents,
            resultingTotalCents: moneyToCents(registration.totalAmount),
            source: "WEBHOOK",
          },
        },
      });
    }
  }

  if (
    duplicateReason
    && effectiveStatus === "SUCCEEDED"
    && existing?.status !== "SUCCEEDED"
  ) {
    const paymentAmountCents = Math.round(Number(payment.amount) * 100);
    const refundedCents = payment.refunds.reduce(
      (total, priorRefund) => total + (
        priorRefund.id !== refund.id && priorRefund.status === "SUCCEEDED"
          ? Math.round(Number(priorRefund.amount) * 100)
          : 0
      ),
      amountCents,
    );
    if (refundedCents >= paymentAmountCents) {
      await tx.payment.update({
        where: { id: payment.id },
        data: { status: "VOIDED" },
      });
      await tx.squareDuplicateCharge.updateMany({
        where: { providerPaymentId: providerRefund.payment_id, status: "OPEN" },
        data: { status: "RESOLVED", resolvedAt: receivedAt },
      });
      await tx.auditLog.create({
        data: {
          eventId: payment.eventId,
          action: "SQUARE_DUPLICATE_CHARGE_RESOLVED",
          entityType: "Payment",
          entityId: payment.id,
          correlationId: randomUUID(),
          summary: `The duplicate Square payment for registration ${payment.registration.confirmationCode} was fully refunded.`,
          metadata: {
            providerPaymentId: providerRefund.payment_id,
            providerRefundId: providerRefund.id,
            refundedCents,
            source: "WEBHOOK",
          },
        },
      });
    }
  }

  if (!existing || existing.status !== effectiveStatus) {
    await tx.auditLog.create({
      data: {
        eventId: payment.eventId,
        action: effectiveStatus === "SUCCEEDED"
          ? "SQUARE_REFUND_COMPLETED"
          : effectiveStatus === "FAILED"
            ? "SQUARE_REFUND_FAILED"
            : "SQUARE_REFUND_PENDING",
        entityType: "Refund",
        entityId: refund.id,
        correlationId: randomUUID(),
        summary: `Square marked a refund for registration ${payment.registration.confirmationCode} as ${providerRefund.status.toLowerCase()}.`,
        metadata: {
          provider: "SQUARE",
          providerRefundId: providerRefund.id,
          providerPaymentId: providerRefund.payment_id,
          providerStatus: providerRefund.status,
          amountCents,
          currency: providerRefund.amount_money.currency,
          source: "WEBHOOK",
        },
      },
    });
  }
  const notice = effectiveStatus === "SUCCEEDED" && existing?.status !== "SUCCEEDED"
    ? await enqueueRefundNoticeMessage(tx, {
        eventId: payment.eventId,
        registrationId: payment.registrationId,
        refundId: refund.id,
        amountCents,
        reference: providerRefund.id,
        provider: "SQUARE",
        providerRefundId: providerRefund.id,
      })
    : null;
  await tx.squareWebhookEvent.create({
    data: {
      eventId: payment.eventId,
      paymentAttemptId: payment.paymentAttempt?.id ?? null,
      providerEventId: event.providerEventId,
      eventType: event.eventType,
      objectId: providerRefund.id,
      payloadHash,
      status: "PROCESSED",
      occurredAt: event.occurredAt,
      receivedAt,
      processedAt: receivedAt,
    },
  });
  return {
    status: "PROCESSED" as const,
    duplicate: false,
    refundStatus: effectiveStatus,
    pendingMessageIds: notice?.pendingMessageIds ?? [],
  };
}

export async function processSquareWebhook(
  event: ParsedSquareWebhookEvent,
  payloadHash: string,
  options: {
    receivedAt?: Date;
    configuration?: SquareRuntimeConfiguration;
  } = {},
) {
  const receivedAt = options.receivedAt ?? new Date();
  const configuration = options.configuration ?? getSquareConfiguration();
  if (!configuration.webhookConfigured) {
    throw new SquarePaymentOperationError(
      "SQUARE_NOT_CONFIGURED",
      "Square webhook verification is not configured."
    );
  }
  const result = await runSerializable(async (tx) => {
    const duplicate = await tx.squareWebhookEvent.findUnique({
      where: { providerEventId: event.providerEventId },
      select: { status: true },
    });
    if (duplicate) {
      return {
        status: duplicate.status,
        duplicate: true,
      };
    }
    if (event.kind === "UNSUPPORTED") {
      return storeIgnoredWebhook(
        tx,
        event,
        payloadHash,
        receivedAt,
        "The webhook event type is not used by IMSDA Events.",
        null
      );
    }
    return event.kind === "PAYMENT"
      ? applyPaymentWebhook(
          tx,
          event,
          payloadHash,
          configuration,
          receivedAt,
        )
      : applyRefundWebhook(
          tx,
          event,
          payloadHash,
          configuration,
          receivedAt
        );
  });
  const pendingMessageIds = "pendingMessageIds" in result
    ? result.pendingMessageIds
    : [];
  await processPaymentMessagesAfterCommit(pendingMessageIds);
  if ("alerts" in result) await dispatchPaymentAlerts(result.alerts);
  if (
    "paymentStatus" in result
    && result.paymentStatus === "SUCCEEDED"
    && "registrationId" in result
  ) {
    // The balance moved, so withdraw this registration's other open links at Square. Best effort
    // and not waited for: whatever it misses, the sweep deletes.
    await flushHostedDeletionsAfterResponse({
      configuration,
      registrationId: result.registrationId,
    });
  }
  if ("pendingMessageIds" in result && "paymentStatus" in result) {
    return {
      status: result.status,
      duplicate: result.duplicate,
      paymentStatus: result.paymentStatus,
    };
  }
  if ("pendingMessageIds" in result && "refundStatus" in result) {
    return {
      status: result.status,
      duplicate: result.duplicate,
      refundStatus: result.refundStatus,
    };
  }
  return result;
}
