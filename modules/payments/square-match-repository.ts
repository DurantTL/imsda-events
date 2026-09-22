import "server-only";

import { randomUUID } from "node:crypto";
import { getPrisma } from "@/lib/prisma";
import { getSquarePayment } from "@/modules/payments/square-http";
import {
  getSquareConfiguration,
  type SquareRuntimeConfiguration,
} from "@/modules/payments/square-config";
import {
  collectSquareReconciliationReport,
  isActionable,
  type SquareReconciliationFinding,
} from "@/modules/payments/square-reconciliation";
import {
  moneyToCents,
  registrationBalanceCents,
} from "@/modules/payments/square-domain";

export class SquareMatchOperationError extends Error {
  constructor(
    public readonly code:
      | "SQUARE_NOT_CONFIGURED"
      | "SQUARE_UNREACHABLE"
      | "PROVIDER_PAYMENT_NOT_FOUND"
      | "PROVIDER_PAYMENT_NOT_COMPLETED"
      | "PROVIDER_PAYMENT_WRONG_LOCATION"
      | "PAYMENT_ALREADY_RECORDED"
      | "PAYMENT_LIKELY_DUPLICATE"
      | "REGISTRATION_NOT_FOUND"
      | "REGISTRATION_NOT_PAYABLE",
    message: string,
  ) {
    super(message);
    this.name = "SquareMatchOperationError";
  }
}

const defaultWindowDays = 90;

/**
 * Completed Square payments this database never recorded, for the staff screen
 * that attaches them by hand. Read-only.
 */
export async function listUnmatchedSquarePayments(
  options: {
    days?: number;
    configuration?: SquareRuntimeConfiguration;
  } = {},
): Promise<{
  findings: SquareReconciliationFinding[];
  examined: number;
  unreachableSquare: boolean;
  environment: string;
}> {
  const configuration = options.configuration ?? getSquareConfiguration();
  if (!configuration.paymentConfigured) {
    throw new SquareMatchOperationError(
      "SQUARE_NOT_CONFIGURED",
      "Square is not configured for this site.",
    );
  }
  const days = Math.min(Math.max(options.days ?? defaultWindowDays, 1), 365);
  const beginTime = new Date(
    Date.now() - days * 24 * 60 * 60 * 1000,
  ).toISOString();
  const report = await collectSquareReconciliationReport(
    getPrisma(),
    configuration,
    { beginTime },
  );
  return {
    findings: report.findings.filter(isActionable),
    examined: report.examined,
    unreachableSquare: report.unreachableSquare,
    environment: report.environment,
  };
}

/**
 * Attach a Square payment to a registration, on a staff member's decision.
 *
 * The browser names the provider payment and the registration; it never says
 * what the payment was worth. The amount, status, and location are re-read
 * from Square here, so a tampered request cannot invent a payment or inflate
 * one. The recorded amount is exactly what Square took — where that exceeds
 * the outstanding balance (the card fee the payer was charged on top), the
 * registration is left showing the overpayment rather than having its total
 * quietly rewritten, because the reason for the gap is a judgement only the
 * finance team can make.
 *
 * No receipt is sent. These payments are often weeks old, and a surprise
 * receipt for money already paid causes more confusion than it settles.
 */
