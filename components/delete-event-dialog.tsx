"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { eventNameConfirmed, type EventDeletionCounts } from "@/modules/events/deletion";

export type DeletionPreview = {
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
  onCancel: () => void;
  open: boolean;
}) {
  // Mounted only while open, so every opening starts from a clean state.
  return props.open ? <DeleteEventDialogBody {...props} /> : null;
}

function DeleteEventDialogBody({
  eventId,
  onCancel,
  open,
}: {
  eventId: string;
  onCancel: () => void;
  open: boolean;
}) {
  const router = useRouter();
  const [preview, setPreview] = useState<DeletionPreview | null>(null);
  const [loadError, setLoadError] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/events/${eventId}/deletion`)
      .then(async (response) => {
        const body = await response.json().catch(() => ({})) as { preview?: DeletionPreview; message?: string };
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

  return (
    <DeleteEventDialogView
      busy={busy}
      error={error || loadError}
      loadFailed={Boolean(loadError)}
      onCancel={onCancel}
      onConfirm={() => void confirmDelete()}
      onTyped={setTyped}
      open={open}
      preview={preview}
      typed={typed}
    />
  );
}

/**
 * The dialog's presentation. The name shown, and the name the user must type,
 * come from the server's preview rather than the page's copy, which goes stale
 * when the event is renamed in the same page without a reload.
 */
export function DeleteEventDialogView({
  busy,
  error,
  loadFailed,
  onCancel,
  onConfirm,
  onTyped,
  open,
  preview,
  typed,
}: {
  busy: boolean;
  error: string;
  loadFailed: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  onTyped: (value: string) => void;
  open: boolean;
  preview: DeletionPreview | null;
  typed: string;
}) {
  const eventName = preview?.name ?? "";
  const counts = preview?.counts;
  const allowed = preview?.decision.allowed === true;
  const confirmed = eventNameConfirmed(eventName, typed);

  return (
    <ConfirmDialog
      busy={busy}
      busyLabel="Deleting…"
      confirmDisabled={!allowed || !confirmed}
      confirmLabel={preview ? `Permanently delete ${eventName}` : "Delete event"}
      destructive
      error={error}
      onCancel={onCancel}
      onConfirm={onConfirm}
      open={open}
      title={preview ? `Delete ${eventName}?` : "Delete this event?"}
    >
      {!preview && !loadFailed && <p role="status">Checking what is attached to this event…</p>}
      {preview?.decision.allowed === false && (
        <p className="form-error" role="alert">{preview.decision.reason}</p>
      )}
      {allowed && counts && (
        <>
          <p>
            This permanently deletes <strong translate="no">{eventName}</strong>. It has no registrations, payments, imports,
            form submissions, club drafts, posts, announcements or messages, so only its setup (the locations and forms listed
            below, plus its settings) is removed. It cannot be undone. People, accounts, clubs and background checks
            are shared with other events and are kept.
          </p>
          <ul>
            <li>{plural(counts.locations, "location")}</li>
            <li>{plural(counts.forms, "registration form")}</li>
          </ul>
          <label className="field">
            <span>Type the event name to confirm</span>
            <input
              autoComplete="off"
              disabled={busy}
              onChange={(event) => onTyped(event.target.value)}
              placeholder={eventName}
              value={typed}
            />
          </label>
        </>
      )}
    </ConfirmDialog>
  );
}
