"use client";

import { useEffect, useRef, useState } from "react";
import { LoaderCircle, MailCheck, Send, TriangleAlert, X } from "lucide-react";
import { useAccessibleDialog } from "@/components/use-accessible-dialog";
import {
  selectedAudienceTemplateKeys,
  selectedAudienceTemplateLabels,
  type SelectedAudiencePreview,
  type SelectedAudienceTemplateKey,
} from "@/modules/communications/selected-audience";

type BatchOperation = {
  includedCount: number;
  skippedCount: number;
  deliveryMode: "DISABLED" | "LOCAL_CAPTURE" | "EXTERNAL_EMAIL";
  queuedCount: number;
  capturedCount: number;
  suppressedCount: number;
  replayed: boolean;
};

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
    .format(cents / 100);
}

function deliveryNote(operation: BatchOperation) {
  if (operation.deliveryMode === "DISABLED") {
    return "Delivery is switched off for this event, so the messages were recorded and suppressed. Nothing was emailed.";
  }
  if (operation.deliveryMode === "LOCAL_CAPTURE") {
    return "This event captures messages locally. They are recorded against each registration, and nothing was emailed.";
  }
  return "The messages are queued. They send when the outbox is processed.";
}

/**
 * Sends one template to the registrations staff picked in the list.
 *
 * The preview is fetched before anything can be sent, and the send carries
 * that preview's fingerprint: a balance paid or a template republished between
 * reviewing and sending makes the server refuse rather than mail a list
 * somebody read minutes ago. The batch id is generated once per dialog, so a
 * double-clicked send returns the batch that already exists.
 */
