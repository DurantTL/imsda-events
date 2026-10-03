"use client";

import { useEffect, useId, useRef, useState } from "react";

/** Text longer than this reads as a "Read more" candidate (#743). Shorter text is shown whole. */
export const EXPANDABLE_TEXT_THRESHOLD = 140;

export function isLongText(text: string, threshold = EXPANDABLE_TEXT_THRESHOLD) {
  return text.trim().length > threshold || text.includes("\n");
}

/**
 * Whether a clamped element really overflows (its text needs more than the clamp).
 * Null until measured, so the server render and first paint fall back to the
 * character rule; it re-measures when the width changes.
 */
function useClampOverflow<T extends HTMLElement>(ref: { current: T | null }, clamped: boolean) {
  const [overflowing, setOverflowing] = useState<boolean | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || !clamped || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setOverflowing(element.scrollHeight > element.clientHeight + 1));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, clamped]);
  return overflowing;
}

/**
 * A description that shows its first two lines and a "Read more" button (#743).
 * The whole text stays in the page (it is only clamped visually), so screen
 * readers and find-in-page still reach it. Short text renders as is. Not for
 * use inside a <label>, where a button is not valid: see ExpandableOptionDescription.
 */
export function ExpandableText({
  text,
  className = "",
  threshold,
  moreLabel = "Read more",
  lessLabel = "Show less",
}: {
  text: string;
  className?: string;
  threshold?: number;
  moreLabel?: string;
  lessLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const bodyRef = useRef<HTMLParagraphElement>(null);
  const long = isLongText(text, threshold);
  const overflowing = useClampOverflow(bodyRef, long && !open);
  if (!long) return <p className={className}>{text}</p>;
  return (
    <div className="expandable-text">
      <p id={id} ref={bodyRef} className={`${className} expandable-text-body${open ? "" : " is-clamped"}`.trim()}>{text}</p>
      {(open || overflowing !== false) && (
        <button type="button" className="expandable-text-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((current) => !current)}>
          {open ? lessLabel : moreLabel}
        </button>
      )}
    </div>
  );
}

/**
 * A choice's description (an attendee type, a seminar, a meal): clamped to two
 * lines with a "Read more" button beside the choice, not inside its <label>.
 * `renderChoice` draws the usual label and receives the description node, so the
 * radio or checkbox keeps its markup, name and checked state. A short
 * description renders in place with no extra wrapper.
 */
export function ExpandableOptionDescription({
  text,
  renderChoice,
}: {
  text: string;
  renderChoice: (description: React.ReactNode) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const bodyRef = useRef<HTMLElement>(null);
  const long = isLongText(text);
  const overflowing = useClampOverflow(bodyRef, long && !open);
  if (!text) return <>{renderChoice(null)}</>;
  if (!isLongText(text)) return <>{renderChoice(<small className="public-registration-option-description">{text}</small>)}</>;
  return (
    <div className="public-registration-option-item">
      {renderChoice(<small id={id} ref={bodyRef} className={`public-registration-option-description expandable-text-body${open ? "" : " is-clamped"}`}>{text}</small>)}
      {(open || overflowing !== false) && (
        <button type="button" className="expandable-text-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((current) => !current)}>
          {open ? "Show less" : "Read more"}
        </button>
      )}
    </div>
  );
}
