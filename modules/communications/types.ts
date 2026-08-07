export type MessageTemplateKeyValue =
  | "REGISTRATION_CONFIRMATION_PAID"
  | "REGISTRATION_CONFIRMATION_UNPAID"
  | "REGISTRATION_CONFIRMATION_ORGANIZATION_BILLED"
  | "WORKER_CONFIRMATION"
  | "INTERNAL_NEW_REGISTRATION"
  | "WAITLIST_JOINED"
  | "WAITLIST_PROMOTED"
  | "WAITLIST_REMOVED"
  | "REGISTRATION_CANCELLED"
  | "REGISTRATION_REACTIVATED"
  | "REGISTRATION_CONTACT_UPDATED"
  | "REGISTRATION_UPDATED"
  | "PAYMENT_RECEIPT"
  | "REFUND_NOTICE"
  | "BALANCE_REMINDER"
  | "REGISTRATION_TRANSFERRED_NEW_CONTACT"
  | "REGISTRATION_TRANSFERRED_PRIOR_CONTACT"
  | "ATTENDEE_SUBSTITUTED"
  | "SHIRT_SIZE_REQUEST"
  | "REGISTRATION_ACCESS_RECOVERY"
  | "EVENT_ANNOUNCEMENT";

export type MessageOutboxStatusValue =
  | "PENDING"
  | "PROCESSING"
  | "CAPTURED"
  | "SENT"
  | "FAILED"
  | "SUPPRESSED"
  | "CANCELLED";

export type MessageTemplateVersionRecord = {
  id: string;
  versionNumber: number;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  subjectTemplate: string;
  bodyTemplate: string;
  publishedAt: string | null;
  createdAt: string;
  createdBy: string | null;
};

export type MessageTemplateRecord = {
  id: string;
  key: MessageTemplateKeyValue;
  name: string;
  description: string;
  isEnabled: boolean;
  activeVersion: MessageTemplateVersionRecord | null;
  versions: MessageTemplateVersionRecord[];
};

export type MessageAttemptRecord = {
  id: string;
  attemptNumber: number;
  provider: string;
  status: "CAPTURED" | "SENT" | "FAILED";
  providerMessageId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
};

export type MessageOutboxRecord = {
  id: string;
  templateKey: MessageTemplateKeyValue;
  recipientKind: "REGISTRANT" | "INTERNAL" | "TEST";
  recipientEmail: string;
  recipientName: string | null;
  senderName: string;
  senderEmail: string | null;
  replyToEmail: string | null;
  subject: string;
  bodyText: string;
  /**
   * The formatted body exactly as it was rendered at enqueue. Null on rows
   * captured before HTML bodies existed. The viewer shows this rather than
   * re-rendering `bodyText`, which would re-parse registrant values as Markdown
   * long after the safe render already happened.
   */
  bodyHtml: string | null;
  status: MessageOutboxStatusValue;
  attemptCount: number;
  capturedAt: string | null;
  sentAt: string | null;
  provider: string | null;
  providerMessageId: string | null;
  providerDeliveryStatus:
    | "ACCEPTED"
    | "SENT"
    | "DELIVERED"
    | "BOUNCED"
    | "FAILED"
    | "COMPLAINED"
    | "SUPPRESSED"
    | null;
  providerStatusAt: string | null;
  deliveredAt: string | null;
  failedAt: string | null;
  lastError: string | null;
  retryOfMessageId: string | null;
  retryRequestFingerprint: string;
  createdAt: string;
  registration: { id: string; confirmationCode: string } | null;
  templateVersion: { id: string; versionNumber: number } | null;
  attempts: MessageAttemptRecord[];
};

export type MessagingSettingsRecord = {
  deliveryMode: "DISABLED" | "LOCAL_CAPTURE" | "EXTERNAL_EMAIL";
  senderName: string;
  senderEmail: string;
  replyToEmail: string;
  internalNotificationEmails: string[];
  providerConfigured: boolean;
  webhookConfigured: boolean;
};

export type MessagingWorkspaceData = {
  settings: MessagingSettingsRecord;
  templates: MessageTemplateRecord[];
  messages: MessageOutboxRecord[];
  counts: Record<MessageOutboxStatusValue, number>;
  reminderPreview: BalanceReminderPreview;
  shirtSizePreview: ShirtSizeRequestPreview;
};

export type BalanceReminderSkipReasonCode =
  | "INACTIVE_REGISTRATION"
  | "NO_BALANCE_DUE"
  | "INVALID_CONTACT_EMAIL"
  | "ORGANIZATION_BILLED";

export type BalanceReminderRecipient = {
  registrationId: string;
  confirmationCode: string;
  recipientName: string;
  recipientEmail: string;
  totalCents: number;
  balanceCents: number;
};

export type BalanceReminderPreview = {
  fingerprint: string;
  generatedAt: string;
  includedCount: number;
  skippedCount: number;
  totalBalanceCents: number;
  deliveryMode: MessagingSettingsRecord["deliveryMode"];
  templateEnabled: boolean;
  templateVersionNumber: number | null;
  recipients: BalanceReminderRecipient[];
  skipReasons: Array<{
    code: BalanceReminderSkipReasonCode;
    label: string;
    count: number;
  }>;
};

export type ShirtSizeSkipReasonCode =
  | "INACTIVE_REGISTRATION"
  | "ALL_SIZES_RECORDED"
  | "NO_ATTENDEES"
  | "INVALID_CONTACT_EMAIL";

export type ShirtSizeRecipient = {
  registrationId: string;
  confirmationCode: string;
  recipientName: string;
  recipientEmail: string;
  missingAttendeeNames: string[];
  missingCount: number;
  attendeeCount: number;
};

export type ShirtSizeRequestPreview = {
  fingerprint: string;
  generatedAt: string;
  /**
   * False when the event does not collect shirts at all. The audience is then
   * empty by construction rather than by coincidence, and the workspace says
   * so instead of showing "everyone has answered".
   */
  eventSupportsShirtSizes: boolean;
  includedCount: number;
  skippedCount: number;
  missingAttendeeCount: number;
  deliveryMode: MessagingSettingsRecord["deliveryMode"];
  templateEnabled: boolean;
  templateVersionNumber: number | null;
  recipients: ShirtSizeRecipient[];
  skipReasons: Array<{
    code: ShirtSizeSkipReasonCode;
    label: string;
    count: number;
  }>;
};

export type AnnouncementRecord = {
  id: string;
  title: string;
  body: string;
  status: string;
  priority: string;
  publishedAt: string | null;
  updatedAt: string;
};

export type CommunicationsView =
  | "announcements"
  | "reminders"
  | "shirt-sizes"
  | "templates"
  | "deliveries"
  | "settings";
