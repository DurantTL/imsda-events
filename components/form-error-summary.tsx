"use client";

import { AlertTriangle } from "lucide-react";
import { forwardRef, type MouseEvent } from "react";

export type ErrorSummaryItem = {
  /** Where the link goes: the id of the control (or its card) with the problem. */
  targetId: string | null;
  /** The message, already naming the attendee or session it is about. */
  message: string;
};

/** "1 problem to fix" / "3 problems to fix", the heading of the summary. */
export function errorSummaryHeading(count: number) {
  return `${count} ${count === 1 ? "problem" : "problems"} to fix. Your answers are kept.`;
}

/**
 * The linked summary at the top of a long form (#743). The caller focuses it
 * after a failed submit, each item links to its control, and an item's message
 * names whose answer it is about.
 */
export const FormErrorSummary = forwardRef<HTMLDivElement, {
  heading?: string;
  items: ErrorSummaryItem[];
  className?: string;
  onFollow?: (event: MouseEvent<HTMLAnchorElement>, item: ErrorSummaryItem, index: number) => void;
}>(function FormErrorSummary({ heading, items, className = "form-error-summary", onFollow }, ref) {
  return (
    <div className={className} ref={ref} role="alert" tabIndex={-1}>
      <strong><AlertTriangle aria-hidden="true" size={16} /> {heading ?? (items.length > 0 ? errorSummaryHeading(items.length) : "Review the highlighted fields.")}</strong>
      {items.length > 0 && (
        <ul>
          {items.map((item, index) => (
            <li key={`${item.targetId ?? "general"}_${index}`}>
              {item.targetId
                ? <a href={`#${item.targetId}`} onClick={(event) => onFollow?.(event, item, index)}>{item.message}</a>
                : item.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});
