"use client";

import { ConfirmDialog } from "@/components/confirm-dialog";

/**
 * Unpublishing an event is its own action (#471), never a side effect of
 * saving event settings: this dialog names the event and states the one
 * consequence in full — every public registration form closes immediately.
 * Built on the shared `ConfirmDialog` (#466) so it gets the same accessible
 * modal behavior and busy guard as every other high-consequence confirm.
 */
export function UnpublishEventDialog({
  busy,
  eventName,
  error,
  onCancel,
  onConfirm,
  open,
}: {
  busy: boolean;
  eventName: string;
  error: string;
  onCancel: () => void;
  onConfirm: () => void;
  open: boolean;
}) {
  return (
    <ConfirmDialog
      busy={busy}
      busyLabel="Unpublishing…"
      confirmLabel="Unpublish event"
      destructive
      error={error}
      onCancel={onCancel}
      onConfirm={onConfirm}
      open={open}
      title={`Unpublish ${eventName}?`}
    >
      <p>
        Every public registration form for <strong translate="no">{eventName}</strong> closes
        immediately. Anyone with the link sees the event as unavailable until it is published
        again. Registrations already submitted are not affected.
      </p>
    </ConfirmDialog>
  );
}
