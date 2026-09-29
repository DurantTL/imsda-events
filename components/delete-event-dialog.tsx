"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { eventDeletionHasRealMoney, eventNameConfirmed, type EventDeletionCounts } from "@/modules/events/deletion";

type Preview = {
  name: string;
  counts: EventDeletionCounts;
  decision: { allowed: true } | { allowed: false; reason: string };
};

function plural(count: number, one: string, many = `${one}s`) {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

/**
 * Deleting an event is permanent (#620). The dialog loads what would be
 * removed, warns separately when real payment history is involved, and asks
 * for the event's exact name before the button enables.
 */
export function DeleteEventDialog(props: {
  eventId: string;
  eventName: string;
  onCancel: () => void;
  open: boolean;
}) {
  // Mounted only while open, so every opening starts from a clean state.
  return props.open ? <DeleteEventDialogBody {...props} /> : null;
}

function DeleteEventDialogBody({
  eventId,
  eventName,
  onCancel,
  open,
}: {
  eventId: string;
  eventName: string;
  onCancel: () => void;
  open: boolean;
}) {
  const router = useRouter();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loadError, setLoadError] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/events/${eventId}/deletion`)
      .then(async (response) => {
        const body = await response.json().catch(() => ({})) as { preview?: Preview; message?: string };
        if (!response.ok || !body.preview) throw new Error(body.message ?? "The deletion summary could not be loaded.");
        if (!cancelled) setPreview(body.preview);
      })
      .catch((caught) => {
        if (!cancelled) setLoadError(caught instanceof Error ? caught.message : "The deletion summary could not be loaded.");
      });
    return () => { cancelled = true; };
  }, [eventId]);

  async function confirmDelete() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/events/${eventId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmName: typed }),
      });
      const body = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) throw new Error(body.message ?? "The event could not be deleted.");
      router.push("/select-event");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The event could not be deleted.");
      setBusy(false);
    }
  }

  const counts = preview?.counts;
  const allowed = preview?.decision.allowed === true;
  const confirmed = eventNameConfirmed(eventName, typed);

  return (
    <ConfirmDialog
      busy={busy}
      busyLabel="Deleting…"
      confirmDisabled={!allowed || !confirmed}
      confirmLabel="Delete event permanently"
      destructive
      error={error || loadError}
      onCancel={onCancel}
      onConfirm={() => void confirmDelete()}
      open={open}
      title={`Delete ${eventName}?`}
    >
      <p>
        This permanently deletes <strong translate="no">{eventName}</strong> and everything it owns. It cannot be undone.
        People, accounts, clubs and background checks are shared with other events and are kept.
      </p>
      {!preview && !loadError && <p role="status">Counting what will be removed…</p>}
      {counts && (
        <>
          <p>This will remove:</p>
          <ul>
            <li>{plural(counts.registrations, "registration")} and {plural(counts.attendees, "attendee")}</li>
            <li>{plural(counts.payments, "payment")} and {plural(counts.invoices, "invoice")}</li>
            <li>{plural(counts.honorEnrollments, "honors enrollment")}</li>
            <li>{plural(counts.locations, "location")}</li>
            <li>{plural(counts.forms, "registration form")}</li>
            <li>{plural(counts.messages, "message")}{counts.queuedMessages > 0 ? ` (${counts.queuedMessages.toLocaleString("en-US")} still queued will be cancelled, not sent)` : ""}</li>
          </ul>
          {eventDeletionHasRealMoney(counts) && (
            <p className="form-error" role="alert">
              This event has payments that are not test-mode, or issued invoices. Its payment history will be removed
              from this system. Records held by the card processor are not affected. You can still continue.
            </p>
          )}
          {preview?.decision.allowed === false && <p className="form-error" role="alert">{preview.decision.reason}</p>}
          {allowed && (
            <label className="field">
              <span>Type the event name to confirm</span>
              <input
                autoComplete="off"
                disabled={busy}
                onChange={(event) => setTyped(event.target.value)}
                placeholder={eventName}
                value={typed}
              />
            </label>
          )}
        </>
      )}
    </ConfirmDialog>
  );
}
