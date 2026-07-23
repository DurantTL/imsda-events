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
  Users,
  WalletCards,
  X,
} from "lucide-react";
import { useAccessibleDialog } from "@/components/use-accessible-dialog";
import { useUnsavedChangesGuard } from "@/components/use-unsaved-changes-guard";
import { messageRetryRequestPayload } from "@/modules/communications/message-retry-client";
import type {
  AnnouncementRecord,
  BalanceReminderPreview,
  CommunicationsView,
  MessageOutboxRecord,
  MessageOutboxStatusValue,
  MessagingWorkspaceData,
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

const sampleTokens: Record<string, string> = {
  recipient_name: "Avery Johnson",
  registrant_name: "Avery Johnson",
  event_name: "Sample event",
  event_dates: "September 25–27, 2026",
  event_location: "Camp Heritage",
  confirmation_code: "REG-DEMO123",
  attendee_summary: "Avery Johnson\nHousing: Lodge room\nMeal plan: Full weekend",
  total_amount: "$129.05",
  balance_amount: "$129.05",
  payment_instructions: "No card was charged. The event team will confirm the next payment step.",
  portal_url: "[Private registration link inserted only during delivery]",
  reply_to_email: "registration@example.test",
  waitlist_position: "3",
  contact_email: "avery.johnson@example.test",
  payment_amount: "$129.05",
  payment_reference: "square-demo-reference",
  prior_person_name: "Jordan Lee",
  new_person_name: "Morgan Lee",
};

const templateTokenKeys = Object.keys(sampleTokens);
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
};

function renderSample(value: string, eventName: string) {
  return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (placeholder, token: string) => {
    if (token === "event_name") return eventName;
    return sampleTokens[token] ?? placeholder;
  });
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
  const [templateSubject, setTemplateSubject] = useState(selectedTemplate?.activeVersion?.subjectTemplate ?? "");
  const [templateBody, setTemplateBody] = useState(selectedTemplate?.activeVersion?.bodyTemplate ?? "");
  const [templateEnabled, setTemplateEnabled] = useState(selectedTemplate?.isEnabled ?? true);
  const [settingsDraft, setSettingsDraft] = useState<MessagingSettingsDraft>(
    () => settingsDraftFromMessaging(messaging),
  );
  const [reminderConfirmed, setReminderConfirmed] = useState(false);
  const [reminderBatchId, setReminderBatchId] = useState("");
  const [resendRecipientEmail, setResendRecipientEmail] = useState("");
  const [resendConfirmed, setResendConfirmed] = useState(false);
  const [resendRequestId, setResendRequestId] = useState("");
  const [retryRequestId, setRetryRequestId] = useState("");

  const templateDirty = Boolean(selectedTemplate && (
    templateSubject !== (selectedTemplate.activeVersion?.subjectTemplate ?? "")
    || templateBody !== (selectedTemplate.activeVersion?.bodyTemplate ?? "")
    || templateEnabled !== selectedTemplate.isEnabled
  ));
  const savedSettingsDraft = settingsDraftFromMessaging(messaging);
  const settingsDirty = JSON.stringify(settingsDraft) !== JSON.stringify(savedSettingsDraft);
  const reminderDirty = reminderConfirmed;
  const resendDirty = resendConfirmed || resendRecipientEmail.trim().length > 0;
  const hasUnsavedChanges = templateDirty || settingsDirty || reminderDirty || resendDirty;
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
        }),
      },
      "The test message was captured locally. No email was sent.",
    );
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
              </article>
            ))}
            {announcements.length === 0 && (
              <div className="empty-state panel"><Megaphone aria-hidden="true" size={24} /><h3>No announcements yet</h3><p>Create a draft when attendees need an event-feed update.</p></div>
            )}
          </section>
          <aside className="panel audience-panel">
            <span className="announcement-icon purple"><Send aria-hidden="true" size={20} /></span>
            <p className="eyebrow">Event feed</p>
            <h2>Announcements stay local</h2>
            <p>Publishing makes an announcement available to the local event feed. It does not send an email, text, or push notification.</p>
            <ul><li>Staff-reviewed drafts</li><li>Event-scoped permissions</li><li>Audited publication</li></ul>
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
              <label>Plain-text message<textarea value={templateBody} rows={18} maxLength={12000} required onChange={(event) => setTemplateBody(event.target.value)} /></label>
              <label className="message-enabled-toggle">
                <input type="checkbox" checked={templateEnabled} onChange={(event) => setTemplateEnabled(event.target.checked)} />
                <span><strong>Queue this message type</strong><small>When disabled, registrations retain a suppressed audit row instead of a pending message.</small></span>
              </label>
              <div className="message-token-list">
                <strong>Available tokens</strong>
                <div>{templateTokenKeys.map((token) => <code key={token}>{`{{${token}}}`}</code>)}</div>
              </div>
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
                <div className="message-preview-head"><span><Mail size={17} aria-hidden="true" /></span><div><strong>Template preview</strong><small>This preview never sends email</small></div></div>
                <dl>
                  <div><dt>From</dt><dd>{messaging.settings.senderName}{messaging.settings.senderEmail ? ` <${messaging.settings.senderEmail}>` : ""}</dd></div>
                  <div><dt>Reply to</dt><dd>{messaging.settings.replyToEmail || "Not configured"}</dd></div>
                  <div><dt>Subject</dt><dd>{renderSample(templateSubject, eventName) || "No subject"}</dd></div>
                </dl>
                <pre>{renderSample(templateBody, eventName) || "No message body"}</pre>
              </article>
              <form className="panel message-test-form" onSubmit={createTestCapture}>
                <p className="eyebrow">Test the workflow</p>
                <h2>Capture a test message</h2>
                <p>This creates a delivery-log row and attempt. It never contacts an email provider.</p>
                <label>Recipient name<input name="recipientName" defaultValue="Local Test Recipient" required /></label>
                <label>Fictitious recipient<input name="recipientEmail" type="email" defaultValue="message.preview@example.test" required /></label>
                <button className="secondary-button" type="submit" disabled={saving || messaging.settings.deliveryMode === "DISABLED"}>
                  <FlaskConical size={16} aria-hidden="true" /> {saving ? "Capturing…" : "Capture locally"}
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
                    <pre className="message-body-snapshot">{selectedMessage.bodyText.replaceAll("__IMSDA_PRIVATE_MANAGE_LINK__", "[Private registration link inserted only during delivery]")}</pre>
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
                    {canResendConfirmation(selectedMessage) && (
                      <form className="confirmation-resend-form" onSubmit={resendConfirmation}>
                        <div>
                          <p className="eyebrow">Audited confirmation copy</p>
                          <h3>Resend this registration confirmation</h3>
                          <p>
                            The subject and body above will be copied exactly. A corrected destination applies only to this copy and never changes the person or registration contact record.
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
                        <button className="secondary-button" type="submit" disabled={saving || !resendConfirmed}>
                          <Send size={16} aria-hidden="true" />
                          {saving
                            ? "Creating copy…"
                            : messaging.settings.deliveryMode === "EXTERNAL_EMAIL"
                              ? "Queue confirmation email"
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
                          || selectedMessage.status === "PENDING"
                          || selectedMessage.status === "PROCESSING"
                          || (
                            messaging.settings.deliveryMode === "EXTERNAL_EMAIL"
                            && selectedMessage.status !== "FAILED"
                          )
                        }
                      >
                        <RefreshCw size={16} aria-hidden="true" /> {messaging.settings.deliveryMode === "EXTERNAL_EMAIL" ? "Retry failed email" : "Capture another audited copy"}
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
