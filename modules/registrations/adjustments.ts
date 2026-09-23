import "server-only";

import { Prisma, type RegistrationAdjustmentKind } from "@prisma/client";
import { z } from "zod";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { claimPromoCode, PromoCodeOperationError, PublicPromoCodeError } from "@/modules/promo-codes/repository";
import { getRegistrationById } from "@/modules/registrations/repository";

/**
 * Staff adjustments to what a registration owes (#396): scholarships,
 * discounts, a promo code applied after submission, and corrections.
 *
 * Each adjustment is a line that is never edited. The registration total is
 * the priced total plus every line, so balances, reminders, exports, and
 * online payment all see the adjusted amount without knowing about lines.
 * Repricing (amendments, payment-choice changes) adds the lines back on top
 * of the new priced total with {@link adjustmentTotalCents}.
 */

export const createAdjustmentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.enum(["SCHOLARSHIP", "DISCOUNT"]),
    amountCents: z.number().int().min(1, "Enter an amount.").max(10_000_000),
    reason: z.string().trim().min(3, "Enter a reason.").max(500),
  }).strict(),
  z.object({
    kind: z.literal("CORRECTION"),
    /** Positive raises the amount owed; negative lowers it. */
    amountCents: z.number().int().min(-10_000_000).max(10_000_000).refine((value) => value !== 0, "Enter an amount."),
    reason: z.string().trim().min(3, "Enter a reason.").max(500),
  }).strict(),
  z.object({
    kind: z.literal("PROMO_CODE"),
    code: z.string().trim().min(1, "Enter a promo code.").max(40),
    reason: z.string().trim().min(3, "Enter a reason.").max(500),
  }).strict(),
]);

export const reverseAdjustmentSchema = z.object({
  reason: z.string().trim().min(3, "Enter a reason.").max(500),
}).strict();

export type CreateAdjustmentInput = z.infer<typeof createAdjustmentSchema>;

export type AdjustmentErrorCode =
  | "REGISTRATION_NOT_FOUND"
  | "REGISTRATION_NOT_ADJUSTABLE"
  | "ADJUSTMENT_NOT_FOUND"
  | "ADJUSTMENT_ALREADY_REVERSED"
  | "TOTAL_BELOW_ZERO"
  | "TOTAL_BELOW_PAID"
  | "PROMO_ALREADY_APPLIED"
  | "PROMO_INVALID";

export class AdjustmentError extends Error {
  constructor(public readonly code: AdjustmentErrorCode, message: string) {
    super(message);
    this.name = "AdjustmentError";
  }
}

type Client = Prisma.TransactionClient;

function cents(value: { toString(): string } | number) {
  return Math.round(Number(value) * 100);
}

function money(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value / 100);
}

/** The sum of every adjustment line on a registration, in cents. */
export async function adjustmentTotalCents(client: Client, registrationId: string) {
  const result = await client.registrationAdjustment.aggregate({
    where: { registrationId },
    _sum: { amountCents: true },
  });
  return result._sum.amountCents ?? 0;
}

async function loadRegistration(tx: Client, eventId: string, registrationId: string) {
  const registration = await tx.registration.findFirst({
    where: { id: registrationId, eventId },
    select: {
      id: true,
      confirmationCode: true,
      status: true,
      totalAmount: true,
      submittedAt: true,
      createdAt: true,
      promoCodeRedemption: { select: { id: true } },
      payments: {
        where: { status: "SUCCEEDED" },
        select: { amount: true, refunds: { where: { status: "SUCCEEDED" }, select: { amount: true } } },
      },
    },
  });
  if (!registration) {
    throw new AdjustmentError("REGISTRATION_NOT_FOUND", "That registration could not be found.");
  }
  if (registration.status !== "SUBMITTED" && registration.status !== "CONFIRMED") {
    throw new AdjustmentError(
      "REGISTRATION_NOT_ADJUSTABLE",
      "The amount owed can only be adjusted on submitted or confirmed registrations.",
    );
  }
  const paidCents = registration.payments.reduce((total, payment) => (
    total + cents(payment.amount) - payment.refunds.reduce((sum, refund) => sum + cents(refund.amount), 0)
  ), 0);
  return { ...registration, totalCents: cents(registration.totalAmount), paidCents };
}

function checkNewTotal(currentTotalCents: number, changeCents: number, paidCents: number) {
  const next = currentTotalCents + changeCents;
  if (next < 0) {
    throw new AdjustmentError(
      "TOTAL_BELOW_ZERO",
      `That would make the total less than $0. The most it can come down is ${money(currentTotalCents)}.`,
    );
  }
  if (next < paidCents) {
    throw new AdjustmentError(
      "TOTAL_BELOW_PAID",
      `That would bring the total (${money(next)}) below what has already been paid (${money(paidCents)}). Record a refund first, then adjust.`,
    );
  }
  return next;
}

async function actorName(tx: Client, actorUserId: string) {
  const actor = await tx.user.findUnique({ where: { id: actorUserId }, select: { displayName: true } });
  return actor?.displayName ?? "Staff";
}

async function withRetry<T>(work: (tx: Client) => Promise<T>) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await getPrisma().$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      const retryable = error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
      if (!retryable || attempt === 2) throw error;
    }
  }
  throw new Error("unreachable");
}

