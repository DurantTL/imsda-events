import { AlertTriangle, Lightbulb, OctagonAlert } from "lucide-react";
import type { SendCheckFinding, SendCheckResult, SendCheckSeverity } from "@/modules/communications/send-check";

const GROUPS: ReadonlyArray<{ severity: SendCheckSeverity; key: keyof Pick<SendCheckResult, "errors" | "warnings" | "suggestions">; title: string; hint: string }> = [
  { severity: "error", key: "errors", title: "Errors", hint: "Fix these before publishing or sending." },
  { severity: "warning", key: "warnings", title: "Warnings", hint: "You can still send, after you acknowledge them." },
  { severity: "suggestion", key: "suggestions", title: "Suggestions", hint: "Optional. They never stop a send." },
];

/** One sentence that says where the check stands, for the heading and for tests. */
export function sendCheckSummary(result: SendCheckResult) {
  if (result.errors.length === 0 && result.warnings.length === 0 && result.suggestions.length === 0) {
    return "No problems found.";
  }
  const parts: string[] = [];
  if (result.errors.length) parts.push(`${result.errors.length} error${result.errors.length === 1 ? "" : "s"}`);
  if (result.warnings.length) parts.push(`${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}`);
  if (result.suggestions.length) parts.push(`${result.suggestions.length} suggestion${result.suggestions.length === 1 ? "" : "s"}`);
  return parts.join(", ");
}

/** Moves focus to the form field a finding points at. Returns false when it is not on the page. */
export function jumpToSendCheckField(anchor: string | null) {
  if (!anchor || typeof document === "undefined") return false;
  const target = document.getElementById(anchor);
  if (!target) return false;
  target.scrollIntoView({ block: "center" });
  // The rich-text body is a contenteditable inside the field's wrapper; focus the editable part when there is one.
  const editable = target.matches("input, textarea, select, [contenteditable='true']")
    ? target
    : target.querySelector<HTMLElement>("[contenteditable='true'], input, textarea, select");
  (editable ?? target).focus({ preventScroll: true });
  return true;
}

function SeverityIcon({ severity }: { severity: SendCheckSeverity }) {
  if (severity === "error") return <OctagonAlert size={16} aria-hidden="true" />;
  if (severity === "warning") return <AlertTriangle size={16} aria-hidden="true" />;
  return <Lightbulb size={16} aria-hidden="true" />;
}

/**
 * The send check's findings (#836), grouped by severity. Each one with a field anchor has a "Go to" button that
 * moves focus to the field to fix; with `onJump` omitted (the review dialog, where the text can no longer be edited)
 * the findings are listed without it. Severity is always written out, never carried by colour alone.
 */
export function SendCheckPanel({
  result,
  idPrefix,
  onJump,
  fieldLabels = { subject: "subject", body: "message", preheader: "preview line" },
}: {
  result: SendCheckResult;
  idPrefix: string;
  onJump?: (finding: SendCheckFinding) => void;
  fieldLabels?: Record<SendCheckFinding["field"], string>;
}) {
  const headingId = `${idPrefix}-send-check-title`;
  return (
    <section className="send-check" aria-labelledby={headingId} data-has-errors={result.hasErrors ? "true" : "false"}>
      <h3 id={headingId}>Send check <span className="send-check-summary">{sendCheckSummary(result)}</span></h3>
      {GROUPS.map((group) => {
        const findings = result[group.key];
        if (findings.length === 0) return null;
        return (
          <div className={`send-check-group ${group.severity}`} key={group.severity}>
            <p className="send-check-group-title">
              <SeverityIcon severity={group.severity} />
              <strong>{group.title} ({findings.length})</strong>
              <span>{group.hint}</span>
            </p>
            <ul>
              {findings.map((finding) => (
                <li key={finding.id}>
                  <span className="send-check-message">{finding.message}</span>
                  {onJump && finding.anchor && (
                    <button type="button" className="send-check-jump" onClick={() => onJump(finding)}>
                      Go to {fieldLabels[finding.field]}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