export async function attachSquarePaymentToRegistration(
  eventId: string,
  registrationId: string,
  actorUserId: string,
  input: {
    providerPaymentId: string;
    note?: string;
    /**
     * Set only when a human has looked at the existing payment and confirmed
     * this is a genuine second payment, not the same money under another
     * reference.
     */
    acknowledgeDuplicate?: boolean;
  },
  options: { configuration?: SquareRuntimeConfiguration } = {},
) {
  const configuration = options.configuration ?? getSquareConfiguration();
  if (!configuration.paymentConfigured) {
    throw new SquareMatchOperationError(
      "SQUARE_NOT_CONFIGURED",
      "Square is not configured for this site.",
    );
  }
  const prisma = getPrisma();

  let provider;
  try {
    provider = await getSquarePayment(configuration, input.providerPaymentId);
  } catch {
    throw new SquareMatchOperationError(
      "SQUARE_UNREACHABLE",
      "Square could not confirm this payment. Try again shortly.",
    );
  }
  if (!provider) {
    throw new SquareMatchOperationError(
      "PROVIDER_PAYMENT_NOT_FOUND",
      "Square has no payment with that reference.",
    );
  }
  if (provider.status !== "COMPLETED") {
    throw new SquareMatchOperationError(
      "PROVIDER_PAYMENT_NOT_COMPLETED",
      `Square reports this payment as ${provider.status.toLowerCase()}, so it cannot be recorded as received.`,
    );
  }
  if (provider.locationId && provider.locationId !== configuration.locationId) {
    throw new SquareMatchOperationError(
      "PROVIDER_PAYMENT_WRONG_LOCATION",
      "That payment was taken at a Square location this site does not serve.",
    );
  }

  const registration = await prisma.registration.findFirst({
    where: { id: registrationId, eventId },
    select: {
      id: true,
      confirmationCode: true,
      status: true,
      totalAmount: true,
      payments: {
        where: { status: "SUCCEEDED" },
        select: {
          id: true,
          amount: true,
          externalReference: true,
          refunds: { where: { status: "SUCCEEDED" }, select: { amount: true } },
        },
      },
    },
  });
  if (!registration) {
    throw new SquareMatchOperationError(
      "REGISTRATION_NOT_FOUND",
      "That registration is not part of this event.",
    );
  }
  if (
    registration.status !== "SUBMITTED"
    && registration.status !== "CONFIRMED"
  ) {
    throw new SquareMatchOperationError(
      "REGISTRATION_NOT_PAYABLE",
      "Payments can only be attached to submitted or confirmed registrations.",
    );
  }
  const balanceCents = registrationBalanceCents(registration);

  // The reference this app records is not the only one in circulation. The
  // WR26 import copied a "Square Payment ID" column straight out of the source
  // spreadsheet (`wr26-bundle.ts`), unverified, and where that column held an
  // id from another namespace the same real payment is already on the
  // registration under a reference Square would not recognise. Deduplicating
  // on the provider id alone cannot see it, so the money would be counted
  // twice — which is exactly what happened before this guard existed.
  //
  // A successful payment for the same amount is the signal. The caller has to
  // say plainly that it is genuinely a second payment before this proceeds.
  const sameAmount = registration.payments.find(
    (existing) => moneyToCents(existing.amount) === provider.amountCents,
  );
  if (sameAmount && !input.acknowledgeDuplicate) {
    throw new SquareMatchOperationError(
      "PAYMENT_LIKELY_DUPLICATE",
      `Registration ${registration.confirmationCode} already has a ${
        provider.amountCents / 100
      } payment recorded under reference ${
        sameAmount.externalReference ?? "none"
      }. This is very likely the same money under a different reference.`,
    );
  }

  const payment = await prisma.$transaction(async (tx) => {
    // Inside the transaction: two staff members working the same list must not
    // both record the same provider payment.
    const existing = await tx.payment.findFirst({
      where: { externalReference: provider.id },
      select: { id: true },
    });
    if (existing) {
      throw new SquareMatchOperationError(
        "PAYMENT_ALREADY_RECORDED",
        "That Square payment is already recorded against a registration.",
      );
    }
    const created = await tx.payment.create({
      data: {
        eventId,
        registrationId: registration.id,
        amount: provider.amountCents / 100,
        status: "SUCCEEDED",
        method: "CARD_REFERENCE",
        externalReference: provider.id,
        receivedAt: provider.createdAt
          ? new Date(provider.createdAt)
          : new Date(),
      },
    });
    await tx.auditLog.create({
      data: {
        eventId,
        actorUserId,
        action: "SQUARE_PAYMENT_MANUALLY_MATCHED",
        entityType: "Payment",
        entityId: created.id,
        correlationId: randomUUID(),
        summary: `Attached a Square payment taken outside IMSDA Events to registration ${registration.confirmationCode}.`,
        metadata: {
          provider: "SQUARE",
          providerPaymentId: provider.id,
          providerReference: provider.referenceId,
          amountCents: provider.amountCents,
          currency: provider.currency,
          balanceBeforeCents: balanceCents,
          overpaidCents: Math.max(provider.amountCents - balanceCents, 0),
          staffNote: input.note?.slice(0, 500) ?? null,
          acknowledgedDuplicateOf: sameAmount?.id ?? null,
        },
      },
    });
    return created;
  });

  return {
    paymentId: payment.id,
    registrationId: registration.id,
    confirmationCode: registration.confirmationCode,
    amountCents: provider.amountCents,
    balanceBeforeCents: balanceCents,
    overpaidCents: Math.max(provider.amountCents - balanceCents, 0),
  };
}
