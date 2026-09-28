"use client";

import { X } from "lucide-react";
import { useAccessibleDialog } from "@/components/use-accessible-dialog";

/**
 * Before a form's first publish, asks staff whether to move its web address
 * to match a renamed title or keep the current one (#476). A failed update
 * is shown inside the dialog, since the page behind it is inert while the
 * dialog is open.
 */
export function FormSlugDialog({ open, eventSlug, currentSlug, offeredSlug, error, busy, onKeep, onUpdate, onCancel }: {
  open: boolean;
  eventSlug: string;
  currentSlug: string;
  offeredSlug: string;
  error: string;
  busy: boolean;
  onKeep: () => void;
  onUpdate: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useAccessibleDialog<HTMLElement>(open, () => {
    if (!busy) onCancel();
  });
  if (!open) return null;
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
    <section className="modal-card confirm-import-modal" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="slug-sync-title" tabIndex={-1}>
      <div className="modal-head"><div><p className="eyebrow">Web address</p><h2 id="slug-sync-title">This form&rsquo;s title changed</h2></div><button className="icon-button" type="button" aria-label="Close dialog" disabled={busy} onClick={onCancel}><X size={18} /></button></div>
      <p className="confirm-copy">Update the web address to <code>/register/{eventSlug}/{offeredSlug}</code>, or keep <code>/register/{eventSlug}/{currentSlug}</code>. This is the only chance to change it automatically — once this form is first published, shared links depend on its address staying put.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="form-actions"><button className="secondary-button" type="button" disabled={busy} onClick={onKeep}>Keep {currentSlug}</button><button className="primary-button" type="button" disabled={busy} onClick={onUpdate}>{busy ? "Updating…" : `Update to ${offeredSlug}`}</button></div>
    </section>
  </div>;
}
