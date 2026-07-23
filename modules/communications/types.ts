export type MessageTemplateKeyValue =
  | "REGISTRATION_CONFIRMATION_PAID"
  | "REGISTRATION_CONFIRMATION_UNPAID"
  | "WORKER_CONFIRMATION"
  | "INTERNAL_NEW_REGISTRATION"
  | "WAITLIST_JOINED"
  | "WAITLIST_PROMOTED"
  | "REGISTRATION_CANCELLED"
  | "REGISTRATION_CONTACT_UPDATED"
  | "PAYMENT_RECEIPT"
  | "BALANCE_REMINDER"
  | "REGISTRATION_TRANSFERRED_NEW_CONTACT"
  | "REGISTRATION_TRANSFERRED_PRIOR_CONTACT"
  | "ATTENDEE_SUBSTITUTED";

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
};

export type BalanceReminderSkipReasonCode =
  | "INACTIVE_REGISTRATION"
  | "NO_BALANCE_DUE"
  | "INVALID_CONTACT_EMAIL";

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
  | "templates"
  | "deliveries"
  | "settings";
