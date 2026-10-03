import { AlertCircle } from "lucide-react";
import type { ReactNode } from "react";

/**
 * An actionable field error (#743): an icon plus the text, so the error is not
 * carried by colour alone. Point the control's `aria-describedby` at `id` and set
 * `aria-invalid` on the control; `fieldErrorProps` does both.
 */
export function FieldError({ id, children, className = "field-error-message" }: { id: string; children?: ReactNode; className?: string }) {
  if (!children) return null;
  return (
    <small className={className} id={id}>
      <AlertCircle aria-hidden="true" size={14} />
      <span>{children}</span>
    </small>
  );
}

/** `aria-invalid` and `aria-describedby` for a control, joined with any help text id. */
export function fieldErrorProps(errorId: string, message: string | undefined | null, helpId?: string) {
  return {
    "aria-invalid": message ? (true as const) : undefined,
    "aria-describedby": [helpId, message ? errorId : ""].filter(Boolean).join(" ") || undefined,
  };
}
