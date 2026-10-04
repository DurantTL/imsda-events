import { z } from "zod";
import { REVISION_REASON_MAX } from "@/modules/invoices/domain";

const id = z.string().trim().min(1).max(64);

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
]);

export type InvoiceAction = z.infer<typeof invoiceActionSchema>;
