import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import {
  paymentChoiceQuoteForSelection,
  paymentChoiceRequestFingerprint,
  paymentChoiceResultSchema,
  paymentConfigurationFromDefinition,
  promotedWaitlistPaymentQuote,
  type PaymentChoiceInput,
  type PaymentChoiceResult,
} from "@/modules/payments/payment-choice-domain";
import { moneyToCents } from "@/modules/payments/square-domain";
import { authorizeRegistrationAccessToken } from "@/modules/public-access/repository";

export type PaymentChoiceOperationErrorCode =
  | "REGISTRATION_ACCESS_UNAVAILABLE"
  | "PAYMENT_CHOICE_NOT_ELIGIBLE"
  | "PAYMENT_CHOICE_UNAVAILABLE"
  | "PAYMENT_CHOICE_CHANGED"
  | "PAYMENT_CHOICE_IDEMPOTENCY_CONFLICT"
  | "PAYMENT_CHOICE_LOCKED"
  | "PAYMENT_CHOICE_OPERATION_CONFLICT";

export class PaymentChoiceOperationError extends Error {
  constructor(
    public readonly code: PaymentChoiceOperationErrorCode,
    message: string,
    public readonly retryable = false,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "PaymentChoiceOperationError";
  }
}

const choiceRegistrationSelect = {
  id: true,
  eventId: true,
  confirmationCode: true,
  status: true,
  totalAmount: true,
  waitlistEntry: {
    select: { status: true },
  },
  publicFormSubmission: {
    select: {
      pricingSnapshot: true,
      formVersion: {
        select: { definition: true },
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
  payments: {
    where: {
      status: { in: ["PENDING", "SUCCEEDED"] as const },
    },
    take: 1,
    select: { id: true, status: true },
  },
  paymentChoiceOperations: {
    orderBy: { sequence: "desc" as const },
    take: 1,
    select: {
      id: true,
      sequence: true,
      choice: true,
      baseSubtotalCents: true,
      processingFeeCents: true,
      resultingTotalCents: true,
    },
  },
} satisfies Prisma.RegistrationSelect;

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
  throw new PaymentChoiceOperationError(
    "PAYMENT_CHOICE_OPERATION_CONFLICT",
    "Another payment choice changed this registration at the same time. Refresh and try again.",
    true,
  );
}

function centsAsDecimal(cents: number) {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

function storedResult(value: Prisma.JsonValue): PaymentChoiceResult {
  const parsed = paymentChoiceResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new PaymentChoiceOperationError(
      "PAYMENT_CHOICE_OPERATION_CONFLICT",
      "The saved payment choice could not be verified. Contact the event team before paying.",
    );
  }
  return parsed.data;
}

async function choosePromotedWaitlistPaymentInTransaction(
  tx: Prisma.TransactionClient,
  token: string,
  input: PaymentChoiceInput,
  now: Date,
) {
  const access = await authorizeRegistrationAccessToken(token, {
    now,
    client: tx,
  });
  if (!access) {
    throw new PaymentChoiceOperationError(
      "REGISTRATION_ACCESS_UNAVAILABLE",
      "This private registration link is invalid or no longer active.",
    );
  }

  const requestFingerprint = paymentChoiceRequestFingerprint(
    access.registrationId,
    input,
  );
  const existing = await tx.registrationPaymentChoiceOperation.findUnique({
    where: {
      registrationId_clientRequestId: {
        registrationId: access.registrationId,
        clientRequestId: input.clientRequestId,
      },
    },
    select: {
      requestFingerprint: true,
      responseSnapshot: true,
    },
  });
  if (existing) {
    if (existing.requestFingerprint !== requestFingerprint) {
      throw new PaymentChoiceOperationError(
        "PAYMENT_CHOICE_IDEMPOTENCY_CONFLICT",
        "That request key was already used for a different payment choice. Refresh before trying again.",
      );
    }
    return storedResult(existing.responseSnapshot);
  }

  const registration = await tx.registration.findUnique({
    where: { id: access.registrationId },
    select: choiceRegistrationSelect,
  });
  if (!registration || registration.eventId !== access.eventId) {
    throw new PaymentChoiceOperationError(
      "REGISTRATION_ACCESS_UNAVAILABLE",
      "This private registration link is invalid or no longer active.",
    );
  }
  if (
    registration.waitlistEntry?.status !== "PROMOTED"
    || (
      registration.status !== "SUBMITTED"
      && registration.status !== "CONFIRMED"
    )
  ) {
    throw new PaymentChoiceOperationError(
      "PAYMENT_CHOICE_NOT_ELIGIBLE",
      registration.status === "WAITLISTED"
        ? "No payment choice is needed while this registration is on the waitlist."
        : "This registration is not eligible to change its payment choice.",
    );
  }

  const submission = registration.publicFormSubmission;
  const configuration = submission
    ? paymentConfigurationFromDefinition(
        submission.formVersion.definition,
      )
    : null;
  const preservedQuote = submission
    ? promotedWaitlistPaymentQuote(
        submission.formVersion.definition,
        submission.pricingSnapshot,
      )
    : null;
  if (!configuration || !preservedQuote) {
    throw new PaymentChoiceOperationError(
      "PAYMENT_CHOICE_UNAVAILABLE",
      "The original registration payment settings could not be verified. Contact the event team before paying.",
    );
  }

  const latest = registration.paymentChoiceOperations[0] ?? null;
  if ((latest?.id ?? null) !== input.expectedPriorOperationId) {
    throw new PaymentChoiceOperationError(
      "PAYMENT_CHOICE_CHANGED",
      "The payment choice changed in another browser window. Refresh this page before choosing again.",
      false,
      { currentOperationId: latest?.id ?? null },
    );
  }
  if (
    registration.paymentAttempts.length > 0
    || registration.payments.length > 0
  ) {
    throw new PaymentChoiceOperationError(
      "PAYMENT_CHOICE_LOCKED",
      "A payment has already started or been recorded. Contact the event team before changing the payment choice.",
    );
  }

  const expectedCurrentTotal = latest?.resultingTotalCents
    ?? preservedQuote.payLaterTotalCents;
  const currentTotal = moneyToCents(registration.totalAmount);
  if (
    currentTotal !== expectedCurrentTotal
    || (
      latest
      && (
        latest.baseSubtotalCents !== preservedQuote.baseSubtotalCents
        || latest.resultingTotalCents
          !== latest.baseSubtotalCents + latest.processingFeeCents
      )
    )
  ) {
    throw new PaymentChoiceOperationError(
      "PAYMENT_CHOICE_OPERATION_CONFLICT",
      "The registration total no longer matches its preserved waitlist quote. Contact the event team before paying.",
    );
  }

  const quote = paymentChoiceQuoteForSelection(
    configuration.definition,
    preservedQuote.baseSubtotalCents,
    input.choice,
  );
  const operationId = randomUUID();
  const result = paymentChoiceResultSchema.parse({
    operationId,
    choice: input.choice,
    ...quote,
    currency: "USD",
  });
  const sequence = (latest?.sequence ?? 0) + 1;

  await tx.registration.update({
    where: { id: registration.id },
    data: { totalAmount: centsAsDecimal(result.totalCents) },
  });
  await tx.registrationPaymentChoiceOperation.create({
    data: {
      id: operationId,
      eventId: registration.eventId,
      registrationId: registration.id,
      sequence,
      clientRequestId: input.clientRequestId,
      requestFingerprint,
      expectedPriorOperationId: input.expectedPriorOperationId,
      choice: input.choice,
      baseSubtotalCents: result.baseSubtotalCents,
      processingFeeCents: result.processingFeeCents,
      resultingTotalCents: result.totalCents,
      responseSnapshot: result as Prisma.InputJsonValue,
      createdAt: now,
    },
  });
  await tx.auditLog.create({
    data: {
      eventId: registration.eventId,
      action: "PROMOTED_WAITLIST_PAYMENT_CHOICE_SELECTED",
      entityType: "Registration",
      entityId: registration.id,
      correlationId: operationId,
      summary: `${input.choice === "CARD" ? "Card" : "Pay-later"} payment selected for promoted waitlist registration ${registration.confirmationCode}.`,
      metadata: {
        paymentChoiceOperationId: operationId,
        sequence,
        choice: input.choice,
        baseSubtotalCents: result.baseSubtotalCents,
        processingFeeCents: result.processingFeeCents,
        resultingTotalCents: result.totalCents,
        registrationAccessTokenId: access.accessTokenId,
      },
    },
  });
  return result;
}

export function choosePublicPromotedWaitlistPayment(
  token: string,
  input: PaymentChoiceInput,
  options: { now?: Date } = {},
) {
  const now = options.now ?? new Date();
  return runSerializable((tx) => (
    choosePromotedWaitlistPaymentInTransaction(
      tx,
      token,
      input,
      now,
    )
  ));
}
