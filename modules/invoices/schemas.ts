import { z } from "zod";
import { REVISION_REASON_MAX } from "@/modules/invoices/domain";
import { parseMoneyToCents } from "@/modules/invoices/delivery-domain";
import { MANUAL_DESCRIPTION_MAX, MANUAL_ITEM_MAX } from "@/modules/invoices/manual-lines";

const id = z.string().trim().min(1).max(64);

/** "12.50", "$12.50" or "-5" (a credit) to signed cents. */
const signedMoney = z.string().trim().max(20).transform((value, context) => {
  const negative = value.startsWith("-");
  const cents = parseMoneyToCents(negative ? value.slice(1) : value);
  if (cents === null) {
    context.addIssue({ code: "custom", message: "Enter a rate in dollars and cents, like 4.50." });
    return z.NEVER;
  }
  return negative ? -cents : cents;
});

/** One endpoint, one tagged body. Every action needs MANAGE_FINANCE on the event in the URL; finalizing also needs Finalize invoices for anything that sets or changes an amount. */
export const invoiceActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create-drafts") }),
  z.object({ action: z.literal("regenerate"), invoiceId: id }),
  z.object({ action: z.literal("discard"), invoiceId: id }),
  z.object({
    action: z.literal("revise"),
    invoiceId: id,
    mode: z.enum(["CONTACT_ONLY", "FROM_RECONCILIATION"]),
    reason: z.string().trim().min(1, "Say why you are revising this invoice.").max(REVISION_REASON_MAX, `Keep the reason to ${REVISION_REASON_MAX} characters or fewer.`),
  }),
  z.object({
    action: z.literal("finalize"),
    versionId: id,
    /** Minted by the page when it renders and reused on a retry, so a retry returns the same number. */
    idempotencyKey: z.string().trim().min(16, "The request is missing its key. Reload the page.").max(100),
    confirm: z.literal(true, { message: "Confirm that you are finalizing this invoice." }),
  }),
  z.object({ action: z.literal("set-code"), code: z.string().trim().max(12).nullable() }),
  z.object({ action: z.literal("set-club-type"), clubType: z.string().max(100).nullable() }),
  /** A manual line on a draft (#780). Needs Finalize invoices for the event, like finalizing. */
  z.object({
    action: z.literal("add-manual-line"),
    invoiceId: id,
    item: z.string().max(MANUAL_ITEM_MAX * 2),
    description: z.string().max(MANUAL_DESCRIPTION_MAX * 2).nullable().optional(),
    quantity: z.number().int(),
    rate: signedMoney,
  }),
  z.object({ action: z.literal("remove-manual-line"), invoiceId: id, lineId: id }),
]);

export type InvoiceAction = z.infer<typeof invoiceActionSchema>;
