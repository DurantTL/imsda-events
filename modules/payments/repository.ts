import { getPrisma } from "@/lib/prisma";
import { getRegistrationById } from "@/modules/registrations/repository";

export class PaymentOperationError extends Error {
  constructor(public readonly code: "REGISTRATION_NOT_FOUND" | "REGISTRATION_NOT_PAYABLE" | "PAYMENT_NOT_FOUND" | "PAYMENT_EXCEEDS_BALANCE" | "REFUND_EXCEEDS_AVAILABLE" | "CARD_REFUND_REQUIRES_SQUARE") {
    super(
      code === "CARD_REFUND_REQUIRES_SQUARE"
        ? "Card refunds must be issued in Square. IMSDA Events will update automatically after Square confirms the refund."
        : code === "REFUND_EXCEEDS_AVAILABLE"
        ? "The refund exceeds the remaining refundable amount."
        : code === "REGISTRATION_NOT_PAYABLE"
          ? "Payments can only be recorded for submitted or confirmed registrations."
        : code === "PAYMENT_EXCEEDS_BALANCE"
          ? "The payment exceeds the registration’s current balance."
          : "The requested financial record was not found.",
    );
    this.name = "PaymentOperationError";
  }
}

export async function recordManualPayment(
  eventId: string,
  registrationId: string,
  actorUserId: string,
  input: { amountCents: number; method: "CASH" | "CHECK" | "MANUAL"; reference: string },
) {
  const prisma = getPrisma();
  const registration = await prisma.registration.findFirst({
    where: { id: registrationId, eventId },
    include: { payments: { where: { status: "SUCCEEDED" }, include: { refunds: { where: { status: "SUCCEEDED" } } } } },
  });
  if (!registration) throw new PaymentOperationError("REGISTRATION_NOT_FOUND");
  if (registration.status !== "SUBMITTED" && registration.status !== "CONFIRMED") {
    throw new PaymentOperationError("REGISTRATION_NOT_PAYABLE");
  }
  const netPaidCents = registration.payments.reduce((total, payment) => {
    const refunds = payment.refunds.reduce((sum, refund) => sum + Math.round(Number(refund.amount) * 100), 0);
    return total + Math.round(Number(payment.amount) * 100) - refunds;
  }, 0);
  const balanceCents = Math.max(Math.round(Number(registration.totalAmount) * 100) - netPaidCents, 0);
  if (input.amountCents > balanceCents) throw new PaymentOperationError("PAYMENT_EXCEEDS_BALANCE");

  await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.create({
      data: {
        eventId,
        registrationId,
        amount: input.amountCents / 100,
        status: "SUCCEEDED",
        method: input.method,
        externalReference: input.reference || null,
        receivedAt: new Date(),
      },
    });
    await tx.auditLog.create({
      data: {
        eventId,
        actorUserId,
        action: "MANUAL_PAYMENT_RECORDED",
        entityType: "Payment",
        entityId: payment.id,
        correlationId: crypto.randomUUID(),
        summary: `Recorded a ${input.method.toLowerCase()} payment on registration ${registration.confirmationCode}.`,
        metadata: { amountCents: input.amountCents },
      },
    });
  });

  return getRegistrationById(eventId, registrationId);
}

export async function recordRefund(
  eventId: string,
  paymentId: string,
  actorUserId: string,
  input: { amountCents: number; reason: string },
) {
  const prisma = getPrisma();
  const payment = await prisma.payment.findFirst({
    where: { id: paymentId, eventId, status: "SUCCEEDED" },
    include: { refunds: { where: { status: "SUCCEEDED" } }, registration: true },
  });
  if (!payment) throw new PaymentOperationError("PAYMENT_NOT_FOUND");
  if (payment.method === "CARD_REFERENCE") {
    throw new PaymentOperationError("CARD_REFUND_REQUIRES_SQUARE");
  }

  const refundedCents = payment.refunds.reduce((total, refund) => total + Math.round(Number(refund.amount) * 100), 0);
  const refundableCents = Math.max(Math.round(Number(payment.amount) * 100) - refundedCents, 0);
  if (input.amountCents > refundableCents) throw new PaymentOperationError("REFUND_EXCEEDS_AVAILABLE");

  await prisma.$transaction(async (tx) => {
    const refund = await tx.refund.create({
      data: {
        eventId,
        paymentId,
        amount: input.amountCents / 100,
        status: "SUCCEEDED",
        reason: input.reason,
      },
    });
    await tx.auditLog.create({
      data: {
        eventId,
        actorUserId,
        action: "REFUND_RECORDED",
        entityType: "Refund",
        entityId: refund.id,
        correlationId: crypto.randomUUID(),
        summary: `Recorded a refund on registration ${payment.registration.confirmationCode}.`,
        metadata: { amountCents: input.amountCents, paymentId },
      },
    });
  });

  return getRegistrationById(eventId, payment.registrationId);
}
