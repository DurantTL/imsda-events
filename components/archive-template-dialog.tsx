"use client";

import { ConfirmDialog } from "@/components/confirm-dialog";

/** The shared confirmation both the template list and the template editor put in front of Archive (#704). */
export function ArchiveTemplateDialog({
  busy,
  error,
  name,
  onCancel,
  onConfirm,
  open,
}: {
  busy: boolean;
  error: string;
  name: string;
  onCancel: () => void;
  onConfirm: () => void;
  open: boolean;
}) {
  return (
    <ConfirmDialog
      busy={busy}
      busyLabel="Archiving…"
      confirmLabel="Archive template"
      destructive
      error={error}
      onCancel={onCancel}
      onConfirm={onConfirm}
      open={open}
      title={name ? `Archive ${name}?` : "Archive this template?"}
    >
      <p>
        An archived template no longer appears in “Start from template” and cannot be edited or published. Events already
        created from it are not affected. A system administrator can unarchive it later.
      </p>
    </ConfirmDialog>
  );
}
