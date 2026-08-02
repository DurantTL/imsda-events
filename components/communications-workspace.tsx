"use client";

import { useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  Clock3,
  FileText,
  FlaskConical,
  Inbox,
  Mail,
  Megaphone,
  Plus,
  RefreshCw,
  Save,
  Send,
  Settings,
  Shirt,
  Users,
  WalletCards,
  X,
} from "lucide-react";
import { useAccessibleDialog } from "@/components/use-accessible-dialog";
import { MessageBodyEditor } from "@/components/message-body-editor";
import { useUnsavedChangesGuard } from "@/components/use-unsaved-changes-guard";
import { messageRetryRequestPayload } from "@/modules/communications/message-retry-client";
import { renderEmailHtmlDocument } from "@/modules/communications/email-html";
import {
  REGISTRATION_MANAGE_API_SENTINEL,
  REGISTRATION_MANAGE_LINK_SENTINEL,
} from "@/modules/communications/manage-link";
import {
  MESSAGE_TEMPLATE_TOKEN_KEYS,
  renderMessageTemplate,
  SAMPLE_MESSAGE_TEMPLATE_CONTEXT,
} from "@/modules/communications/templates";
import type {
  AnnouncementRecord,
  BalanceReminderPreview,
  CommunicationsView,
  MessageOutboxRecord,
  MessageOutboxStatusValue,
  MessagingWorkspaceData,
  ShirtSizeRequestPreview,
} from "@/modules/communications/types";

type CommunicationsWorkspaceProps = {
  eventId: string;
  eventName: string;
  initialAnnouncements: AnnouncementRecord[];
  initialMessaging: MessagingWorkspaceData | null;
  canManage: boolean;
  initialView: CommunicationsView;
  openNew?: boolean;
};

type ApiResult = {
  messaging?: MessagingWorkspaceData;
  announcement?: AnnouncementRecord;
  reminderPreview?: BalanceReminderPreview;
  shirtSizePreview?: ShirtSizeRequestPreview;
  operation?: {
    batchId?: string;
    messageId?: string;
    includedCount?: number;
    queuedCount?: number;
    capturedCount?: number;
    suppressedCount?: number;
    deliveryMode?: MessagingWorkspaceData["settings"]["deliveryMode"];
    replayed?: boolean;
  };
  messageCount?: number;
  skippedCount?: number;
  deliveryMode?: MessagingWorkspaceData["settings"]["deliveryMode"];
  error?: string;
  message?: string;
  issues?: Array<{ message?: string }>;
};

type MessagingSettingsDraft = {
  deliveryMode: MessagingWorkspaceData["settings"]["deliveryMode"];
  senderName: string;
  senderEmail: string;
  replyToEmail: string;
  internalNotificationEmails: string;
};

function settingsDraftFromMessaging(
  messaging: MessagingWorkspaceData | null,
): MessagingSettingsDraft {
  return {
    deliveryMode: messaging?.settings.deliveryMode ?? "LOCAL_CAPTURE",
    senderName: messaging?.settings.senderName ?? "IMSDA Events",
    senderEmail: messaging?.settings.senderEmail ?? "",
    replyToEmail: messaging?.settings.replyToEmail ?? "",
    internalNotificationEmails:
      messaging?.settings.internalNotificationEmails.join("\n") ?? "",
  };
}

/**
 * Preview values come from the one sample context the server also uses, rather
 * than a second copy maintained here. The copies drifted: the preview paired
 * one event's dates and venue with another event's lodging, which is exactly
 * the kind of mismatch a preview exists to rule out.
 */
const templateTokenKeys: readonly string[] = MESSAGE_TEMPLATE_TOKEN_KEYS;

/**
 * A preview has no registration and mints no private token, so the delivery
 * sentinels stand in for one. Both stand-ins are valid absolute URLs: a
 * template writes its portal link as `[text]({{portal_url}})`, and a bracketed
 * note in that position renders as broken markup rather than a button.
 */
const PREVIEW_MANAGE_URL = "https://events.imsda.org/manage/preview-link-not-live";
const PREVIEW_MANAGE_API_URL = "https://events.imsda.org/api/public/manage/preview-link-not-live";

function withPreviewLinks(value: string) {
  return value
    .replaceAll(REGISTRATION_MANAGE_API_SENTINEL, PREVIEW_MANAGE_API_URL)
    .replaceAll(REGISTRATION_MANAGE_LINK_SENTINEL, PREVIEW_MANAGE_URL);
}
const deliveryFilters: Array<"ALL" | MessageOutboxStatusValue> = [
  "ALL",
  "PENDING",
  "CAPTURED",
  "FAILED",
  "SUPPRESSED",
  "SENT",
  "CANCELLED",
];

const templateLabels: Record<string, string> = {
  REGISTRATION_CONFIRMATION_PAID: "Paid / no balance",
  REGISTRATION_CONFIRMATION_UNPAID: "Balance due",
  WORKER_CONFIRMATION: "Worker confirmation",
  INTERNAL_NEW_REGISTRATION: "Internal notice",
  WAITLIST_JOINED: "Waitlist joined",
  WAITLIST_PROMOTED: "Waitlist promoted",
  REGISTRATION_CANCELLED: "Registration cancelled",
  REGISTRATION_CONTACT_UPDATED: "Contact updated",
  PAYMENT_RECEIPT: "Payment receipt",
  BALANCE_REMINDER: "Balance reminder",
  REGISTRATION_TRANSFERRED_NEW_CONTACT: "Transfer · new contact",
  REGISTRATION_TRANSFERRED_PRIOR_CONTACT: "Transfer · prior contact",
  ATTENDEE_SUBSTITUTED: "Attendee substituted",
  EVENT_ANNOUNCEMENT: "Event announcement",
};

/**
 * Render a preview through the very same pipeline delivery uses, rather than a
 * second substitution written for the preview alone. That is what makes the
 * preview trustworthy: a token value that would be Markdown-escaped in a real
 * send is escaped here too, so staff never see formatting the real message
 * cannot produce.
 */
function renderPreview(subject: string, body: string, eventName: string) {
  const rendered = renderMessageTemplate(
    { subject, body },
    { ...SAMPLE_MESSAGE_TEMPLATE_CONTEXT, event_name: eventName },
  );
  return {
    subject: withPreviewLinks(rendered.subject),
    body: withPreviewLinks(rendered.body),
    bodyHtml: withPreviewLinks(rendered.bodyHtml),
  };
}

function statusTone(status: MessageOutboxStatusValue) {
  if (status === "CAPTURED" || status === "SENT") return "green";
  if (status === "PENDING" || status === "PROCESSING") return "gold";
  if (status === "FAILED" || status === "CANCELLED") return "coral";
  return "purple";
}

function messageTypeLabel(message: Pick<MessageOutboxRecord, "templateKey" | "recipientKind">) {
  if (message.recipientKind === "TEST") return `Test · ${templateLabels[message.templateKey]}`;
  return templateLabels[message.templateKey] ?? message.templateKey.toLowerCase().replaceAll("_", " ");
}

function friendlyStatus(status: string) {
  return status.toLowerCase().replaceAll("_", " ");
}

function localDate(value: string | null) {
  return value ? new Date(value).toLocaleString() : "Not recorded";
}

function money(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value / 100);
}

const confirmationTemplateKeys = new Set([
  "REGISTRATION_CONFIRMATION_PAID",
  "REGISTRATION_CONFIRMATION_UNPAID",
  "WORKER_CONFIRMATION",
]);

function canResendConfirmation(message: MessageOutboxRecord | null) {
  return Boolean(
    message
    && message.recipientKind === "REGISTRANT"
    && message.registration
    && message.retryOfMessageId === null
    && confirmationTemplateKeys.has(message.templateKey)
    && message.status !== "PENDING"
    && message.status !== "PROCESSING",
  );
}

