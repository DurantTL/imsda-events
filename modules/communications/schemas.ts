import { z } from "zod";
import { validateMessageTemplate } from "@/modules/communications/templates";

const optionalEmail = z.string().trim().max(254).refine(
  (value) => value === "" || z.email().safeParse(value).success,
  "Enter a valid email address or leave this blank.",
);

export const messagingSettingsInputSchema = z.object({
  deliveryMode: z.enum(["DISABLED", "LOCAL_CAPTURE", "EXTERNAL_EMAIL"]),
  senderName: z.string().trim().min(2).max(120),
  senderEmail: optionalEmail,
  replyToEmail: optionalEmail,
  internalNotificationEmails: z.array(z.email().transform((value) => value.trim().toLowerCase())).max(20),
}).strict().superRefine((input, context) => {
  if (input.deliveryMode === "EXTERNAL_EMAIL" && !input.senderEmail) {
    context.addIssue({
      code: "custom",
      path: ["senderEmail"],
      message: "A verified sender email is required for real email delivery.",
    });
  }
}).transform((input) => ({
  ...input,
  internalNotificationEmails: [...new Set(input.internalNotificationEmails)],
}));

export const messageTemplateInputSchema = z.object({
  subjectTemplate: z.string().trim().min(1).max(180),
  bodyTemplate: z.string().trim().min(1).max(12_000),
  isEnabled: z.boolean(),
}).strict().superRefine((input, context) => {
  const validation = validateMessageTemplate({
    subject: input.subjectTemplate,
    body: input.bodyTemplate,
  });
  for (const issue of validation.issues) {
    context.addIssue({
      code: "custom",
      path: [issue.field === "subject" ? "subjectTemplate" : "bodyTemplate"],
      message: issue.message,
    });
  }
});

export const messageTestInputSchema = z.object({
  recipientEmail: z.email().transform((value) => value.trim().toLowerCase()),
  recipientName: z.string().trim().max(120).optional().default("Local test recipient"),
}).strict();

export const balanceReminderBatchInputSchema = z.object({
  previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  batchId: z.uuid(),
}).strict();

export const confirmationResendInputSchema = z.object({
  clientRequestId: z.uuid(),
  correctedRecipientEmail: z.union([
    z.literal(""),
    z.email().transform((value) => value.trim().toLowerCase()),
  ]).optional().default(""),
}).strict();

export const messageRetryInputSchema = z.object({
  clientRequestId: z.uuid(),
  requestFingerprint: z.string().regex(
    /^[a-f0-9]{64}$/,
    "The retry fingerprint is invalid. Refresh the delivery log and try again.",
  ),
}).strict();

export type MessagingSettingsInput = z.infer<typeof messagingSettingsInputSchema>;
export type MessageTemplateInput = z.infer<typeof messageTemplateInputSchema>;
export type MessageTestInput = z.infer<typeof messageTestInputSchema>;
export type BalanceReminderBatchInput = z.infer<
  typeof balanceReminderBatchInputSchema
>;
export type ConfirmationResendInput = z.infer<
  typeof confirmationResendInputSchema
>;
export type MessageRetryInput = z.infer<typeof messageRetryInputSchema>;
