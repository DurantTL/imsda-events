import { z } from "zod";
import { PREHEADER_MAX_LENGTH } from "@/modules/communications/email-html";
import { validateMessageTemplate } from "@/modules/communications/templates";

const optionalEmail = z.string().trim().max(254).refine(
  (value) => value === "" || z.email().safeParse(value).success,
  "Enter a valid email address or leave this blank.",
);

/**
 * The event's own email settings (#1043): display name, reply-to and staff alert addresses. There is no delivery mode
 * and no sender email: the From address is the platform's central sender, and pausing is a system administrator's
 * action on System management > Email. `.strict()` rejects either if a client sends one.
 */
export const messagingSettingsInputSchema = z.object({
  senderName: z.string().trim().min(2).max(120),
  replyToEmail: optionalEmail,
  internalNotificationEmails: z.array(z.email().transform((value) => value.trim().toLowerCase())).max(20),
}).strict().transform((input) => ({
  ...input,
  internalNotificationEmails: [...new Set(input.internalNotificationEmails)],
}));

/** The inbox preview line (#836): one line of plain text, at most `PREHEADER_MAX_LENGTH` characters, or none. */
export const preheaderField = z.string().trim().max(PREHEADER_MAX_LENGTH).nullish()
  .transform((value) => (value ? value : null));

/**
 * An announcement's own inbox preview line (#836). Absent leaves what is saved alone; blank clears it. The same
 * one-line and token rules as a template's.
 */
export const announcementPreheaderField = z.string().trim().max(PREHEADER_MAX_LENGTH).nullish()
  .transform((value) => (value === undefined ? undefined : value || null))
  .superRefine((value, context) => {
    if (!value) return;
    const validation = validateMessageTemplate({ subject: "-", body: "-", preheader: value });
    for (const issue of validation.issues) {
      context.addIssue({ code: "custom", message: issue.message });
    }
  });

export const messageTemplateInputSchema = z.object({
  subjectTemplate: z.string().trim().min(1).max(180),
  bodyTemplate: z.string().trim().min(1).max(12_000),
  /** The inbox preview line (#836). Optional; a blank one is stored as none. */
  preheaderTemplate: preheaderField.optional(),
  isEnabled: z.boolean(),
  /**
   * The attachments the new version carries (#824). Omitted, the version carries the previous version's forward;
   * given, it is exactly this list, so removing an attachment is sending the list without it.
   */
  attachmentFileIds: z.array(z.string().trim().min(1).max(64)).max(10).optional(),
}).strict().superRefine((input, context) => {
  const validation = validateMessageTemplate({
    subject: input.subjectTemplate,
    body: input.bodyTemplate,
    preheader: input.preheaderTemplate,
  });
  for (const issue of validation.issues) {
    context.addIssue({
      code: "custom",
      path: [issue.field === "subject" ? "subjectTemplate" : issue.field === "preheader" ? "preheaderTemplate" : "bodyTemplate"],
      message: issue.message,
    });
  }
});

export const messageTestInputSchema = z.object({
  recipientEmail: z.email().transform((value) => value.trim().toLowerCase()),
  recipientName: z.string().trim().max(120).optional().default("Local test recipient"),
  /**
   * Deliver to the address for real, through the event's own sender, instead of
   * capturing locally. Defaults to false so the safe behaviour is the one a
   * caller gets by omission.
   */
  realDelivery: z.boolean().optional().default(false),
  /**
   * Render from this real registration instead of the sample context, which
   * also makes the private link in the message a working one. Blank keeps the
   * sample data and its placeholder link.
   */
  confirmationCode: z.string().trim().max(64).optional().default(""),
  /**
   * Required before a real registration's working private link may be mailed to
   * a chosen address. The link grants whoever holds it access to that
   * registration, so this is a deliberate acknowledgement rather than a default.
   */
  acknowledgeLinkExposure: z.boolean().optional().default(false),
}).strict().superRefine((input, context) => {
  if (input.confirmationCode && input.realDelivery && !input.acknowledgeLinkExposure) {
    context.addIssue({
      code: "custom",
      path: ["acknowledgeLinkExposure"],
      message: "Sending a real registration's private link to this address needs an explicit acknowledgement.",
    });
  }
});

export const balanceReminderBatchInputSchema = z.object({
  previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  batchId: z.uuid(),
}).strict();

export const shirtSizeRequestBatchInputSchema = z.object({
  previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  batchId: z.uuid(),
}).strict();

export const clubAssignmentBatchInputSchema = z.object({
  previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  batchId: z.uuid(),
  scope: z.enum(["ONE", "ALL_SET"]),
  organizationId: z.string().trim().min(1).max(64).optional(),
  /** Which of the club's teams (#809), when the club registered several. */
  teamKey: z.string().max(200).optional(),
}).strict().superRefine((value, context) => {
  if (value.scope === "ONE" && !value.organizationId) {
    context.addIssue({
      code: "custom",
      path: ["organizationId"],
      message: "Choose a club to send to.",
    });
  }
});

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

export const failedMessagesRetryScopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("EVENT") }).strict(),
  z.object({
    type: z.literal("BATCH"),
    batchId: z.string().trim().min(1).max(120),
  }).strict(),
]);

export const failedMessagesRetryInputSchema = z.object({
  clientRequestId: z.uuid(),
  scope: failedMessagesRetryScopeSchema,
  previewFingerprint: z.string().regex(
    /^[a-f0-9]{64}$/,
    "The retry preview is invalid. Preview the failed messages again.",
  ),
}).strict();

export type FailedMessagesRetryInput = z.infer<typeof failedMessagesRetryInputSchema>;
export type MessagingSettingsInput = z.infer<typeof messagingSettingsInputSchema>;
export type MessageTemplateInput = z.infer<typeof messageTemplateInputSchema>;
export type MessageTestInput = z.infer<typeof messageTestInputSchema>;
export type BalanceReminderBatchInput = z.infer<
  typeof balanceReminderBatchInputSchema
>;
export type ShirtSizeRequestBatchInput = z.infer<
  typeof shirtSizeRequestBatchInputSchema
>;
export type ConfirmationResendInput = z.infer<
  typeof confirmationResendInputSchema
>;
export type ClubAssignmentBatchInput = z.infer<
  typeof clubAssignmentBatchInputSchema
>;
export type MessageRetryInput = z.infer<typeof messageRetryInputSchema>;
