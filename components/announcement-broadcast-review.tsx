import type { AnnouncementBroadcastPreview } from "@/modules/communications/types";

export function deliveryTimingLabel(mode: AnnouncementBroadcastPreview["deliveryMode"]) {
  if (mode === "EXTERNAL_EMAIL") return "Sends immediately by email";
  if (mode === "LOCAL_CAPTURE") return "Captured locally — immediately, no email sent";
  return "Recorded as suppressed — immediately, delivery is off";
}

/**
 * The announcement broadcast review dialog's body (#472): the subject,
 * audience, recipient count, and delivery mode staff must see before an
 * event-wide send happens. A standalone component so the review content can
 * be rendered and checked without mounting the whole communications
 * workspace.
 */
export function AnnouncementBroadcastReviewFacts({
  preview,
}: {
  preview: AnnouncementBroadcastPreview;
}) {
  return (
    <dl className="confirm-dialog-facts">
      <div><dt>Subject</dt><dd>{preview.title}</dd></div>
      <div><dt>Audience</dt><dd>{preview.audienceLabel}</dd></div>
      <div><dt>Recipients</dt><dd>{preview.recipientCount}</dd></div>
      <div><dt>Delivery</dt><dd>{deliveryTimingLabel(preview.deliveryMode)}</dd></div>
    </dl>
  );
}
