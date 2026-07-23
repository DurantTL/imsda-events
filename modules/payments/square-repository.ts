import "server-only";

import { randomUUID } from "node:crypto";
import {
  Prisma,
  type PaymentAttemptStatus,
  type PrismaClient,
  type RefundStatus,
} from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
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
  internalPaymentState,
  internalRefundStatus,
  moneyToCents,
  providerIdempotencyKey,
  registrationBalanceCents,
  selectedCardPayment,
  type ParsedSquareWebhookEvent,
  type SquareCheckoutView,
  type SquarePaymentInput,
} from "@/modules/payments/square-domain";
import { processQueuedMessageIdsAfterCommit } from "@/modules/communications/messaging-repository";
import { enqueuePaymentReceiptMessage } from "@/modules/communications/transactional-messages";
import { authorizeRegistrationAccessToken } from "@/modules/public-access/repository";

type PaymentClient = Prisma.TransactionClient | PrismaClient;

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
        },
      },
    },
  },
} satisfies Prisma.RegistrationSelect;

type CheckoutRegistration = Prisma.RegistrationGetPayload<{
  select: typeof checkoutRegistrationSelect;
}>;

const attemptInclude = {
  payment: true,
  registration: {
    select: {
      confirmationCode: true,
    },
  },
} satisfies Prisma.PaymentAttemptInclude;

type AttemptRecord = Prisma.PaymentAttemptGetPayload<{
  include: typeof attemptInclude;
}>;

type AppliedProviderPayment = {
  attempt: AttemptRecord;
  pendingMessageIds: string[];
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

function checkoutFromRegistration(
  registration: CheckoutRegistration,
  configuration: SquareRuntimeConfiguration,
): SquareCheckoutView {
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
    ),
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
        formVersionStatus: submission.formVersion.status,
      })
    : { configured: false, cardSelected: false };
  const amountCents = registrationBalanceCents(registration);
  const base = {
    amountCents,
    currency: "USD" as const,
    cardSelected: paymentSelection.cardSelected,
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
  if (!paymentSelection.cardSelected) {
    return {
      ...base,
      state: "PAY_LATER",
      message: "This registration selected the pay-later option. No online card form has been loaded.",
    };
  }
  if (amountCents <= 0) {
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
    message: "Secure card payment is available through Square.",
    square,
  };
}

async function loadCheckoutRegistration(
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
    access.registrationId,
  );
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
      checkout.message,
    );
  }
  if (
    checkout.state === "CHOICE_REQUIRED"
    || checkout.state === "PAY_LATER"
    || checkout.state === "FORM_UNAVAILABLE"
  ) {
    throw new SquarePaymentOperationError(
      "CARD_PAYMENT_NOT_SELECTED",
      checkout.message,
    );
  }
  if (checkout.state === "NO_BALANCE") {
    throw new SquarePaymentOperationError(
      "PAYMENT_ALREADY_COMPLETE",
      checkout.message,
    );
  }
  throw new SquarePaymentOperationError(
    "PAYMENT_NOT_ELIGIBLE",
    checkout.message,
  );
}

function retryableTransactionError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && (error.code === "P2034" || error.code === "P2002");
}

async function runSerializable<T>(
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
    true,
  );
}

type PreparedPaymentAttempt = {
  operation: "CALL_PROVIDER" | "RETURN_EXISTING";
  attempt: AttemptRecord;
};

function resultFromAttempt(attempt: AttemptRecord) {
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
    message: status === "SUCCEEDED"
      ? "Square confirmed the card payment."
      : status === "PENDING"
        ? "Square is still confirming the payment. Do not submit a second payment."
        : "Square did not complete the payment.",
  };
}

