"use client";

import { ConfirmDialog } from "@/components/confirm-dialog";

/**
 * Publishing an event (#571 F-20) asks for the same deliberate confirmation as
 * unpublishing (#471): the dialog names the event and states the consequence,
 * that its public registration links turn on. Built on the shared
 * `ConfirmDialog` (#466).
 */
export function PublishEventDialog({
  busy,
  eventName,
  error,
  onCancel,
  onConfirm,
  open,
  warnings = [],
}: {
  busy: boolean;
  eventName: string;
  error: string;
  onCancel: () => void;
  onConfirm: () => void;
  open: boolean;
  /** Non-blocking notes, such as an event whose dates have passed (#575). */
  warnings?: string[];
}) {
  return (
    <ConfirmDialog
      busy={busy}
      busyLabel="Publishing…"
      confirmLabel="Publish event"
      error={error}
      onCancel={onCancel}
      onConfirm={onConfirm}
      open={open}
      title={`Publish ${eventName}?`}
    >
      <p>
        Publishing turns on the public registration links for <strong translate="no">{eventName}</strong>.
        Anyone with a link can see the event, and attendees can register whenever a registration form
        is open. You can unpublish at any time to close every public form.
      </p>
      {warnings.map((warning) => (
        <p className="inline-notice clone-warning" key={warning} role="status">{warning}</p>
      ))}
    </ConfirmDialog>
  );
}
