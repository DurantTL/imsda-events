import { z } from "zod";

export const manualPaymentSchema = z.object({
  amountCents: z.number().int().positive().max(10_000_000),
  method: z.enum(["CASH", "CHECK", "MANUAL"]),
  reference: z.string().trim().max(120).default(""),
});

export const refundInputSchema = z.object({
  amountCents: z.number().int().positive().max(10_000_000),
  reason: z.string().trim().min(3, "A refund reason is required.").max(300),
});

