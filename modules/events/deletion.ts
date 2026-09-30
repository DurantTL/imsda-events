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

/** Payment history is removed from this system; the card processor keeps its own. */
export function eventDeletionHasRealMoney(counts: Pick<EventDeletionCounts, "realPayments" | "invoices">) {
  return counts.realPayments > 0 || counts.invoices > 0;
}

/**
 * A draft is an event nobody has used: unpublished, with no registrations and
 * no payments. An unpublished event that has been through testing is not a
 * draft, so its removal stays with system administrators.
 */
export function isDraftForDeletion(facts: EventDeletionFacts) {
  return !facts.isPublished && facts.counts.registrations === 0 && facts.counts.payments === 0;
}

export type EventDeletionDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * A system administrator may delete any event. An Event Admin may delete a
 * draft event they administer; everything else is system admin only. Staff
 * with other roles can never delete.
 */
export function decideEventDeletion(actor: EventDeletionActor, facts: EventDeletionFacts): EventDeletionDecision {
  if (actor.globalRole === "SYSTEM_ADMIN") return { allowed: true };
  if (actor.eventRole !== "EVENT_ADMIN") {
    return { allowed: false, reason: "Only a system administrator or the event's administrator can delete an event." };
  }
  if (!isDraftForDeletion(facts)) {
    return {
      allowed: false,
      reason: "Only a system administrator can delete an event that is published or already has registrations or payments.",
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
