"use client";

import { useId } from "react";
import { X } from "lucide-react";
import { useAccessibleDialog } from "@/components/use-accessible-dialog";

/**
 * A reusable, accessible in-page confirmation dialog (#466), for actions
 * consequential enough to need a deliberate confirm step: what's about to
 * happen, an inline error if the confirmed action fails, and a busy state
 * while it runs. Used in place of `window.confirm()`, which iOS Safari can
 * silently fail to show at all — no popup, no error. Escape, the backdrop,
 * the X and Cancel all cancel, but never mid-request, so a failure that
 * arrives after the request is always shown in the open dialog; focus returns to whatever opened it
 * when it's cancelled, via `useAccessibleDialog`.
 *
 * Generic so #471 and #472 can reuse it for their own high-consequence
 * confirmations: `children` is the dialog's own body (a summary of what's
 * about to happen), `destructive` swaps the confirm button's styling for a
 * dangerous action, and `onConfirm` runs the caller's own async work.
 */
/** Escape runs through here too, so a request in flight can't be dismissed and its error lost. */
export function cancelUnlessBusy(busy: boolean, onCancel: () => void) {
  if (!busy) onCancel();
}

export function ConfirmDialog({
  busy = false,
  busyLabel,
  cancelLabel = "Cancel",
  children,
  confirmLabel,
  destructive = false,
  error = "",
  onCancel,
  onConfirm,
  open,
  title,
}: {
  busy?: boolean;
  busyLabel?: string;
  cancelLabel?: string;
  children: React.ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
  open: boolean;
  title: string;
}) {
  const titleId = useId();
  const dialogRef = useAccessibleDialog<HTMLElement>(open, () => cancelUnlessBusy(busy, onCancel));
  if (!open) return null;

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}
      role="presentation"
    >
      <section aria-labelledby={titleId} aria-modal="true" className="modal-card confirm-dialog" ref={dialogRef} role="dialog" tabIndex={-1}>
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button aria-label="Cancel" className="icon-button modal-close-button" disabled={busy} onClick={onCancel} type="button">
            <X aria-hidden="true" size={18} />
          </button>
        </div>
        <div className="confirm-dialog-body">{children}</div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions">
          <button className="secondary-button" disabled={busy} onClick={onCancel} type="button">{cancelLabel}</button>
          <button
            className={destructive ? "primary-button lifecycle-danger-button" : "primary-button"}
            disabled={busy}
            onClick={onConfirm}
            type="button"
          >
            {busy ? (busyLabel ?? confirmLabel) : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
