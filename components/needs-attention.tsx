import { AlertTriangle, CheckCircle2 } from "lucide-react";

/**
 * "Needs attention" status (#743): an icon and bold text, never colour alone.
 * `label` lets a caller say what needs it ("2 need attention").
 */
export function NeedsAttention({ label = "Needs attention", className = "" }: { label?: string; className?: string }) {
  return (
    <span className={`needs-attention ${className}`.trim()}>
      <AlertTriangle aria-hidden="true" size={14} />
      <strong>{label}</strong>
    </span>
  );
}

/** The matching "done" status, also an icon plus text. */
export function StatusComplete({ label = "Complete" }: { label?: string }) {
  return (
    <span className="status-complete">
      <CheckCircle2 aria-hidden="true" size={14} />
      <span>{label}</span>
    </span>
  );
}
