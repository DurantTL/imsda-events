import type { Metadata } from "next";
import { CommunicationsWorkspace } from "@/components/communications-workspace";
import { getMessagingWorkspace } from "@/modules/communications/messaging-repository";
import { listAnnouncements } from "@/modules/communications/repository";
import type { CommunicationsView, MessagingWorkspaceData } from "@/modules/communications/types";
import { resolveEventContext } from "@/modules/events/selection";

export const metadata: Metadata = { title: "Communications" };

const emptyMessaging: MessagingWorkspaceData = {
  settings: {
    deliveryMode: "LOCAL_CAPTURE",
    senderName: "IMSDA Events",
    senderEmail: "",
    replyToEmail: "",
    internalNotificationEmails: [],
    providerConfigured: false,
    webhookConfigured: false,
  },
  templates: [],
  messages: [],
  counts: {
    PENDING: 0,
    PROCESSING: 0,
    CAPTURED: 0,
    SENT: 0,
    FAILED: 0,
    SUPPRESSED: 0,
    CANCELLED: 0,
  },
  reminderPreview: {
    fingerprint: "",
    generatedAt: new Date(0).toISOString(),
    includedCount: 0,
    skippedCount: 0,
    totalBalanceCents: 0,
    deliveryMode: "LOCAL_CAPTURE",
    templateEnabled: true,
    templateVersionNumber: null,
    recipients: [],
    skipReasons: [
      { code: "INACTIVE_REGISTRATION", label: "Not submitted or confirmed", count: 0 },
      { code: "NO_BALANCE_DUE", label: "No balance is due", count: 0 },
      { code: "INVALID_CONTACT_EMAIL", label: "Missing or invalid contact email", count: 0 },
    ],
  },
};

const communicationViews = new Set<CommunicationsView>([
  "announcements",
  "reminders",
  "templates",
  "deliveries",
  "settings",
]);

export default async function CommunicationsPage({
  searchParams,
}: {
  searchParams: Promise<{ event?: string; new?: string; view?: string }>;
}) {
  const { event: requested, new: openNew, view: requestedView } = await searchParams;
  const { event, permissions } = await resolveEventContext(requested);
  const canManage = permissions.includes("MANAGE_COMMUNICATIONS");
  const [announcements, messaging] = await Promise.all([
    listAnnouncements(event.id),
    canManage ? getMessagingWorkspace(event.id) : Promise.resolve(emptyMessaging),
  ]);
  const initialView = canManage && communicationViews.has(requestedView as CommunicationsView)
    ? requestedView as CommunicationsView
    : "announcements";
  return (
    <CommunicationsWorkspace
      key={event.id}
      eventId={event.id}
      eventName={event.name}
      initialAnnouncements={announcements}
      initialMessaging={messaging}
      canManage={canManage}
      initialView={initialView}
      openNew={openNew === "1"}
    />
  );
}
