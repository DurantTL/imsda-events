import type { RegistrationStatus } from "@prisma/client";
import { z } from "zod";

const millisecondsPerDay = 24 * 60 * 60 * 1_000;
const opaqueTokenPattern = /^[A-Za-z0-9_-]{43}$/;

const publicEmailSchema = z
  .string()
  .trim()
  .min(1, "Email is required.")
  .max(160, "Email must be 160 characters or fewer.")
  .transform((value) => value.toLowerCase())
  .refine((value) => z.email().safeParse(value).success, "Enter a valid email address.");

export const publicContactUpdateSchema = z.strictObject({
  firstName: z.string().trim().min(1, "First name is required.").max(80),
  lastName: z.string().trim().min(1, "Last name is required.").max(80),
  email: publicEmailSchema,
  phone: z.string().trim().max(40),
});

export type PublicContactUpdateInput = z.infer<typeof publicContactUpdateSchema>;

export type PublicRegistrationStatusSummary = {
  label: string;
  detail: string;
  tone: "neutral" | "positive" | "waiting" | "cancelled";
};

export type PublicPaymentState =
  | "NOT_DUE"
  | "NO_PAYMENT_REQUIRED"
  | "BALANCE_DUE"
  | "PARTIALLY_PAID"
  | "PAID";

export type PublicPaymentSummary = {
  currency: "USD";
  state: PublicPaymentState;
  label: string;
  detail: string;
  totalCents: number;
  paidCents: number;
  refundedCents: number;
  amountDueCents: number;
  paymentEligible: boolean;
};

export function isRegistrationAccessToken(value: string) {
  return opaqueTokenPattern.test(value);
}

export function defaultRegistrationAccessExpiry(
  now: Date,
  eventEndsAt: Date,
) {
  if (Number.isNaN(now.valueOf()) || Number.isNaN(eventEndsAt.valueOf())) {
    throw new RangeError("Valid issue and event end dates are required.");
  }

  const minimumExpiry = now.getTime() + (30 * millisecondsPerDay);
  const postEventExpiry = eventEndsAt.getTime() + (30 * millisecondsPerDay);
  return new Date(Math.max(minimumExpiry, postEventExpiry));
}

export function describePublicRegistrationStatus(
  status: RegistrationStatus,
  waitlistPosition: number | null,
): PublicRegistrationStatusSummary {
  switch (status) {
    case "CONFIRMED":
      return {
        label: "Confirmed",
        detail: "Your place at this event is confirmed.",
        tone: "positive",
      };
    case "WAITLISTED":
      return {
        label: waitlistPosition
          ? `Waitlisted · position ${waitlistPosition}`
          : "Waitlisted",
        detail: "Your registration is on the waitlist. A place is not confirmed, and no payment is due while you wait.",
        tone: "waiting",
      };
    case "CANCELLED":
      return {
        label: "Cancelled",
        detail: "This registration has been cancelled. Contact the event team if this does not look right.",
        tone: "cancelled",
      };
    case "SUBMITTED":
      return {
        label: "Submitted",
        detail: "Your registration was received and is awaiting final confirmation.",
        tone: "neutral",
      };
    case "DRAFT":
      return {
        label: "Not submitted",
        detail: "This registration has not been submitted to the event team.",
        tone: "neutral",
      };
  }
}

function cents(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

export function summarizePublicPayment(input: {
  status: RegistrationStatus;
  totalCents: number;
  payments: Array<{ amountCents: number; refundedCents: number }>;
}): PublicPaymentSummary {
  const totalCents = cents(input.totalCents);
  const grossPaidCents = input.payments.reduce(
    (total, payment) => total + cents(payment.amountCents),
    0,
  );
  const refundedCents = input.payments.reduce(
    (total, payment) => total + cents(payment.refundedCents),
    0,
  );
  const paidCents = Math.max(grossPaidCents - refundedCents, 0);
  const activeForPayment = input.status === "SUBMITTED" || input.status === "CONFIRMED";
  const balanceCents = Math.max(totalCents - paidCents, 0);

  if (input.status === "WAITLISTED") {
    return {
      currency: "USD",
      state: "NOT_DUE",
      label: "No payment due while waitlisted",
      detail: "The estimated registration total is shown for reference. Payment is not due unless the event team confirms a place.",
      totalCents,
      paidCents,
      refundedCents,
      amountDueCents: 0,
      paymentEligible: false,
    };
  }

  if (input.status === "CANCELLED" || input.status === "DRAFT") {
    return {
      currency: "USD",
      state: "NOT_DUE",
      label: input.status === "CANCELLED" ? "No payment due on a cancelled registration" : "No payment due yet",
      detail: input.status === "CANCELLED"
        ? "Any payment or refund questions should be handled directly with the event team."
        : "Payment becomes relevant only after this registration is submitted.",
      totalCents,
      paidCents,
      refundedCents,
      amountDueCents: 0,
      paymentEligible: false,
    };
  }

  if (totalCents === 0) {
    return {
      currency: "USD",
      state: "NO_PAYMENT_REQUIRED",
      label: "No payment required",
      detail: "This registration does not currently have a fee.",
      totalCents,
      paidCents,
      refundedCents,
      amountDueCents: 0,
      paymentEligible: false,
    };
  }

  if (balanceCents === 0) {
    return {
      currency: "USD",
      state: "PAID",
      label: "Paid in full",
      detail: "No remaining balance is due for this registration.",
      totalCents,
      paidCents,
      refundedCents,
      amountDueCents: 0,
      paymentEligible: false,
    };
  }

  if (paidCents > 0) {
    return {
      currency: "USD",
      state: "PARTIALLY_PAID",
      label: "Partial payment received",
      detail: "A balance remains. Contact the event team for payment instructions.",
      totalCents,
      paidCents,
      refundedCents,
      amountDueCents: balanceCents,
      paymentEligible: activeForPayment,
    };
  }

  return {
    currency: "USD",
    state: "BALANCE_DUE",
    label: "Balance due",
    detail: "No successful payment is recorded. Contact the event team for payment instructions.",
    totalCents,
    paidCents,
    refundedCents,
    amountDueCents: balanceCents,
    paymentEligible: activeForPayment,
  };
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function publicContactFromSnapshot(
  snapshotValue: unknown,
  fallback: PublicContactUpdateInput,
): PublicContactUpdateInput {
  const snapshot = jsonRecord(snapshotValue);
  return {
    firstName: nonEmptyString(snapshot.firstName) ?? fallback.firstName,
    lastName: nonEmptyString(snapshot.lastName) ?? fallback.lastName,
    email: nonEmptyString(snapshot.email)?.toLowerCase() ?? fallback.email,
    phone: typeof snapshot.phone === "string"
      ? snapshot.phone.trim()
      : fallback.phone,
  };
}

export function publicAttendeeName(
  snapshotValue: unknown,
  fallback: { firstName: string; lastName: string },
) {
  const snapshot = jsonRecord(snapshotValue);
  const firstName = nonEmptyString(snapshot.firstName) ?? fallback.firstName;
  const lastName = nonEmptyString(snapshot.lastName) ?? fallback.lastName;
  return `${firstName} ${lastName}`.trim();
}
