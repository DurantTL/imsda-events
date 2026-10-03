/**
 * Wording for confirmations of destructive or bulk actions (#743). A
 * confirmation names the exact object and the consequence, and its action label
 * says what the button does ("Delete Women's Retreat 2027"), never "OK".
 */

function clean(value: string, fallback: string) {
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed || fallback;
}

/** A button label that names its object, such as "Delete Women's Retreat 2027". */
export function namedActionLabel(verb: string, objectName: string, fallbackObject = "this item") {
  return `${verb} ${clean(objectName, fallbackObject)}`;
}

function countPhrase(count: number, singular: string, plural: string) {
  return `${count.toLocaleString("en-US")} ${count === 1 ? singular : plural}`;
}

/**
 * The count and scope a bulk action will touch, shown before it is confirmed:
 * "3 people in the Eagle Club roster". Nothing is applied until the person
 * confirms this sentence.
 */
export function bulkScopeSummary({
  count,
  singular,
  plural = `${singular}s`,
  scope,
}: {
  count: number;
  singular: string;
  plural?: string;
  /** Where they come from, such as "the Eagle Club roster". Omitted when the count says it all. */
  scope?: string;
}) {
  const base = countPhrase(count, singular, plural);
  return scope ? `${base} in ${scope}` : base;
}

export type RegistrationLifecycleAction = "cancel" | "reactivate" | "waitlist" | "promote";

const lifecycleLabels: Record<RegistrationLifecycleAction, (holder: string) => string> = {
  cancel: (holder) => `Cancel registration for ${holder}`,
  reactivate: (holder) => `Reactivate registration for ${holder}`,
  waitlist: (holder) => `Move ${holder} to the waitlist`,
  promote: (holder) => `Promote ${holder} from the waitlist`,
};

/** The confirm button label for a registration status change, naming whose registration it is. */
export function registrationLifecycleLabel(action: RegistrationLifecycleAction, holderName: string) {
  return lifecycleLabels[action](clean(holderName, "this registration"));
}

/** "2 attendees" or "1 attendee", for the consequence line of a registration action. */
export function attendeeCountPhrase(count: number) {
  return countPhrase(count, "attendee", "attendees");
}

/**
 * Promote and Reactivate are the filled primary of a registration's action row
 * only when "Edit choices & attendees" is not offered (a roster-less form);
 * otherwise Edit is the one filled button (#743).
 */
export function lifecycleActionButtonClass(rosterEditOffered: boolean) {
  return rosterEditOffered ? "secondary-button" : "primary-button";
}
