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
    attendeeId: z.string().trim().min(1).max(64).optional(),
  }).strict(),
  z.object({
    kind: z.literal("CORRECTION"),
    /** Positive raises the amount owed; negative lowers it. */
    amountCents: z.number().int().min(-10_000_000).max(10_000_000).refine((value) => value !== 0, "Enter an amount."),
    reason: z.string().trim().min(3, "Enter a reason.").max(500),
    attendeeId: z.string().trim().min(1).max(64).optional(),
  }).strict(),
  z.object({
    kind: z.literal("PROMO_CODE"),
    code: z.string().trim().min(1, "Enter a promo code.").max(40),
    reason: z.string().trim().min(3, "Enter a reason.").max(500),
    /** One person in the registration (#397): the code prices that person's share only. */
    attendeeId: z.string().trim().min(1).max(64).optional(),
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
  | "PROMO_INVALID"
  | "ATTENDEE_NOT_FOUND"
  | "ATTENDEE_PRICE_UNKNOWN";

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

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * One person's share of the priced registration, from the latest pricing
 * snapshot (an amendment's, else the submission's): the line items carrying
 * their attendee index. Null when the registration has no per-person pricing
 * (entered by staff, or a single-person form).
 */
function attendeePriceCents(
  registration: { publicFormSubmission: { pricingSnapshot: unknown } | null; operations: Array<{ afterSnapshot: unknown }> },
  attendeeIndex: number,
) {
  const amended = record(record(registration.operations[0]?.afterSnapshot).pricingSnapshot);
  const snapshot = Object.keys(amended).length > 0 ? amended : record(registration.publicFormSubmission?.pricingSnapshot);
  const lines = Array.isArray(snapshot.lineItems) ? snapshot.lineItems.map(record) : [];
  const own = lines.filter((line) => line.attendeeIndex === attendeeIndex && typeof line.amountCents === "number");
  if (own.length === 0) return null;
  return own.reduce((total, line) => total + (line.amountCents as number), 0);
}

function attendeeName(attendee: { profileSnapshot: unknown; person: { firstName: string; lastName: string } }) {
  const profile = record(attendee.profileSnapshot);
  const first = typeof profile.firstName === "string" ? profile.firstName : attendee.person.firstName;
  const last = typeof profile.lastName === "string" ? profile.lastName : attendee.person.lastName;
  return `${first} ${last}`.trim();
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
      attendees: {
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
        select: { id: true, profileSnapshot: true, person: { select: { firstName: true, lastName: true } } },
      },
      publicFormSubmission: { select: { pricingSnapshot: true } },
      operations: {
        where: { type: "AMENDMENT" },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { afterSnapshot: true },
      },
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
    const attendeeIndex = input.attendeeId
      ? registration.attendees.findIndex((attendee) => attendee.id === input.attendeeId)
      : -1;
    if (input.attendeeId && attendeeIndex < 0) {
      throw new AdjustmentError("ATTENDEE_NOT_FOUND", "That person isn't on this registration.");
    }
    const attendee = attendeeIndex >= 0 ? registration.attendees[attendeeIndex]! : null;

    if (input.kind === "PROMO_CODE") {
      // Per person only (#397): one code per person, and never on top of a
      // whole-registration code.
      const activePromos = await tx.registrationAdjustment.findMany({
        where: { registrationId, kind: "PROMO_CODE", reversedBy: null, reversesAdjustmentId: null },
        select: { registrationAttendeeId: true },
      });
      const wholeRegistrationPromo = Boolean(registration.promoCodeRedemption)
        || activePromos.some((existing) => !existing.registrationAttendeeId);
      if (wholeRegistrationPromo || (!attendee && activePromos.length > 0)) {
        throw new AdjustmentError(
          "PROMO_ALREADY_APPLIED",
          attendee
            ? "This registration already has a code for everyone on it, so a per-person code would double up. Reverse that code first."
            : "This registration already has a promo code. Use a discount instead, or reverse the earlier code first.",
        );
      }
      if (attendee && activePromos.some((existing) => existing.registrationAttendeeId === attendee.id)) {
        throw new AdjustmentError(
          "PROMO_ALREADY_APPLIED",
          `${attendeeName(attendee)} already has a promo code. Reverse it first to use a different one.`,
        );
      }
      // The code is judged against the price before any adjustments (or that
      // person's share of it), on the date the person registered — so an
      // early-bird code still counts for someone who registered in the
      // early-bird window.
      const personCents = attendee ? attendeePriceCents(registration, attendeeIndex) : null;
      if (attendee && personCents === null) {
        throw new AdjustmentError(
          "ATTENDEE_PRICE_UNKNOWN",
          `There's no per-person price on file for ${attendeeName(attendee)}. Apply the code to the whole registration, or use a discount for the amount.`,
        );
      }
      const pricedCents = personCents ?? registration.totalCents - await adjustmentTotalCents(tx, registrationId);
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
        registrationAttendeeId: attendee?.id ?? null,
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
        registrationAttendeeId: attendee?.id ?? null,
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
      select: { id: true, kind: true, amountCents: true, promoCodeId: true, promoCodeSnapshot: true, registrationAttendeeId: true, reversesAdjustmentId: true, reversedBy: { select: { id: true } } },
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
        registrationAttendeeId: original.registrationAttendeeId,
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
