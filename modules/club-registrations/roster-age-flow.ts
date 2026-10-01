/**
 * The small decisions behind the "Age on event date" field and the Continue
 * button (#718), kept as plain functions so they can be tested without a DOM.
 */

/** A problem shows only once Continue was blocked (`attempted`) or the field was touched and left. */
export function shownAgeError(error: string | null, attempted: boolean, touched: boolean): string | null {
  return error !== null && (attempted || touched) ? error : null;
}

/**
 * What the Continue button says. Missing ages are only the headline when
 * nothing else disables the button (for example no location chosen yet).
 */
export function continueButtonLabel(input: { missingAges: number; goingCount: number; otherwiseDisabled: boolean }): string {
  const { missingAges, goingCount, otherwiseDisabled } = input;
  if (missingAges > 0 && !otherwiseDisabled) {
    return missingAges === 1 ? "Enter 1 age to continue" : `Enter ${missingAges} ages to continue`;
  }
  return `Continue with ${goingCount} ${goingCount === 1 ? "person" : "people"}`;
}

type FocusTarget = {
  scrollIntoView: (options: { block: "center" }) => void;
  focus: (options: { preventScroll: true }) => void;
};

/** Scrolls to and focuses the first missing age input; false when there is none. */
export function focusFirstMissingAge(
  firstMissingInputId: string | null,
  find: (id: string) => FocusTarget | null,
): boolean {
  if (!firstMissingInputId) return false;
  const input = find(firstMissingInputId);
  if (!input) return false;
  input.scrollIntoView({ block: "center" });
  input.focus({ preventScroll: true });
  return true;
}

/** Saves the draft, then goes to `href`. A failed save leaves the page in place and reports it. */
export async function leaveAfterSave(options: {
  flush: () => Promise<boolean>;
  push: (href: string) => void;
  onUnsaved: (href: string) => void;
  href: string;
}): Promise<boolean> {
  const saved = await options.flush();
  if (saved) options.push(options.href);
  else options.onUnsaved(options.href);
  return saved;
}
