import type { AnnouncementBroadcastPreview } from "@/modules/communications/types";

export function deliveryTimingLabel(mode: AnnouncementBroadcastPreview["deliveryMode"]) {
  if (mode === "EXTERNAL_EMAIL") return "Sends immediately by email";
  if (mode === "LOCAL_CAPTURE") return "Captured locally — immediately, no email sent";
  return "Recorded as suppressed — immediately, delivery is off";
}

export type AnnouncementBroadcastReviewState = {
  loading: boolean;
  error: string;
  preview: AnnouncementBroadcastPreview | null;
};

/**
 * The one rule for whether the review dialog's Send button is live (#472):
 * only once a preview has loaded successfully and it reaches at least one
 * recipient. While loading, after a failed preview, or with nobody to send
 * to, it stays disabled — and `reason` says why when there is something to
 * explain.
 */
export function announcementBroadcastConfirmState(
  review: AnnouncementBroadcastReviewState | null,
): { canConfirm: boolean; reason: string } {
  if (!review || review.loading) return { canConfirm: false, reason: "" };
  if (!review.preview) {
    return {
      canConfirm: false,
      reason: review.error ? "" : "The recipient review hasn't loaded.",
    };
  }
  if (review.preview.recipientCount === 0) {
    return {
      canConfirm: false,
      reason: review.preview.activeRegistrationCount === 0
        ? "There are no active registrations to send this to."
        : "None of the active registrations has a contact email, so there is no one to send this to.",
    };
  }
  return { canConfirm: true, reason: "" };
}

/**
 * The announcement broadcast review dialog's body (#472): the announcement,
 * audience, recipient count, skipped registrations, and delivery mode staff
 * must see before an event-wide send happens. A standalone component so the
 * review content can be rendered and checked without mounting the whole
 * communications workspace.
 */
export function AnnouncementBroadcastReviewFacts({
  preview,
}: {
  preview: AnnouncementBroadcastPreview;
}) {
  return (
    <>
      <dl className="confirm-dialog-facts">
        <div><dt>Announcement title</dt><dd>{preview.title}</dd></div>
        <div><dt>Audience</dt><dd>{preview.audienceLabel}</dd></div>
        <div><dt>Recipients</dt><dd>{preview.recipientCount}</dd></div>
        {preview.skippedNoEmailCount > 0 && (
          <div>
            <dt>Skipped</dt>
            <dd>
              {preview.skippedNoEmailCount} registration{preview.skippedNoEmailCount === 1 ? " has" : "s have"} no contact email
            </dd>
          </div>
        )}
        <div><dt>Delivery</dt><dd>{deliveryTimingLabel(preview.deliveryMode)}</dd></div>
      </dl>
      {!preview.templateEnabled && (
        <p className="form-error">
          The event announcement email template is turned off, so every message will be recorded as suppressed and nobody will receive an email.
        </p>
      )}
    </>
  );
}
