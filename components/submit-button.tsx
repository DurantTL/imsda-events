"use client";

import { LoaderCircle } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * What a primary submit button shows (#743). While the request is in flight the
 * label becomes "Submitting…" (or the caller's own in-flight wording), a spinner
 * appears, and the button is disabled and marked busy so a second tap cannot send
 * the form twice. When the request fails the caller sets `submitting` back to
 * false: the button re-enables with its normal label, and the answers it was
 * submitting are still in the form.
 */
export function submitButtonState({
  submitting,
  disabled = false,
  label,
  submittingLabel = "Submitting…",
}: {
  submitting: boolean;
  disabled?: boolean;
  label: string;
  submittingLabel?: string;
}) {
  return {
    label: submitting ? submittingLabel : label,
    disabled: submitting || disabled,
    ariaBusy: submitting,
    showSpinner: submitting,
  };
}

export type SubmitButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type" | "children"> & {
  submitting: boolean;
  /** The resting label, such as "Submit registration". */
  label: string;
  /** The in-flight label. Defaults to "Submitting…"; saves use "Saving…". */
  submittingLabel?: string;
  /** An icon shown beside the resting label; the spinner replaces it while submitting. */
  icon?: ReactNode;
  iconSize?: number;
};

export function SubmitButton({
  submitting,
  label,
  submittingLabel,
  icon,
  iconSize = 17,
  disabled,
  className = "primary-button",
  ...rest
}: SubmitButtonProps) {
  const state = submitButtonState({ submitting, disabled, label, submittingLabel });
  return (
    <button {...rest} aria-busy={state.ariaBusy || undefined} className={className} disabled={state.disabled} type="submit">
      {state.showSpinner
        ? <LoaderCircle aria-hidden="true" className="submit-button-spinner is-spinning" size={iconSize} />
        : icon}
      {state.label}
    </button>
  );
}