export function CommunicationsWorkspace({
  eventId,
  eventName,
  initialAnnouncements,
  initialMessaging,
  canManage,
  initialView,
  openNew = false,
}: CommunicationsWorkspaceProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [view, setView] = useState<CommunicationsView>(canManage ? initialView : "announcements");
  const [announcements, setAnnouncements] = useState(initialAnnouncements);
  const [messaging, setMessaging] = useState(initialMessaging);
  const [draftOpen, setDraftOpen] = useState(openNew && canManage);
  const draftDialogRef = useAccessibleDialog<HTMLElement>(
    draftOpen,
    () => {
      if (!saving) setDraftOpen(false);
    },
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const requestedTemplateId = searchParams.get("template");
  const requestedMessageId = searchParams.get("message");
  const [selectedTemplateId, setSelectedTemplateId] = useState(
    messaging?.templates.some((template) => template.id === requestedTemplateId)
      ? requestedTemplateId!
      : messaging?.templates[0]?.id ?? "",
  );
  const [selectedMessageId, setSelectedMessageId] = useState(
    messaging?.messages.some((message) => message.id === requestedMessageId)
      ? requestedMessageId!
      : messaging?.messages[0]?.id ?? "",
  );
  const [deliveryFilter, setDeliveryFilter] = useState<"ALL" | MessageOutboxStatusValue>(
    deliveryFilters.includes(searchParams.get("status") as "ALL" | MessageOutboxStatusValue)
      ? searchParams.get("status") as "ALL" | MessageOutboxStatusValue
      : "ALL",
  );
  const selectedTemplate = messaging?.templates.find((template) => template.id === selectedTemplateId)
    ?? messaging?.templates[0]
    ?? null;
  const selectedMessage = messaging?.messages.find((message) => message.id === selectedMessageId)
    ?? null;
  const selectedMessageNeedsSenderRepair = Boolean(
    selectedMessage
    && messaging?.settings.deliveryMode === "EXTERNAL_EMAIL"
    && selectedMessage.status === "FAILED"
    && !selectedMessage.senderEmail?.trim(),
  );
  const senderRepairReady = Boolean(
    selectedMessageNeedsSenderRepair
    && messaging?.settings.senderEmail.trim(),
  );
  const [templateSubject, setTemplateSubject] = useState(selectedTemplate?.activeVersion?.subjectTemplate ?? "");
  const [templateBody, setTemplateBody] = useState(selectedTemplate?.activeVersion?.bodyTemplate ?? "");
  const [templateEnabled, setTemplateEnabled] = useState(selectedTemplate?.isEnabled ?? true);
  const [settingsDraft, setSettingsDraft] = useState<MessagingSettingsDraft>(
    () => settingsDraftFromMessaging(messaging),
  );
  const [reminderConfirmed, setReminderConfirmed] = useState(false);
  const [reminderBatchId, setReminderBatchId] = useState("");
  const [shirtSizeConfirmed, setShirtSizeConfirmed] = useState(false);
  const [shirtSizeBatchId, setShirtSizeBatchId] = useState("");
  const [testRealDelivery, setTestRealDelivery] = useState(false);
  const [testConfirmationCode, setTestConfirmationCode] = useState("");
  const [testAcknowledgeExposure, setTestAcknowledgeExposure] = useState(false);
  const [resendRecipientEmail, setResendRecipientEmail] = useState("");
  const [resendConfirmed, setResendConfirmed] = useState(false);
  const [resendRequestId, setResendRequestId] = useState("");
  const [retryRequestId, setRetryRequestId] = useState("");

  const preview = useMemo(
    () => renderPreview(templateSubject, templateBody, eventName),
    [templateSubject, templateBody, eventName],
  );

  const templateDirty = Boolean(selectedTemplate && (
    templateSubject !== (selectedTemplate.activeVersion?.subjectTemplate ?? "")
    || templateBody !== (selectedTemplate.activeVersion?.bodyTemplate ?? "")
    || templateEnabled !== selectedTemplate.isEnabled
  ));
  const savedSettingsDraft = settingsDraftFromMessaging(messaging);
  const settingsDirty = JSON.stringify(settingsDraft) !== JSON.stringify(savedSettingsDraft);
  const reminderDirty = reminderConfirmed;
  const shirtSizeDirty = shirtSizeConfirmed;
  const resendDirty = resendConfirmed || resendRecipientEmail.trim().length > 0;
  const hasUnsavedChanges = templateDirty
    || settingsDirty
    || reminderDirty
    || shirtSizeDirty
    || resendDirty;
  useUnsavedChangesGuard(
    hasUnsavedChanges,
    "These communication changes have not been published or saved. Leave and discard them?",
  );

  const filteredMessages = useMemo(
    () => (messaging?.messages ?? []).filter((message) => deliveryFilter === "ALL" || message.status === deliveryFilter),
    [deliveryFilter, messaging?.messages],
  );

  function setQuery(nextView: CommunicationsView, resource?: { template?: string; message?: string; status?: string }) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("view", nextView);
    for (const key of ["template", "version", "message", "status", "new"]) params.delete(key);
    if (resource?.template) params.set("template", resource.template);
    if (resource?.message) params.set("message", resource.message);
    if (resource?.status && resource.status !== "ALL") params.set("status", resource.status);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  function resetEditorDrafts() {
    setTemplateSubject(selectedTemplate?.activeVersion?.subjectTemplate ?? "");
    setTemplateBody(selectedTemplate?.activeVersion?.bodyTemplate ?? "");
    setTemplateEnabled(selectedTemplate?.isEnabled ?? true);
    setSettingsDraft(settingsDraftFromMessaging(messaging));
    setReminderConfirmed(false);
    setReminderBatchId("");
    setShirtSizeConfirmed(false);
    setShirtSizeBatchId("");
    setTestAcknowledgeExposure(false);
    setResendRecipientEmail("");
    setResendConfirmed(false);
    setResendRequestId("");
    setRetryRequestId("");
  }

  function confirmDiscardEditorChanges() {
    if (!hasUnsavedChanges) return true;
    if (!window.confirm("Discard the unpublished communication changes?")) return false;
    resetEditorDrafts();
    return true;
  }

  function changeView(nextView: CommunicationsView) {
    if (nextView === view) return;
    if (!confirmDiscardEditorChanges()) return;
    setError("");
    setNotice("");
    setView(nextView);
    setQuery(nextView);
  }

  async function messagingRequest(url: string, init: RequestInit, successMessage: string) {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(url, init);
      const result = await response.json().catch(() => ({})) as ApiResult;
      if (!response.ok || !result.messaging) {
        throw new Error(result.message ?? result.issues?.[0]?.message ?? "The communication request could not be completed.");
      }
      setMessaging(result.messaging);
      setNotice(successMessage);
      return result.messaging;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The communication request could not be completed.");
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function createDraft(submitEvent: React.FormEvent<HTMLFormElement>) {
    submitEvent.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    const form = new FormData(submitEvent.currentTarget);
    try {
      const response = await fetch(`/api/events/${eventId}/announcements`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: form.get("title"),
          body: form.get("body"),
          priority: form.get("priority"),
        }),
      });
      const result = await response.json().catch(() => ({})) as ApiResult;
      if (!response.ok || !result.announcement) {
        throw new Error(result.message ?? result.issues?.[0]?.message ?? "Unable to create the draft.");
      }
      setAnnouncements((current) => [result.announcement!, ...current]);
      setDraftOpen(false);
      setNotice("Announcement draft created.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to create the draft.");
    } finally {
      setSaving(false);
    }
  }

  async function publishAnnouncement(id: string) {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/events/${eventId}/announcements/${id}`, { method: "PATCH" });
      const result = await response.json().catch(() => ({})) as ApiResult;
      if (!response.ok || !result.announcement) throw new Error(result.message ?? "Unable to publish the announcement.");
      setAnnouncements((current) => current.map((row) => row.id === id
        ? { ...row, status: "PUBLISHED", publishedAt: result.announcement!.publishedAt }
        : row));
      setNotice("Announcement published to the local event feed.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to publish the announcement.");
    } finally {
      setSaving(false);
    }
  }

  async function broadcastAnnouncement(announcement: AnnouncementRecord) {
    const recipientMode = messaging?.settings.deliveryMode === "EXTERNAL_EMAIL"
      ? "send a real email"
      : messaging?.settings.deliveryMode === "LOCAL_CAPTURE"
        ? "create a local preview"
        : "record a suppressed delivery";
    if (!window.confirm(
      `This will ${recipientMode} for every active registration contact using the current event email template. Continue?`,
    )) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(
        `/api/events/${eventId}/announcements/${announcement.id}/broadcast`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ batchId: crypto.randomUUID() }),
        },
      );
      const result = await response.json().catch(() => ({})) as ApiResult;
      if (!response.ok || typeof result.messageCount !== "number") {
        throw new Error(result.message ?? "Unable to prepare the announcement email.");
      }
      const skipped = result.skippedCount
        ? ` ${result.skippedCount} registration${result.skippedCount === 1 ? " was" : "s were"} skipped.`
        : "";
      if (result.deliveryMode === "EXTERNAL_EMAIL") {
        setNotice(`${result.messageCount} announcement email${result.messageCount === 1 ? " was" : "s were"} processed.${skipped}`);
      } else if (result.deliveryMode === "LOCAL_CAPTURE") {
        setNotice(`${result.messageCount} announcement preview${result.messageCount === 1 ? " was" : "s were"} captured locally; no email was sent.${skipped}`);
      } else {
        setNotice(`${result.messageCount} announcement delivery row${result.messageCount === 1 ? " was" : "s were"} recorded as suppressed; delivery is off.${skipped}`);
      }
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to prepare the announcement email.");
    } finally {
      setSaving(false);
    }
  }

  async function publishTemplate(submitEvent: React.FormEvent<HTMLFormElement>) {
    submitEvent.preventDefault();
    if (!selectedTemplate) return;
    const updated = await messagingRequest(
      `/api/events/${eventId}/message-templates/${selectedTemplate.id}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subjectTemplate: templateSubject,
          bodyTemplate: templateBody,
          isEnabled: templateEnabled,
        }),
      },
      "A new immutable template version was published for future messages.",
    );
    if (updated) {
      const refreshed = updated.templates.find((template) => template.id === selectedTemplate.id);
      if (refreshed) {
        setSelectedTemplateId(refreshed.id);
        setTemplateSubject(refreshed.activeVersion?.subjectTemplate ?? "");
        setTemplateBody(refreshed.activeVersion?.bodyTemplate ?? "");
        setTemplateEnabled(refreshed.isEnabled);
      }
    }
  }

  async function createTestCapture(submitEvent: React.FormEvent<HTMLFormElement>) {
    submitEvent.preventDefault();
    if (!selectedTemplate) return;
    const form = new FormData(submitEvent.currentTarget);
    const updated = await messagingRequest(
      `/api/events/${eventId}/message-templates/${selectedTemplate.id}/test`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipientEmail: form.get("recipientEmail"),
          recipientName: form.get("recipientName"),
          realDelivery: testRealDelivery,
          confirmationCode: testConfirmationCode.trim(),
          acknowledgeLinkExposure: testAcknowledgeExposure,
        }),
      },
      testRealDelivery
        ? `A real test message was sent to ${form.get("recipientEmail")} from this event's sender. Check the Delivery log for the provider result.`
        : "The test message was captured locally. No email was sent.",
    );
    setTestAcknowledgeExposure(false);
    if (updated?.messages[0]) setSelectedMessageId(updated.messages[0].id);
  }

  async function saveSettings(submitEvent: React.FormEvent<HTMLFormElement>) {
    submitEvent.preventDefault();
    const recipients = settingsDraft.internalNotificationEmails
      .split(/[\n,;]+/)
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean);
    const updated = await messagingRequest(
      `/api/events/${eventId}/messaging-settings`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deliveryMode: settingsDraft.deliveryMode,
          senderName: settingsDraft.senderName,
          senderEmail: settingsDraft.senderEmail,
          replyToEmail: settingsDraft.replyToEmail,
          internalNotificationEmails: recipients,
        }),
      },
      "Message settings saved.",
    );
    if (updated) setSettingsDraft(settingsDraftFromMessaging(updated));
  }

  async function processQueue() {
    await messagingRequest(
      `/api/events/${eventId}/messages/process`,
      { method: "POST" },
      messaging?.settings.deliveryMode === "EXTERNAL_EMAIL"
        ? "The available email queue was processed. Delivery status will continue updating from Resend."
        : "All available queued messages were processed into local previews.",
    );
  }

  async function retryMessage() {
    if (!selectedMessage) return;
    const clientRequestId = retryRequestId || crypto.randomUUID();
    setRetryRequestId(clientRequestId);
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(
        `/api/events/${eventId}/messages/${selectedMessage.id}/retry`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(messageRetryRequestPayload(
            selectedMessage,
            clientRequestId,
          )),
        },
      );
      const result = await response.json().catch(() => ({})) as ApiResult;
      if (!response.ok || !result.messaging || !result.operation?.messageId) {
        throw new Error(
          result.message
          ?? result.issues?.[0]?.message
          ?? "The message retry could not be completed.",
        );
      }
      setMessaging(result.messaging);
      setSelectedMessageId(result.operation.messageId);
      setQuery("deliveries", {
        message: result.operation.messageId,
        status: deliveryFilter,
      });
      setRetryRequestId("");
      setNotice(result.operation.replayed
        ? "This exact retry was already recorded, so no duplicate delivery copy was created."
        : messaging?.settings.deliveryMode === "EXTERNAL_EMAIL"
          ? "A new audited retry was processed through the email provider."
          : "A new audited copy was captured locally. No email was sent.");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The message retry could not be completed.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function refreshReminderPreview() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/events/${eventId}/balance-reminders`);
      const result = await response.json().catch(() => ({})) as ApiResult;
      if (!response.ok || !result.reminderPreview) {
        throw new Error(result.message ?? "The reminder preview could not be refreshed.");
      }
      setMessaging((current) => current
        ? { ...current, reminderPreview: result.reminderPreview! }
        : current);
      setReminderConfirmed(false);
      setReminderBatchId("");
      setNotice("The reminder audience was recalculated from current registrations and payments.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The reminder preview could not be refreshed.");
    } finally {
      setSaving(false);
    }
  }

  async function refreshShirtSizePreview() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/events/${eventId}/shirt-size-requests`);
      const result = await response.json().catch(() => ({})) as ApiResult;
      if (!response.ok || !result.shirtSizePreview) {
        throw new Error(result.message ?? "The shirt-size preview could not be refreshed.");
      }
      setMessaging((current) => current
        ? { ...current, shirtSizePreview: result.shirtSizePreview! }
        : current);
      setShirtSizeConfirmed(false);
      setShirtSizeBatchId("");
      setNotice("The shirt-size audience was recalculated from current attendee answers.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The shirt-size preview could not be refreshed.");
    } finally {
      setSaving(false);
    }
  }

  async function createShirtSizeBatch(submitEvent: React.FormEvent<HTMLFormElement>) {
    submitEvent.preventDefault();
    if (!messaging || !shirtSizeConfirmed) return;
    const clientBatchId = shirtSizeBatchId || crypto.randomUUID();
    setShirtSizeBatchId(clientBatchId);
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/events/${eventId}/shirt-size-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          previewFingerprint: messaging.shirtSizePreview.fingerprint,
          batchId: clientBatchId,
        }),
      });
      const result = await response.json().catch(() => ({})) as ApiResult;
      if (!response.ok || !result.messaging || !result.operation) {
        if (result.shirtSizePreview) {
          setMessaging((current) => current
            ? { ...current, shirtSizePreview: result.shirtSizePreview! }
            : current);
          setShirtSizeConfirmed(false);
          setShirtSizeBatchId("");
        }
        throw new Error(result.message ?? "The shirt-size request batch could not be created.");
      }
      setMessaging(result.messaging);
      setShirtSizeConfirmed(false);
      setShirtSizeBatchId("");
      if (result.operation.replayed) {
        setNotice("This exact batch was already recorded, so no duplicate messages were created.");
      } else if (result.operation.deliveryMode === "EXTERNAL_EMAIL") {
        setNotice(`${result.operation.queuedCount ?? 0} shirt-size request${result.operation.queuedCount === 1 ? " is" : "s are"} queued but not sent. Review the Delivery log, then use Process email queue when ready.`);
      } else if (result.operation.deliveryMode === "LOCAL_CAPTURE") {
        setNotice(`${result.operation.capturedCount ?? 0} shirt-size request${result.operation.capturedCount === 1 ? " was" : "s were"} captured locally. No email was sent.`);
      } else {
        setNotice(`${result.operation.suppressedCount ?? 0} shirt-size request row${result.operation.suppressedCount === 1 ? " was" : "s were"} recorded as suppressed. Delivery is off, so no email was sent.`);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The shirt-size request batch could not be created.");
    } finally {
      setSaving(false);
    }
  }

  async function createReminderBatch(submitEvent: React.FormEvent<HTMLFormElement>) {
    submitEvent.preventDefault();
    if (!messaging || !reminderConfirmed) return;
    const clientBatchId = reminderBatchId || crypto.randomUUID();
    setReminderBatchId(clientBatchId);
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/events/${eventId}/balance-reminders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          previewFingerprint: messaging.reminderPreview.fingerprint,
          batchId: clientBatchId,
        }),
      });
      const result = await response.json().catch(() => ({})) as ApiResult;
      if (!response.ok || !result.messaging || !result.operation) {
        if (result.reminderPreview) {
          setMessaging((current) => current
            ? { ...current, reminderPreview: result.reminderPreview! }
            : current);
          setReminderConfirmed(false);
          setReminderBatchId("");
        }
        throw new Error(result.message ?? "The reminder batch could not be created.");
      }
      setMessaging(result.messaging);
      setReminderConfirmed(false);
      setReminderBatchId("");
      if (result.operation.replayed) {
        setNotice("This exact batch was already recorded, so no duplicate messages were created.");
      } else if (result.operation.deliveryMode === "EXTERNAL_EMAIL") {
        setNotice(`${result.operation.queuedCount ?? 0} reminder email${result.operation.queuedCount === 1 ? " is" : "s are"} queued but not sent. Review the Delivery log, then use Process email queue when ready.`);
      } else if (result.operation.deliveryMode === "LOCAL_CAPTURE") {
        setNotice(`${result.operation.capturedCount ?? 0} reminder preview${result.operation.capturedCount === 1 ? " was" : "s were"} captured locally. No email was sent.`);
      } else {
        setNotice(`${result.operation.suppressedCount ?? 0} reminder row${result.operation.suppressedCount === 1 ? " was" : "s were"} recorded as suppressed. Delivery is off, so no email was sent.`);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The reminder batch could not be created.");
    } finally {
      setSaving(false);
    }
  }

  async function resendConfirmation(submitEvent: React.FormEvent<HTMLFormElement>) {
    submitEvent.preventDefault();
    if (!selectedMessage || !resendConfirmed || !canResendConfirmation(selectedMessage)) return;
    const clientRequestId = resendRequestId || crypto.randomUUID();
    setResendRequestId(clientRequestId);
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(
        `/api/events/${eventId}/messages/${selectedMessage.id}/resend-confirmation`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            clientRequestId,
            correctedRecipientEmail: resendRecipientEmail.trim(),
          }),
        },
      );
      const result = await response.json().catch(() => ({})) as ApiResult;
      if (!response.ok || !result.messaging || !result.operation?.messageId) {
        throw new Error(result.message ?? "The confirmation copy could not be created.");
      }
      setMessaging(result.messaging);
      setSelectedMessageId(result.operation.messageId);
      setQuery("deliveries", {
        message: result.operation.messageId,
        status: deliveryFilter,
      });
      setResendRecipientEmail("");
      setResendConfirmed(false);
      setResendRequestId("");
      if (result.operation.replayed) {
        setNotice("This confirmation action was already recorded, so no duplicate copy was created.");
      } else if (result.operation.deliveryMode === "EXTERNAL_EMAIL") {
        setNotice("The confirmation copy is queued but has not been sent. Use Process email queue when you are ready to send it.");
      } else if (result.operation.deliveryMode === "LOCAL_CAPTURE") {
        setNotice("The confirmation copy was captured locally. No email was sent and the registration contact was not changed.");
      } else {
        setNotice("The confirmation copy was recorded as suppressed. Delivery is off, so no email was sent.");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The confirmation copy could not be created.");
    } finally {
      setSaving(false);
    }
  }

  function selectTemplate(id: string) {
    if (id === selectedTemplate?.id) return;
    if (!confirmDiscardEditorChanges()) return;
    const template = messaging?.templates.find((candidate) => candidate.id === id);
    setSelectedTemplateId(id);
    setTemplateSubject(template?.activeVersion?.subjectTemplate ?? "");
    setTemplateBody(template?.activeVersion?.bodyTemplate ?? "");
    setTemplateEnabled(template?.isEnabled ?? true);
    setQuery("templates", { template: id });
  }

  function selectMessage(id: string) {
    if (id === selectedMessage?.id) return;
    if (!confirmDiscardEditorChanges()) return;
    setSelectedMessageId(id);
    setResendRecipientEmail("");
    setResendConfirmed(false);
    setResendRequestId("");
    setRetryRequestId("");
    setQuery("deliveries", { message: id, status: deliveryFilter });
  }

  function chooseDeliveryFilter(filter: "ALL" | MessageOutboxStatusValue) {
    if (filter === deliveryFilter) return;
    if (!confirmDiscardEditorChanges()) return;
    setDeliveryFilter(filter);
    setQuery("deliveries", { message: selectedMessageId, status: filter });
  }

  const tabs: Array<{ id: CommunicationsView; label: string; icon: typeof Mail }> = [
    { id: "announcements", label: "Announcements", icon: Megaphone },
    { id: "reminders", label: "Balance reminders", icon: Bell },
    { id: "shirt-sizes", label: "Shirt sizes", icon: Shirt },
    { id: "templates", label: "Message templates", icon: FileText },
    { id: "deliveries", label: "Delivery log", icon: Inbox },
    { id: "settings", label: "Settings", icon: Settings },
  ];

  return (
    <section className="page-stack communications-workspace">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Event communications</p>
          <h2>Messages & announcements</h2>
          <p>Manage attendee updates, registration confirmations, and delivery history for {eventName}.</p>
        </div>
        {canManage && view === "announcements" && (
          <button className="primary-button" type="button" onClick={() => { setError(""); setNotice(""); setDraftOpen(true); }}>
            <Plus aria-hidden="true" size={17} /> New announcement
          </button>
        )}
      </div>

      {canManage && (
        <nav className="communications-tabs" aria-label="Communication tools" role="tablist">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              aria-current={view === id ? "page" : undefined}
              aria-selected={view === id}
              className={view === id ? "active" : ""}
              role="tab"
              type="button"
              onClick={() => changeView(id)}
              key={id}
            >
              <Icon aria-hidden="true" size={17} /> {label}
              {id === "deliveries" && messaging && <span>{messaging.messages.length}</span>}
            </button>
          ))}
        </nav>
      )}

      {error && <div className="inline-notice error" role="alert"><AlertTriangle size={17} aria-hidden="true" /> {error}</div>}
      {notice && <div className="inline-notice success" role="status"><CheckCircle2 size={17} aria-hidden="true" /> {notice}</div>}

      {view === "announcements" && (
        <div className="communications-grid">
          <section className="announcement-list">
            {announcements.map((announcement) => (
              <article className={`announcement-card ${announcement.status === "PUBLISHED" ? "published" : "draft"}`} key={announcement.id}>
                <div className="announcement-head">
                  <span className="announcement-icon"><Megaphone aria-hidden="true" size={18} /></span>
                  <span className={`status-chip ${announcement.status === "PUBLISHED" ? "green" : "gold"}`}>{friendlyStatus(announcement.status)}</span>
                </div>
                <h3>{announcement.title}</h3>
                <p>{announcement.body}</p>
                <footer>
                  <span>All attendees · {friendlyStatus(announcement.priority)}</span>
                  <span>{announcement.publishedAt ? new Date(announcement.publishedAt).toLocaleDateString() : "Not published"}</span>
                </footer>
                {canManage && announcement.status === "DRAFT" && (
                  <button className="secondary-button publish-button" type="button" disabled={saving} onClick={() => publishAnnouncement(announcement.id)}>
                    <Send aria-hidden="true" size={16} /> Publish to event feed
                  </button>
                )}
                {canManage && announcement.status === "PUBLISHED" && (
                  <button className="secondary-button publish-button" type="button" disabled={saving} onClick={() => broadcastAnnouncement(announcement)}>
                    <Mail aria-hidden="true" size={16} /> Email active registrations
                  </button>
                )}
              </article>
            ))}
            {announcements.length === 0 && (
              <div className="empty-state panel"><Megaphone aria-hidden="true" size={24} /><h3>No announcements yet</h3><p>Create a draft when attendees need an event-feed update.</p></div>
            )}
          </section>
          <aside className="panel audience-panel">
            <span className="announcement-icon purple"><Send aria-hidden="true" size={20} /></span>
            <p className="eyebrow">Feed & email</p>
            <h2>Publish first, email deliberately</h2>
            <p>Publishing updates the event page and attendee hub. A separate confirmed action emails active registration contacts using the event’s current delivery settings.</p>
            <ul><li>Staff-reviewed drafts</li><li>No automatic email on publish</li><li>Audited, event-scoped broadcasts</li></ul>
          </aside>
        </div>
      )}

      {view === "reminders" && messaging && (
        <div className="reminder-workspace" role="tabpanel" aria-label="Balance reminders">
          <section className="panel reminder-preview-panel">
            <div className="message-delivery-toolbar">
              <div>
                <p className="eyebrow">Step 1 · review only</p>
                <h2>Review the current balance audience</h2>
                <p>
                  This preview does not create or send anything. It includes only submitted or confirmed registrations with a server-calculated balance above $0 and a valid contact email.
                </p>
              </div>
              <button className="secondary-button" type="button" onClick={refreshReminderPreview} disabled={saving}>
                <RefreshCw className={saving ? "spin" : ""} size={16} aria-hidden="true" />
                Refresh preview
              </button>
            </div>

            <div className="reminder-summary" aria-label="Reminder audience summary">
              <article>
                <span className="message-stat-icon green"><Users size={18} aria-hidden="true" /></span>
                <small>Included recipients</small>
                <strong>{messaging.reminderPreview.includedCount}</strong>
              </article>
              <article>
                <span className="message-stat-icon gold"><WalletCards size={18} aria-hidden="true" /></span>
                <small>Total balance</small>
                <strong>{money(messaging.reminderPreview.totalBalanceCents)}</strong>
              </article>
              <article>
                <span className="message-stat-icon purple"><AlertTriangle size={18} aria-hidden="true" /></span>
                <small>Skipped registrations</small>
                <strong>{messaging.reminderPreview.skippedCount}</strong>
              </article>
            </div>

            <div className="reminder-skip-reasons">
              <div>
                <p className="eyebrow">Why registrations were skipped</p>
                <ul>
                  {messaging.reminderPreview.skipReasons.map((reason) => (
                    <li key={reason.code}>
                      <span>{reason.label}</span>
                      <strong>{reason.count}</strong>
                    </li>
                  ))}
                </ul>
              </div>
              <p>
                Balances use successful payments minus successful refunds. Draft, waitlisted, and cancelled registrations are never included.
              </p>
            </div>

            <div className="reminder-recipient-table-wrap">
              <table className="reminder-recipient-table">
                <caption>
                  Recipient rows calculated {localDate(messaging.reminderPreview.generatedAt)}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Registrant</th>
                    <th scope="col">Confirmation</th>
                    <th scope="col">Email destination</th>
                    <th scope="col">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {messaging.reminderPreview.recipients.map((recipient) => (
                    <tr key={recipient.registrationId}>
                      <td>{recipient.recipientName}</td>
                      <td>{recipient.confirmationCode}</td>
                      <td>{recipient.recipientEmail}</td>
                      <td>{money(recipient.balanceCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {messaging.reminderPreview.recipients.length === 0 && (
                <div className="empty-state">
                  <CheckCircle2 size={24} aria-hidden="true" />
                  <h3>No balance reminders are needed</h3>
                  <p>No active registration currently has both a balance due and a valid contact email.</p>
                </div>
              )}
            </div>
          </section>

          <form className="panel reminder-confirm-panel" onSubmit={createReminderBatch}>
            <div>
              <p className="eyebrow">Step 2 · explicit action</p>
              <h2>
                {messaging.settings.deliveryMode === "EXTERNAL_EMAIL"
                  ? "Create the reviewed email queue"
                  : messaging.settings.deliveryMode === "LOCAL_CAPTURE"
                    ? "Create local reminder previews"
                    : "Record a suppressed reminder batch"}
              </h2>
              <p>
                {messaging.settings.deliveryMode === "EXTERNAL_EMAIL"
                  ? "This creates queued email rows only. It does not send them; a separate Process email queue action in the Delivery log is still required."
                  : messaging.settings.deliveryMode === "LOCAL_CAPTURE"
                    ? "This renders and captures the reviewed reminders inside IMSDA Events. No email provider is contacted."
                    : "Delivery is off. The reviewed rows will be recorded as suppressed for audit history, and no email will be sent."}
              </p>
            </div>
            {!messaging.reminderPreview.templateEnabled && (
              <div className="inline-notice error" role="alert">
                <AlertTriangle size={17} aria-hidden="true" />
                The Balance reminder template is disabled. This batch will be recorded as suppressed even if the delivery mode is on.
              </div>
            )}
            <label className="message-enabled-toggle reminder-confirm-check">
              <input
                type="checkbox"
                checked={reminderConfirmed}
                required
                onChange={(event) => setReminderConfirmed(event.target.checked)}
              />
              <span>
                <strong>I reviewed all {messaging.reminderPreview.includedCount} recipient{messaging.reminderPreview.includedCount === 1 ? "" : "s"} and the total balance of {money(messaging.reminderPreview.totalBalanceCents)}.</strong>
                <small>
                  I understand this action uses the exact preview above. If a registration, payment, refund, email, template, or sender setting changes, IMSDA Events will stop and require a new review.
                </small>
              </span>
            </label>
            {reminderDirty && <span className="unsaved-dot" role="status">Confirmation not submitted</span>}
            <button
              className="primary-button full-button"
              type="submit"
              disabled={saving || !reminderConfirmed || messaging.reminderPreview.includedCount === 0}
            >
              <Bell size={16} aria-hidden="true" />
              {saving
                ? "Creating reviewed batch…"
                : messaging.settings.deliveryMode === "EXTERNAL_EMAIL"
                  ? `Queue ${messaging.reminderPreview.includedCount} reminder email${messaging.reminderPreview.includedCount === 1 ? "" : "s"}`
                  : messaging.settings.deliveryMode === "LOCAL_CAPTURE"
                    ? `Capture ${messaging.reminderPreview.includedCount} local preview${messaging.reminderPreview.includedCount === 1 ? "" : "s"}`
                    : `Record ${messaging.reminderPreview.includedCount} suppressed row${messaging.reminderPreview.includedCount === 1 ? "" : "s"}`}
            </button>
          </form>
        </div>
      )}

      {view === "shirt-sizes" && messaging && (
        <div className="reminder-workspace" role="tabpanel" aria-label="Shirt size requests">
          <section className="panel reminder-preview-panel">
            <div className="message-delivery-toolbar">
              <div>
                <p className="eyebrow">Step 1 · review only</p>
                <h2>Review who is still missing a shirt size</h2>
                <p>
                  This preview does not create or send anything. It includes submitted or confirmed registrations with a valid contact email where at least one attendee has no shirt size recorded.
                </p>
              </div>
              <button className="secondary-button" type="button" onClick={refreshShirtSizePreview} disabled={saving}>
                <RefreshCw className={saving ? "spin" : ""} size={16} aria-hidden="true" />
                Refresh preview
              </button>
            </div>

            <div className="reminder-summary" aria-label="Shirt size audience summary">
              <article>
                <span className="message-stat-icon green"><Users size={18} aria-hidden="true" /></span>
                <small>Included recipients</small>
                <strong>{messaging.shirtSizePreview.includedCount}</strong>
              </article>
              <article>
                <span className="message-stat-icon gold"><Shirt size={18} aria-hidden="true" /></span>
                <small>Attendees missing a size</small>
                <strong>{messaging.shirtSizePreview.missingAttendeeCount}</strong>
              </article>
              <article>
                <span className="message-stat-icon purple"><AlertTriangle size={18} aria-hidden="true" /></span>
                <small>Skipped registrations</small>
                <strong>{messaging.shirtSizePreview.skippedCount}</strong>
              </article>
            </div>

            <div className="reminder-skip-reasons">
              <div>
                <p className="eyebrow">Why registrations were skipped</p>
                <ul>
                  {messaging.shirtSizePreview.skipReasons.map((reason) => (
                    <li key={reason.code}>
                      <span>{reason.label}</span>
                      <strong>{reason.count}</strong>
                    </li>
                  ))}
                </ul>
              </div>
              <p>
                A partly answered registration is still included, and the message names only the attendees who still need a size. Draft, waitlisted, and cancelled registrations are never included.
              </p>
            </div>

            <div className="reminder-recipient-table-wrap">
              <table className="reminder-recipient-table">
                <caption>
                  Recipient rows calculated {localDate(messaging.shirtSizePreview.generatedAt)}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Registrant</th>
                    <th scope="col">Confirmation</th>
                    <th scope="col">Email destination</th>
                    <th scope="col">Still missing</th>
                  </tr>
                </thead>
                <tbody>
                  {messaging.shirtSizePreview.recipients.map((recipient) => (
                    <tr key={recipient.registrationId}>
                      <td>{recipient.recipientName}</td>
                      <td>{recipient.confirmationCode}</td>
                      <td>{recipient.recipientEmail}</td>
                      <td>
                        {recipient.missingCount} of {recipient.attendeeCount}
                        <small>{recipient.missingAttendeeNames.join(", ")}</small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {messaging.shirtSizePreview.recipients.length === 0 && (
                messaging.shirtSizePreview.eventSupportsShirtSizes ? (
                  <div className="empty-state">
                    <CheckCircle2 size={24} aria-hidden="true" />
                    <h3>Every attendee has a shirt size</h3>
                    <p>No active registration is currently missing a shirt size with a valid contact email.</p>
                  </div>
                ) : (
                  <div className="empty-state">
                    <AlertTriangle size={24} aria-hidden="true" />
                    <h3>This event does not collect shirt sizes</h3>
                    <p>Registrants of this event have no shirt-size question on their private page, so a request would send them to a page that cannot answer it.</p>
                  </div>
                )
              )}
            </div>
          </section>

          <form className="panel reminder-confirm-panel" onSubmit={createShirtSizeBatch}>
            <div>
              <p className="eyebrow">Step 2 · explicit action</p>
              <h2>
                {messaging.settings.deliveryMode === "EXTERNAL_EMAIL"
                  ? "Create the reviewed email queue"
                  : messaging.settings.deliveryMode === "LOCAL_CAPTURE"
                    ? "Create local shirt-size previews"
                    : "Record a suppressed shirt-size batch"}
              </h2>
              <p>
                {messaging.settings.deliveryMode === "EXTERNAL_EMAIL"
                  ? "This creates queued email rows only. It does not send them; a separate Process email queue action in the Delivery log is still required."
                  : messaging.settings.deliveryMode === "LOCAL_CAPTURE"
                    ? "This renders and captures the reviewed requests inside IMSDA Events. No email provider is contacted."
                    : "Delivery is off. The reviewed rows will be recorded as suppressed for audit history, and no email will be sent."}
              </p>
              <p>
                Each message carries a freshly issued private management link, so a registrant who was migrated without an account reaches self-service from this message and chooses a size for each attendee there.
              </p>
            </div>
            {!messaging.shirtSizePreview.templateEnabled && (
              <div className="inline-notice error" role="alert">
                <AlertTriangle size={17} aria-hidden="true" />
                The Shirt size request template is disabled. This batch will be recorded as suppressed even if the delivery mode is on.
              </div>
            )}
            <label className="message-enabled-toggle reminder-confirm-check">
              <input
                type="checkbox"
                checked={shirtSizeConfirmed}
                required
                onChange={(event) => setShirtSizeConfirmed(event.target.checked)}
              />
              <span>
                <strong>I reviewed all {messaging.shirtSizePreview.includedCount} recipient{messaging.shirtSizePreview.includedCount === 1 ? "" : "s"} covering {messaging.shirtSizePreview.missingAttendeeCount} attendee{messaging.shirtSizePreview.missingAttendeeCount === 1 ? "" : "s"} without a size.</strong>
                <small>
                  I understand this action uses the exact preview above. If an attendee answers, or a registration, email, template, or sender setting changes, IMSDA Events will stop and require a new review.
                </small>
              </span>
            </label>
            {shirtSizeDirty && <span className="unsaved-dot" role="status">Confirmation not submitted</span>}
            <button
              className="primary-button full-button"
              type="submit"
              disabled={saving || !shirtSizeConfirmed || messaging.shirtSizePreview.includedCount === 0}
            >
              <Shirt size={16} aria-hidden="true" />
              {saving
                ? "Creating reviewed batch…"
                : messaging.settings.deliveryMode === "EXTERNAL_EMAIL"
                  ? `Queue ${messaging.shirtSizePreview.includedCount} shirt-size email${messaging.shirtSizePreview.includedCount === 1 ? "" : "s"}`
                  : messaging.settings.deliveryMode === "LOCAL_CAPTURE"
                    ? `Capture ${messaging.shirtSizePreview.includedCount} local preview${messaging.shirtSizePreview.includedCount === 1 ? "" : "s"}`
                    : `Record ${messaging.shirtSizePreview.includedCount} suppressed row${messaging.shirtSizePreview.includedCount === 1 ? "" : "s"}`}
            </button>
          </form>
        </div>
      )}

      {view === "templates" && messaging && (
        <div className="message-template-layout">
          <aside className="panel message-template-list">
            <div className="section-heading"><div><p className="eyebrow">Future messages</p><h2>Templates</h2></div></div>
            <div>
              {messaging.templates.map((template) => (
                <button
                  aria-pressed={selectedTemplate?.id === template.id}
                  className={selectedTemplate?.id === template.id ? "selected" : ""}
                  type="button"
                  onClick={() => selectTemplate(template.id)}
                  key={template.id}
                >
                  <span className="message-template-mark"><Mail size={16} aria-hidden="true" /></span>
                  <span><strong>{template.name}</strong><small>Version {template.activeVersion?.versionNumber ?? "—"} · {template.isEnabled ? "enabled" : "disabled"}</small></span>
                </button>
              ))}
            </div>
          </aside>

          {selectedTemplate ? (
            <form className="panel message-template-editor" onSubmit={publishTemplate}>
              <div className="section-heading">
                <div><p className="eyebrow">{templateLabels[selectedTemplate.key]}</p><h2>{selectedTemplate.name}</h2><p>{selectedTemplate.description}</p></div>
                <span className={`status-chip ${templateEnabled ? "green" : "purple"}`}>{templateEnabled ? "enabled" : "disabled"}</span>
              </div>
              <div className="message-safety-banner"><Clock3 size={18} aria-hidden="true" /><span><strong>Publishing affects future messages only.</strong><small>Existing queued and captured rows keep their exact subject and body snapshots.</small></span></div>
              <label>Subject<input value={templateSubject} maxLength={180} required onChange={(event) => setTemplateSubject(event.target.value)} /></label>
              <div className="message-body-field">
                <strong>Message body</strong>
                <MessageBodyEditor
                  key={selectedTemplate.id}
                  value={templateBody}
                  tokens={templateTokenKeys}
                  onChange={setTemplateBody}
                />
              </div>
              <label className="message-enabled-toggle">
                <input type="checkbox" checked={templateEnabled} onChange={(event) => setTemplateEnabled(event.target.checked)} />
                <span><strong>Queue this message type</strong><small>When disabled, registrations retain a suppressed audit row instead of a pending message.</small></span>
              </label>
              <div className="builder-actions">
                {templateDirty && <span className="unsaved-dot" role="status">Unpublished changes</span>}
                <button className="primary-button" type="submit" disabled={saving || !templateDirty}><Save size={16} aria-hidden="true" /> {saving ? "Publishing…" : "Publish new version"}</button>
              </div>
              <div className="message-version-history">
                <p className="eyebrow">Immutable history</p>
                {selectedTemplate.versions.map((version) => (
                  <div key={version.id}>
                    <span><strong>Version {version.versionNumber}</strong><small>{version.createdBy ?? "System default"} · {new Date(version.createdAt).toLocaleString()}</small></span>
                    <span className={`status-chip ${version.status === "PUBLISHED" ? "green" : "purple"}`}>{friendlyStatus(version.status)}</span>
                  </div>
                ))}
              </div>
            </form>
          ) : <div className="panel empty-state"><FileText size={25} /><h3>No templates available</h3></div>}

          {selectedTemplate && (
            <aside className="message-preview-column">
              <article className="panel message-email-preview">
                <div className="message-preview-head"><span><Mail size={17} aria-hidden="true" /></span><div><strong>Template preview</strong><small>Formatted exactly as delivery renders it. Never sends email.</small></div></div>
                <dl>
                  <div><dt>From</dt><dd>{messaging.settings.senderName}{messaging.settings.senderEmail ? ` <${messaging.settings.senderEmail}>` : ""}</dd></div>
                  <div><dt>Reply to</dt><dd>{messaging.settings.replyToEmail || "Not configured"}</dd></div>
                  <div><dt>Subject</dt><dd>{preview.subject || "No subject"}</dd></div>
                </dl>
                <iframe
                  className="message-body-html"
                  title="Template preview"
                  sandbox=""
                  srcDoc={renderEmailHtmlDocument({
                    title: preview.subject || "Template preview",
                    bodyHtml: preview.bodyHtml,
                    footer: messaging.settings.senderName,
                  })}
                />
                <details className="message-body-plain">
                  <summary>Plain-text fallback</summary>
                  <pre>{preview.body || "No message body"}</pre>
                </details>
              </article>
              <form className="panel message-test-form" onSubmit={createTestCapture}>
                <p className="eyebrow">Test the workflow</p>
                <h2>{testRealDelivery ? "Send a real test message" : "Capture a test message"}</h2>
                <p>
                  {testRealDelivery
                    ? "This sends one real email to the address below, from this event’s own sender and reply-to, so you can check what a registrant receives before a batch goes to everyone."
                    : "This creates a delivery-log row and attempt. It never contacts an email provider."}
                </p>
                <label>Recipient name<input name="recipientName" defaultValue="Local Test Recipient" required /></label>
                <label>
                  {testRealDelivery ? "Real recipient" : "Fictitious recipient"}
                  <input
                    name="recipientEmail"
                    type="email"
                    defaultValue="message.preview@example.test"
                    required
                  />
                </label>
                <label className="message-enabled-toggle">
                  <input
                    type="checkbox"
                    checked={testRealDelivery}
                    disabled={messaging.settings.deliveryMode !== "EXTERNAL_EMAIL"}
                    onChange={(event) => setTestRealDelivery(event.target.checked)}
                  />
                  <span>
                    <strong>Actually email this address</strong>
                    <small>
                      {messaging.settings.deliveryMode === "EXTERNAL_EMAIL"
                        ? "Uses this event’s sender, reply-to, and domain — the parts a local capture cannot check."
                        : "Available once this event’s delivery is set to real email with a verified sender."}
                    </small>
                  </span>
                </label>
                <label>
                  Real registration (optional)
                  <input
                    name="confirmationCode"
                    value={testConfirmationCode}
                    placeholder="e.g. WR26-1780602786558-7AC3"
                    onChange={(event) => setTestConfirmationCode(event.target.value)}
                  />
                  <small>
                    Blank uses sample data and a placeholder link. Name a confirmation code to render that registration’s real details, and the private link in the message becomes a working one.
                  </small>
                </label>
                {testConfirmationCode.trim() && testRealDelivery && (
                  <label className="message-enabled-toggle reminder-confirm-check">
                    <input
                      type="checkbox"
                      checked={testAcknowledgeExposure}
                      required
                      onChange={(event) => setTestAcknowledgeExposure(event.target.checked)}
                    />
                    <span>
                      <strong>I understand this emails a working private link to that registration.</strong>
                      <small>
                        Whoever receives it can open that registration, change its contact details, and see its balance. Send it to an address you control, and prefer a registration of your own. This is recorded against the registration and the address.
                      </small>
                    </span>
                  </label>
                )}
                <button className="secondary-button" type="submit" disabled={saving || messaging.settings.deliveryMode === "DISABLED"}>
                  <FlaskConical size={16} aria-hidden="true" />
                  {saving
                    ? (testRealDelivery ? "Sending…" : "Capturing…")
                    : (testRealDelivery ? "Send real test email" : "Capture locally")}
                </button>
              </form>
            </aside>
          )}
        </div>
      )}

      {view === "deliveries" && messaging && (
        <div className="message-delivery-stack">
          <section className="message-delivery-summary">
            <article className="panel"><span className="message-stat-icon gold"><Clock3 size={18} /></span><small>Queued</small><strong>{messaging.counts.PENDING + messaging.counts.PROCESSING}</strong></article>
            <article className="panel"><span className="message-stat-icon green"><CheckCircle2 size={18} /></span><small>Sent / accepted</small><strong>{messaging.counts.SENT}</strong></article>
            <article className="panel"><span className="message-stat-icon purple"><FlaskConical size={18} /></span><small>Local previews</small><strong>{messaging.counts.CAPTURED}</strong></article>
            <article className="panel"><span className="message-stat-icon coral"><AlertTriangle size={18} /></span><small>Failed</small><strong>{messaging.counts.FAILED}</strong></article>
          </section>
          <section className="panel message-delivery-panel">
            <div className="message-delivery-toolbar">
              <div><p className="eyebrow">Transactional outbox</p><h2>Delivery log</h2><p>Local preview, provider acceptance, and final delivery events are kept as separate facts.</p></div>
              <button className="secondary-button" type="button" onClick={processQueue} disabled={saving || messaging.settings.deliveryMode === "DISABLED"}>
                <RefreshCw className={saving ? "spin" : ""} size={16} aria-hidden="true" /> {messaging.settings.deliveryMode === "EXTERNAL_EMAIL" ? "Process email queue" : "Process local previews"}
              </button>
            </div>
            <div className="message-delivery-filters" role="group" aria-label="Filter messages">
              {deliveryFilters.map((filter) => (
                <button aria-pressed={deliveryFilter === filter} className={deliveryFilter === filter ? "active" : ""} type="button" onClick={() => chooseDeliveryFilter(filter)} key={filter}>
                  {filter === "ALL" ? "All" : friendlyStatus(filter)}
                </button>
              ))}
            </div>
            <div className="message-delivery-layout">
              <div className="message-delivery-list">
                {filteredMessages.map((message) => (
                  <button aria-pressed={selectedMessage?.id === message.id} className={selectedMessage?.id === message.id ? "selected" : ""} type="button" onClick={() => selectMessage(message.id)} key={message.id}>
                    <span className={`message-delivery-icon ${statusTone(message.status)}`}><Mail size={17} aria-hidden="true" /></span>
                    <span><strong>{message.recipientName || message.recipientEmail}</strong><small>{message.recipientEmail} · {messageTypeLabel(message)}</small></span>
                    <span><span className={`status-chip ${statusTone(message.status)}`}>{friendlyStatus(message.status)}</span><small>{new Date(message.createdAt).toLocaleString()}</small></span>
                  </button>
                ))}
                {filteredMessages.length === 0 && <div className="empty-state"><Inbox size={24} /><h3>No matching messages</h3><p>Submit a public registration or capture a template test to create a local row.</p></div>}
              </div>
              <aside className="message-delivery-detail">
                {selectedMessage ? (
                  <>
                    <div className="message-detail-head">
                      <div><p className="eyebrow">{messageTypeLabel(selectedMessage)}</p><h2>{selectedMessage.subject}</h2></div>
                      <span className={`status-chip ${statusTone(selectedMessage.status)}`}>{friendlyStatus(selectedMessage.status)}</span>
                    </div>
                    <dl className="message-detail-meta">
                      <div><dt>Recipient</dt><dd>{selectedMessage.recipientEmail}</dd></div>
                      <div><dt>Sender snapshot</dt><dd>{selectedMessage.senderName}{selectedMessage.senderEmail ? ` <${selectedMessage.senderEmail}>` : ""}</dd></div>
                      <div><dt>Registration</dt><dd>{selectedMessage.registration?.confirmationCode ?? "Test / detached message"}</dd></div>
                      <div><dt>Template</dt><dd>{selectedMessage.templateVersion ? `Version ${selectedMessage.templateVersion.versionNumber}` : "System fallback snapshot"}</dd></div>
                      <div><dt>Provider delivery</dt><dd>{selectedMessage.providerDeliveryStatus ? friendlyStatus(selectedMessage.providerDeliveryStatus) : selectedMessage.status === "CAPTURED" ? "Local preview only" : "Not reported"}</dd></div>
                      <div><dt>Provider message</dt><dd>{selectedMessage.providerMessageId ?? "Not assigned"}</dd></div>
                    </dl>
                    <p className="message-body-note">The private link and pass image below are stand-ins. Delivery mints a fresh one-per-message link that is never stored here.</p>
                    {selectedMessage.bodyHtml ? (
                      <iframe
                        className="message-body-html"
                        title="Captured message"
                        sandbox=""
                        srcDoc={renderEmailHtmlDocument({
                          title: selectedMessage.subject,
                          // The fragment stored at enqueue, shown as-is. Re-rendering
                          // the text here would re-parse registrant values as Markdown
                          // long after the safe render already decided they were not.
                          bodyHtml: withPreviewLinks(selectedMessage.bodyHtml),
                          footer: selectedMessage.senderName,
                        })}
                      />
                    ) : (
                      <p className="message-body-note">
                        This message was captured before formatted bodies existed, so it has a plain-text body only.
                      </p>
                    )}
                    <details className="message-body-plain">
                      <summary>Plain-text fallback</summary>
                      <pre className="message-body-snapshot">{withPreviewLinks(selectedMessage.bodyText)}</pre>
                    </details>
                    <div className="message-attempts">
                      <p className="eyebrow">Attempt history</p>
                      {selectedMessage.attempts.map((attempt) => (
                        <div key={attempt.id}>
                          <span className={`message-attempt-dot ${attempt.status.toLowerCase()}`} />
                          <span><strong>Attempt {attempt.attemptNumber} · {friendlyStatus(attempt.status)}</strong><small>{attempt.provider} · {localDate(attempt.completedAt ?? attempt.startedAt)}</small>{attempt.providerMessageId && <small>Provider ID: {attempt.providerMessageId}</small>}{attempt.errorMessage && <small className="form-error">{attempt.errorMessage}</small>}</span>
                        </div>
                      ))}
                      {selectedMessage.attempts.length === 0 && <p className="quiet-copy">No processing attempt has been recorded.</p>}
                    </div>
                    {selectedMessageNeedsSenderRepair && (
                      <div className={`message-retry-notice ${senderRepairReady ? "" : "is-blocked"}`} role="status">
                        <AlertTriangle size={18} aria-hidden="true" />
                        <span>
                          <strong>The original sender snapshot is blank.</strong>
                          <small>
                            {senderRepairReady
                              ? `A corrected copy can keep this subject and body while using the current event sender, ${messaging.settings.senderEmail}. The failed row remains unchanged for audit history.`
                              : "Save a verified sender in Sender & notifications before creating a corrected copy."}
                          </small>
                        </span>
                      </div>
                    )}
                    {canResendConfirmation(selectedMessage) && (
                      <form className="confirmation-resend-form" onSubmit={resendConfirmation}>
                        <div>
                          <p className="eyebrow">Audited confirmation copy</p>
                          <h3>Resend this registration confirmation</h3>
                          <p>
                            The subject and body above will be copied exactly. A corrected destination applies only to this copy and never changes the person or registration contact record. If the original sender was blank, the copy uses the event’s current sender.
                          </p>
                        </div>
                        <label>
                          Corrected email for this copy (optional)
                          <input
                            type="email"
                            value={resendRecipientEmail}
                            maxLength={254}
                            placeholder={selectedMessage.recipientEmail}
                            onChange={(event) => setResendRecipientEmail(event.target.value)}
                          />
                          <small>Leave blank to use {selectedMessage.recipientEmail}.</small>
                        </label>
                        <label className="message-enabled-toggle">
                          <input
                            type="checkbox"
                            checked={resendConfirmed}
                            required
                            onChange={(event) => setResendConfirmed(event.target.checked)}
                          />
                          <span>
                            <strong>
                              {messaging.settings.deliveryMode === "EXTERNAL_EMAIL"
                                ? `I reviewed the destination and want to queue one email to ${resendRecipientEmail.trim() || selectedMessage.recipientEmail}.`
                                : messaging.settings.deliveryMode === "LOCAL_CAPTURE"
                                  ? "I want to create one local confirmation preview. No email will be sent."
                                  : "I understand delivery is off and this copy will be recorded as suppressed."}
                            </strong>
                            <small>
                              Repeating the same request cannot create a duplicate. In email mode, a separate queue-processing action is required to send it.
                            </small>
                          </span>
                        </label>
                        {resendDirty && <span className="unsaved-dot" role="status">Confirmation-copy changes not submitted</span>}
                        <button
                          className="secondary-button"
                          type="submit"
                          disabled={
                            saving
                            || !resendConfirmed
                            || (selectedMessageNeedsSenderRepair && !senderRepairReady)
                          }
                        >
                          <Send size={16} aria-hidden="true" />
                          {saving
                            ? "Creating copy…"
                            : messaging.settings.deliveryMode === "EXTERNAL_EMAIL"
                              ? selectedMessageNeedsSenderRepair
                                ? "Queue corrected confirmation"
                                : "Queue confirmation email"
                              : messaging.settings.deliveryMode === "LOCAL_CAPTURE"
                                ? "Capture confirmation locally"
                                : "Record suppressed copy"}
                        </button>
                      </form>
                    )}
                    {!canResendConfirmation(selectedMessage) && (
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={retryMessage}
                        disabled={
                          saving
                          || messaging.settings.deliveryMode === "DISABLED"
                          || (selectedMessageNeedsSenderRepair && !senderRepairReady)
                          || selectedMessage.status === "PENDING"
                          || selectedMessage.status === "PROCESSING"
                          || (
                            messaging.settings.deliveryMode === "EXTERNAL_EMAIL"
                            && selectedMessage.status !== "FAILED"
                          )
                        }
                      >
                        <RefreshCw size={16} aria-hidden="true" /> {messaging.settings.deliveryMode === "EXTERNAL_EMAIL"
                          ? selectedMessageNeedsSenderRepair
                            ? "Send corrected copy"
                            : "Retry failed email"
                          : "Capture another audited copy"}
                      </button>
                    )}
                  </>
                ) : <div className="empty-state"><Mail size={24} /><h3>Select a message</h3><p>Choose a row to inspect the immutable subject, body, and attempts.</p></div>}
              </aside>
            </div>
          </section>
        </div>
      )}

      {view === "settings" && messaging && (
        <div className="message-settings-layout">
          <form className="panel message-settings-form" onSubmit={saveSettings}>
            <div className="section-heading"><div><p className="eyebrow">Event-level configuration</p><h2>Sender & notifications</h2><p>These values are snapshotted onto future outbox rows.</p></div></div>
            <fieldset className="message-delivery-mode">
              <legend>Delivery mode</legend>
              <label>
                <input type="radio" name="deliveryMode" value="DISABLED" checked={settingsDraft.deliveryMode === "DISABLED"} onChange={() => setSettingsDraft((current) => ({ ...current, deliveryMode: "DISABLED" }))} />
                <span><strong>Off</strong><small>Suppress future messages while keeping an audit row.</small></span>
              </label>
              <label>
                <input type="radio" name="deliveryMode" value="LOCAL_CAPTURE" checked={settingsDraft.deliveryMode === "LOCAL_CAPTURE"} onChange={() => setSettingsDraft((current) => ({ ...current, deliveryMode: "LOCAL_CAPTURE" }))} />
                <span><strong>Local preview</strong><small>Render and record messages without contacting an email provider.</small></span>
              </label>
              <label className={!messaging.settings.providerConfigured ? "disabled" : ""}>
                <input type="radio" name="deliveryMode" value="EXTERNAL_EMAIL" checked={settingsDraft.deliveryMode === "EXTERNAL_EMAIL"} disabled={!messaging.settings.providerConfigured} onChange={() => setSettingsDraft((current) => ({ ...current, deliveryMode: "EXTERNAL_EMAIL" }))} />
                <span><strong>Send real email</strong><small>{messaging.settings.providerConfigured ? "Send immutable message snapshots through Resend." : "Add the Resend API key on the server first."}</small></span>
              </label>
            </fieldset>
            <div className="form-grid two-column">
              <label>Sender name<input name="senderName" value={settingsDraft.senderName} minLength={2} maxLength={120} required onChange={(event) => setSettingsDraft((current) => ({ ...current, senderName: event.target.value }))} /></label>
              <label>Sender email<input name="senderEmail" type="email" value={settingsDraft.senderEmail} required={settingsDraft.deliveryMode === "EXTERNAL_EMAIL"} placeholder="registration@imsda.org" onChange={(event) => setSettingsDraft((current) => ({ ...current, senderEmail: event.target.value }))} /></label>
              <label>Reply-to email<input name="replyToEmail" type="email" value={settingsDraft.replyToEmail} placeholder="registration@example.test" onChange={(event) => setSettingsDraft((current) => ({ ...current, replyToEmail: event.target.value }))} /></label>
            </div>
            <label>Internal registration recipients<textarea name="internalNotificationEmails" value={settingsDraft.internalNotificationEmails} rows={5} placeholder={"registration@example.test\nfinance@example.test"} onChange={(event) => setSettingsDraft((current) => ({ ...current, internalNotificationEmails: event.target.value }))} /><small>One email per line. Every new public registration creates one internal-notice row per recipient.</small></label>
            <div className="builder-actions">{settingsDirty && <span className="unsaved-dot" role="status">Unsaved changes</span>}<button className="primary-button" type="submit" disabled={saving || !settingsDirty}><Save size={16} aria-hidden="true" /> {saving ? "Saving…" : "Save settings"}</button></div>
          </form>
          <aside className="panel message-boundary-card">
            <span>{messaging.settings.providerConfigured ? <Send size={22} aria-hidden="true" /> : <FlaskConical size={22} aria-hidden="true" />}</span>
            <p className="eyebrow">Delivery readiness</p>
            <h2>{messaging.settings.providerConfigured ? "Resend is configured" : "Real email is locked"}</h2>
            <p>{messaging.settings.providerConfigured ? "Real delivery can be enabled after a verified sender is entered. Local template tests remain previews." : "Local preview exercises rendering, outbox idempotency, attempts, and staff review without transmitting attendee data."}</p>
            <ul><li>Provider API: {messaging.settings.providerConfigured ? "configured" : "not configured"}</li><li>Delivery webhook: {messaging.settings.webhookConfigured ? "configured" : "not configured"}</li><li>Registration commits before processing</li><li>Retries preserve the original message snapshot</li></ul>
          </aside>
        </div>
      )}

      {draftOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setDraftOpen(false); }}>
          <section className="modal-card" ref={draftDialogRef} role="dialog" aria-modal="true" aria-labelledby="draft-title" tabIndex={-1}>
            <div className="modal-head">
              <div><p className="eyebrow">Attendee event feed</p><h2 id="draft-title">Create an announcement</h2></div>
              <button className="icon-button modal-close-button" type="button" onClick={() => setDraftOpen(false)} aria-label="Close dialog"><X aria-hidden="true" size={18} /></button>
            </div>
            <form className="form-stack" onSubmit={createDraft}>
              <label>Title<input name="title" minLength={3} maxLength={120} required placeholder="Friday arrival information" /></label>
              <label>Message<textarea name="body" minLength={5} maxLength={2000} required rows={6} placeholder="Share the details attendees need…" /></label>
              <label>Priority<select name="priority" defaultValue="NORMAL"><option value="NORMAL">Normal</option><option value="IMPORTANT">Important</option><option value="URGENT">Urgent</option></select></label>
              <div className="form-actions"><button className="secondary-button" type="button" onClick={() => setDraftOpen(false)}>Cancel</button><button className="primary-button" type="submit" disabled={saving}>{saving ? "Saving…" : "Save draft"}</button></div>
            </form>
          </section>
        </div>
      )}
    </section>
  );
}