export function SelectedAudienceDialog({
  eventId,
  registrationIds,
  onClose,
}: {
  eventId: string;
  registrationIds: string[];
  onClose: () => void;
}) {
  const [templateKey, setTemplateKey] = useState<SelectedAudienceTemplateKey>("BALANCE_REMINDER");
  const [announcementTitle, setAnnouncementTitle] = useState("");
  const [announcementBody, setAnnouncementBody] = useState("");
  const [preview, setPreview] = useState<SelectedAudiencePreview | null>(null);
  const [operation, setOperation] = useState<BatchOperation | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const batchIdRef = useRef(crypto.randomUUID());
  const dialogRef = useAccessibleDialog<HTMLElement>(true, () => {
    if (!sending) onClose();
  });

  // The loading and cleared-preview states are set by whatever caused the
  // reload — mount, or the template change below — rather than inside the
  // effect, so no render cascades out of the effect body.
  useEffect(() => {
    let current = true;
    async function loadPreview() {
      try {
        const response = await fetch(`/api/events/${eventId}/selected-audience-messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "preview", templateKey, registrationIds }),
        });
        const result = await response.json();
        if (!current) return;
        if (!response.ok) throw new Error(result.message ?? "Unable to review these registrations.");
        setPreview(result.selectedAudiencePreview);
        setError("");
      } catch (caught) {
        if (!current) return;
        setError(caught instanceof Error ? caught.message : "Unable to review these registrations.");
      } finally {
        if (current) setLoading(false);
      }
    }
    void loadPreview();
    return () => { current = false; };
  }, [eventId, registrationIds, templateKey]);

  async function send() {
    if (!preview) return;
    setSending(true);
    setError("");
    try {
      const response = await fetch(`/api/events/${eventId}/selected-audience-messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batchId: batchIdRef.current,
          templateKey,
          registrationIds,
          announcementTitle,
          announcementBody,
          previewFingerprint: preview.fingerprint,
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        if (result.selectedAudiencePreview) setPreview(result.selectedAudiencePreview);
        throw new Error(result.message ?? "Unable to send to these registrations.");
      }
      setOperation(result.operation);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to send to these registrations.");
    } finally {
      setSending(false);
    }
  }

  const announcementReady = templateKey !== "EVENT_ANNOUNCEMENT"
    || (announcementTitle.trim().length > 0 && announcementBody.trim().length > 0);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(mouseEvent) => {
      if (mouseEvent.target === mouseEvent.currentTarget && !sending) onClose();
    }}>
      <section
        aria-labelledby="selected-audience-title"
        aria-modal="true"
        className="modal-card"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="modal-head">
          <div>
            <p className="eyebrow">{registrationIds.length} selected registration{registrationIds.length === 1 ? "" : "s"}</p>
            <h2 id="selected-audience-title">
              {operation ? "Message batch created" : "Email the selected registrations"}
            </h2>
          </div>
          <button aria-label="Close dialog" className="icon-button" disabled={sending} onClick={onClose} type="button">
            <X aria-hidden="true" size={18} />
          </button>
        </div>

        {operation ? (
          <div className="detail-stack">
            <div className="inline-notice success" role="status">
              <MailCheck aria-hidden="true" size={17} />{" "}
              {operation.replayed
                ? "This batch was already created; nothing was sent twice."
                : `Created for ${operation.includedCount} registration${operation.includedCount === 1 ? "" : "s"}.`}
            </div>
            <p className="quiet-copy">{deliveryNote(operation)}</p>
            <div className="detail-grid">
              <span><small>Included</small><strong>{operation.includedCount}</strong></span>
              <span><small>Skipped</small><strong>{operation.skippedCount}</strong></span>
              <span><small>Queued</small><strong>{operation.queuedCount}</strong></span>
              <span><small>Suppressed</small><strong>{operation.suppressedCount}</strong></span>
            </div>
            <div className="form-actions">
              <button className="primary-button" onClick={onClose} type="button">Done</button>
            </div>
          </div>
        ) : (
          <div className="detail-stack">
            <label>
              Message
              <select
                disabled={sending}
                onChange={(changeEvent) => {
                  setTemplateKey(changeEvent.target.value as SelectedAudienceTemplateKey);
                  setPreview(null);
                  setLoading(true);
                }}
                value={templateKey}
              >
                {selectedAudienceTemplateKeys.map((key) => (
                  <option key={key} value={key}>{selectedAudienceTemplateLabels[key]}</option>
                ))}
              </select>
            </label>

            {templateKey === "EVENT_ANNOUNCEMENT" && (
              <>
                <label>
                  Announcement title
                  <input
                    disabled={sending}
                    maxLength={120}
                    onChange={(changeEvent) => setAnnouncementTitle(changeEvent.target.value)}
                    value={announcementTitle}
                  />
                </label>
                <label>
                  Announcement message
                  <textarea
                    disabled={sending}
                    maxLength={4000}
                    onChange={(changeEvent) => setAnnouncementBody(changeEvent.target.value)}
                    rows={6}
                    value={announcementBody}
                  />
                </label>
              </>
            )}

            {loading ? (
              <p className="quiet-copy"><LoaderCircle aria-hidden="true" className="spin" size={15} /> Reviewing the selected registrations…</p>
            ) : preview ? (
              <>
                <div className="detail-grid">
                  <span><small>Will receive</small><strong>{preview.includedCount}</strong></span>
                  <span><small>Skipped</small><strong>{preview.skippedCount}</strong></span>
                  {templateKey === "BALANCE_REMINDER" && (
                    <span><small>Balance covered</small><strong>{money(preview.totalBalanceCents)}</strong></span>
                  )}
                </div>
                {!preview.templateEnabled && (
                  <div className="inline-notice">
                    <TriangleAlert aria-hidden="true" size={16} /> This template is disabled for the event. The messages would be recorded and suppressed rather than sent.
                  </div>
                )}
                {preview.skipped.length > 0 && (
                  <div>
                    <p className="eyebrow">Not receiving this message</p>
                    <ul className="selected-audience-skips">
                      {preview.skipped.map((entry) => (
                        <li key={entry.registrationId}>
                          <span>{entry.confirmationCode || entry.registrationId}</span>
                          <small>{entry.recipientName} · {entry.label}</small>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            ) : null}

            {error && <p className="form-error" role="alert">{error}</p>}

            <div className="form-actions">
              <button className="secondary-button" disabled={sending} onClick={onClose} type="button">Cancel</button>
              <button
                className="primary-button"
                disabled={sending || loading || !announcementReady || (preview?.includedCount ?? 0) === 0}
                onClick={() => void send()}
                type="button"
              >
                <Send aria-hidden="true" size={16} />{" "}
                {sending
                  ? "Sending…"
                  : `Send to ${preview?.includedCount ?? 0}`}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
