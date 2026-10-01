/**
 * Deleting an event at any stage (#620): the pure rules, kept free of the
 * database so they are unit-tested on their own. `deletion-repository.ts`
 * gathers the facts and performs the removal.
 */

export type EventDeletionCounts = {
  registrations: number;
  attendees: number;
  payments: number;
  invoices: number;
  honorEnrollments: number;
  locations: number;
  forms: number;
  messages: number;
  /** Outbound emails that had not gone out yet; cancelled by the deletion. */
  queuedMessages: number;
  /** Registration form submissions (public and club) that came through the forms. */
  formSubmissions: number;
  /** Data import runs recorded against the event. */
  imports: number;
  merchandiseOrders: number;
  /** Club-entered registration drafts (guests, responses, honor selections, roster ages). */
  clubRegistrationDrafts: number;
  communityPosts: number;
  announcements: number;
  /** Succeeded payments that are not sandbox (test-mode) card payments. */
  realPayments: number;
};

export type EventDeletionFacts = {
  isPublished: boolean;
  counts: EventDeletionCounts;
};

export type EventDeletionActor = {
  globalRole?: "SYSTEM_ADMIN" | null;
  /** The actor's active role on this event, or null when they have none. */
  eventRole: string | null;
};

function plural(count: number, one: string, many = `${one}s`) {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

/**
 * Everything that makes an event history rather than a mistake (#704). Any one
 * of these blocks deletion for everybody: the schema would cascade through
 * them, but a deletion that silently erases registrations, money or imports
 * is refused instead.
 */
export function eventDeletionBlockers(counts: EventDeletionCounts) {
  const blockers: string[] = [];
  if (counts.registrations > 0) blockers.push(plural(counts.registrations, "registration"));
  if (counts.attendees > 0) blockers.push(plural(counts.attendees, "attendee"));
  if (counts.payments > 0) blockers.push(plural(counts.payments, "payment"));
  if (counts.invoices > 0) blockers.push(plural(counts.invoices, "invoice"));
  if (counts.honorEnrollments > 0) blockers.push(plural(counts.honorEnrollments, "honors enrollment"));
  if (counts.formSubmissions > 0) blockers.push(plural(counts.formSubmissions, "form submission"));
  if (counts.imports > 0) blockers.push(plural(counts.imports, "import run"));
  if (counts.merchandiseOrders > 0) blockers.push(plural(counts.merchandiseOrders, "merchandise order"));
  if (counts.clubRegistrationDrafts > 0) blockers.push(plural(counts.clubRegistrationDrafts, "club registration draft"));
  if (counts.communityPosts > 0) blockers.push(plural(counts.communityPosts, "community post"));
  if (counts.announcements > 0) blockers.push(plural(counts.announcements, "announcement"));
  if (counts.messages > 0) blockers.push(plural(counts.messages, "message"));
  return blockers;
}

export type EventDeletionDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * Only a system administrator may delete an event, and only one with nothing
 * attached: no registrations, payments, invoices, imports, form submissions or
 * other dependent records. Anything else is refused with the reason, and the
 * event is unpublished instead.
 */
export function decideEventDeletion(actor: EventDeletionActor, facts: EventDeletionFacts): EventDeletionDecision {
  if (actor.globalRole !== "SYSTEM_ADMIN") {
    return { allowed: false, reason: "Only a system administrator can delete an event." };
  }
  const blockers = eventDeletionBlockers(facts.counts);
  if (blockers.length > 0) {
    return {
      allowed: false,
      reason: `This event cannot be deleted because it has ${blockers.join(", ")}. Only an event with nothing attached (a test or duplicate event) can be deleted. Unpublish it instead to take it off the public site and keep its records.`,
    };
  }
  return { allowed: true };
}

/** The confirmation is the event's exact name; only surrounding whitespace is forgiven. */
export function eventNameConfirmed(eventName: string, typed: string) {
  return typed.trim() === eventName.trim() && eventName.trim().length > 0;
}

/** What the audit row keeps: identifiers, dates and counts, never attendee data. */
export type EventDeletionAuditMetadata = {
  eventId: string;
  name: string;
  startsAt: string;
  endsAt: string;
  wasPublished: boolean;
  counts: EventDeletionCounts;
};

/** Every deletion runs in one interactive transaction; this outlasts the 5 s default. */
export const EVENT_DELETION_TRANSACTION_TIMEOUT_MS = 120_000;
export const EVENT_DELETION_TRANSACTION_MAX_WAIT_MS = 10_000;