export async function createRegistrationAdjustment(
  eventId: string,
  registrationId: string,
  actorUserId: string,
  input: CreateAdjustmentInput,
) {
  await withRetry(async (tx) => {
    const registration = await loadRegistration(tx, eventId, registrationId);
    let kind: RegistrationAdjustmentKind = input.kind;
    let changeCents: number;
    let promo: { id: string; code: string } | null = null;

    if (input.kind === "PROMO_CODE") {
      const promoAdjustment = await tx.registrationAdjustment.findFirst({
        where: { registrationId, kind: "PROMO_CODE", reversedBy: null, reversesAdjustmentId: null },
        select: { id: true },
      });
      if (registration.promoCodeRedemption || promoAdjustment) {
        throw new AdjustmentError(
          "PROMO_ALREADY_APPLIED",
          "This registration already has a promo code. Use a discount instead, or reverse the earlier code first.",
        );
      }
      // The code is judged against the price before any adjustments, on the
      // date the person registered — so an early-bird code still counts for
      // someone who registered in the early-bird window.
      const pricedCents = registration.totalCents - await adjustmentTotalCents(tx, registrationId);
      const pricingDate = (registration.submittedAt ?? registration.createdAt).toISOString().slice(0, 10);
      try {
        const claimed = await claimPromoCode(tx, {
          eventId,
          submittedCode: input.code,
          eligibleSubtotalCents: pricedCents,
          pricingDate,
          fieldId: "promo_code",
        });
        changeCents = -claimed.evaluation.discountAmountCents;
        promo = { id: claimed.promoCode.id, code: claimed.promoCode.code };
      } catch (error) {
        if (error instanceof PublicPromoCodeError || error instanceof PromoCodeOperationError) {
          throw new AdjustmentError("PROMO_INVALID", error.message);
        }
        throw error;
      }
    } else if (input.kind === "CORRECTION") {
      changeCents = input.amountCents;
    } else {
      kind = input.kind;
      changeCents = -input.amountCents;
    }

    const nextTotal = checkNewTotal(registration.totalCents, changeCents, registration.paidCents);
    const adjustment = await tx.registrationAdjustment.create({
      data: {
        eventId,
        registrationId,
        kind,
        amountCents: changeCents,
        reason: input.reason,
        promoCodeId: promo?.id ?? null,
        promoCodeSnapshot: promo?.code ?? null,
        createdByUserId: actorUserId,
        createdByNameSnapshot: await actorName(tx, actorUserId),
      },
    });
    await tx.registration.update({
      where: { id: registrationId },
      data: { totalAmount: nextTotal / 100 },
    });
    await writeAuditLog({
      eventId,
      actorUserId,
      action: "REGISTRATION_ADJUSTMENT_ADDED",
      entityType: "RegistrationAdjustment",
      entityId: adjustment.id,
      summary: `Adjusted the amount owed on registration ${registration.confirmationCode}.`,
      metadata: {
        registrationId,
        kind,
        amountCents: changeCents,
        totalBeforeCents: registration.totalCents,
        totalAfterCents: nextTotal,
        promoCode: promo?.code ?? null,
      },
    }, tx);
  });
  return getRegistrationById(eventId, registrationId);
}

/** Cancels an adjustment with an opposite line; the original stays on record. */
export async function reverseRegistrationAdjustment(
  eventId: string,
  registrationId: string,
  adjustmentId: string,
  actorUserId: string,
  reason: string,
) {
  await withRetry(async (tx) => {
    const registration = await loadRegistration(tx, eventId, registrationId);
    const original = await tx.registrationAdjustment.findFirst({
      where: { id: adjustmentId, registrationId, eventId },
      select: { id: true, kind: true, amountCents: true, promoCodeId: true, promoCodeSnapshot: true, reversesAdjustmentId: true, reversedBy: { select: { id: true } } },
    });
    if (!original || original.reversesAdjustmentId) {
      throw new AdjustmentError("ADJUSTMENT_NOT_FOUND", "That adjustment could not be found.");
    }
    if (original.reversedBy) {
      throw new AdjustmentError("ADJUSTMENT_ALREADY_REVERSED", "That adjustment was already reversed.");
    }
    const changeCents = -original.amountCents;
    const nextTotal = checkNewTotal(registration.totalCents, changeCents, registration.paidCents);
    const reversal = await tx.registrationAdjustment.create({
      data: {
        eventId,
        registrationId,
        kind: original.kind,
        amountCents: changeCents,
        reason,
        promoCodeId: original.promoCodeId,
        promoCodeSnapshot: original.promoCodeSnapshot,
        reversesAdjustmentId: original.id,
        createdByUserId: actorUserId,
        createdByNameSnapshot: await actorName(tx, actorUserId),
      },
    });
    if (original.kind === "PROMO_CODE" && original.promoCodeId) {
      // Give the use back to the code.
      await tx.promoCode.updateMany({
        where: { id: original.promoCodeId, redeemedCount: { gt: 0 } },
        data: { redeemedCount: { decrement: 1 } },
      });
    }
    await tx.registration.update({
      where: { id: registrationId },
      data: { totalAmount: nextTotal / 100 },
    });
    await writeAuditLog({
      eventId,
      actorUserId,
      action: "REGISTRATION_ADJUSTMENT_REVERSED",
      entityType: "RegistrationAdjustment",
      entityId: reversal.id,
      summary: `Reversed an adjustment on registration ${registration.confirmationCode}.`,
      metadata: {
        registrationId,
        reversesAdjustmentId: original.id,
        kind: original.kind,
        amountCents: changeCents,
        totalBeforeCents: registration.totalCents,
        totalAfterCents: nextTotal,
      },
    }, tx);
  });
  return getRegistrationById(eventId, registrationId);
}