async function preparePaymentAttempt(
  tx: Prisma.TransactionClient,
  token: string,
  input: SquarePaymentInput,
  configuration: SquareRuntimeConfiguration,
  now: Date,
): Promise<PreparedPaymentAttempt> {
  const access = await authorizeRegistrationAccessToken(token, {
    now,
    client: tx,
  });
  if (!access) {
    throw new SquarePaymentOperationError(
      "REGISTRATION_ACCESS_UNAVAILABLE",
      "This private registration link is invalid or no longer active.",
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
        "That payment request key belongs to a different operation.",
      );
    }
    if (existing.status === "FAILED" || existing.status === "CANCELED") {
      throw new SquarePaymentOperationError(
        "PAYMENT_ATTEMPT_FAILED",
        existing.failureMessage
          ?? "That payment attempt has finished. Start a new payment attempt.",
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
    access.registrationId,
  );
  if (!registration || registration.eventId !== access.eventId) {
    throw new SquarePaymentOperationError(
      "REGISTRATION_ACCESS_UNAVAILABLE",
      "This private registration link is invalid or no longer active.",
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
      { attemptStatus: activeAttempt.status },
    );
  }

  const providerKey = providerIdempotencyKey(
    registration.id,
    input.idempotencyKey,
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

async function applyProviderPayment(
  tx: Prisma.TransactionClient,
  attempt: AttemptRecord,
  provider: SquarePaymentResult,
  providerStatusAt: Date,
  now: Date,
  source: "CREATE_PAYMENT" | "WEBHOOK",
) {
  const state = internalPaymentState(provider.status);
  const stale = Boolean(
    attempt.providerStatusAt
    && attempt.providerStatusAt.getTime() > providerStatusAt.getTime(),
  );
  const terminalRegression = attempt.status === "SUCCEEDED"
    && state.attemptStatus !== "SUCCEEDED";
  if (stale || terminalRegression) {
    return {
      attempt,
      pendingMessageIds: [],
    } satisfies AppliedProviderPayment;
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
      activeRegistrationKey: state.terminal ? null : attempt.registrationId,
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
  const receipt = (
    priorStatus !== "SUCCEEDED"
    && state.attemptStatus === "SUCCEEDED"
  )
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
  } satisfies AppliedProviderPayment;
}

async function processPaymentMessagesAfterCommit(messageIds: string[]) {
  if (messageIds.length === 0) return;
  try {
    await processQueuedMessageIdsAfterCommit(messageIds);
  } catch (error) {
    console.error(
      "Payment receipt processing failed after payment commit",
      error instanceof Error ? error.name : "UnknownError",
    );
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
        true,
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
        true,
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

export async function createPublicSquarePayment(
  token: string,
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
      "Online card payment is not configured for this site.",
    );
  }
  const prepared = await runSerializable((tx) => (
    preparePaymentAttempt(tx, token, input, configuration, now)
  ));
  if (prepared.operation === "RETURN_EXISTING") {
    return resultFromAttempt(prepared.attempt);
  }

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
      },
    );
  } catch (error) {
    if (!(error instanceof SquareAdapterError)) throw error;
    const attempt = await recordAdapterFailure(prepared.attempt.id, error, now);
    if (attempt.status !== "PROCESSING") return resultFromAttempt(attempt);
    throw new SquarePaymentOperationError(
      "PAYMENT_RESULT_UNCERTAIN",
      error.message,
      true,
    );
  }

  if (
    provider.amountCents !== prepared.attempt.amountCents
    || provider.currency !== prepared.attempt.currency
  ) {
    await markAmountMismatchForReview(prepared.attempt.id, provider, now);
    throw new SquarePaymentOperationError(
      "PAYMENT_REQUIRES_REVIEW",
      "Square returned a result that does not match the registration balance. No additional payment should be attempted until the event team reviews it.",
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
        true,
      );
    }
    return applyProviderPayment(
      tx,
      attempt,
      provider,
      providerTimestamp(provider.updatedAt ?? provider.createdAt, now),
      now,
      "CREATE_PAYMENT",
    );
  });
  await processPaymentMessagesAfterCommit(applied.pendingMessageIds);
  const result = resultFromAttempt(applied.attempt);
  if (result.status === "FAILED" || result.status === "CANCELED") {
    throw new SquarePaymentOperationError(
      "PAYMENT_DECLINED",
      result.message,
    );
  }
  return result;
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
      payment.id,
    );
  }
  const attempt = await tx.paymentAttempt.findFirst({
    where: {
      provider: "SQUARE",
      environment: configuration.environment,
      OR: [
        { providerPaymentId: payment.id },
        ...(payment.reference_id ? [{ id: payment.reference_id }] : []),
      ],
    },
    include: attemptInclude,
  });
  if (!attempt) {
    return storeIgnoredWebhook(
      tx,
      event,
      payloadHash,
      receivedAt,
      "No IMSDA Square payment attempt matches this provider payment.",
      payment.id,
    );
  }
  if (
    payment.amount_money.amount !== attempt.amountCents
    || payment.amount_money.currency !== attempt.currency
  ) {
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
  const provider: SquarePaymentResult = {
    id: payment.id,
    status: payment.status,
    amountCents: payment.amount_money.amount,
    currency: payment.amount_money.currency,
    createdAt: payment.created_at ?? null,
    updatedAt: payment.updated_at ?? null,
  };
  const applied = await applyProviderPayment(
    tx,
    attempt,
    provider,
    providerTimestamp(
      payment.updated_at ?? payment.created_at ?? null,
      event.occurredAt,
    ),
    receivedAt,
    "WEBHOOK",
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
      providerRefund.id,
    );
  }
  const payment = await tx.payment.findFirst({
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
    include: {
      paymentAttempt: true,
      refunds: true,
      registration: { select: { confirmationCode: true } },
    },
  });
  if (!payment) {
    return storeIgnoredWebhook(
      tx,
      event,
      payloadHash,
      receivedAt,
      "No IMSDA Square payment matches this provider refund.",
      providerRefund.id,
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
      providerRefund.id,
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
      "Square webhook verification is not configured.",
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
        null,
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
          receivedAt,
        );
  });
  const pendingMessageIds = "pendingMessageIds" in result
    ? result.pendingMessageIds
    : [];
  await processPaymentMessagesAfterCommit(pendingMessageIds);
  if ("pendingMessageIds" in result) {
    return {
      status: result.status,
      duplicate: result.duplicate,
      paymentStatus: result.paymentStatus,
    };
  }
  return result;
}
