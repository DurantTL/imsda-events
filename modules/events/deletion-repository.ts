import { Prisma } from "@prisma/client";
import { logError } from "@/lib/logger";
import { getPrisma } from "@/lib/prisma";
import { isDeadlockError, isLockTimeoutError } from "@/lib/prisma-errors";
import { currentCorrelationId } from "@/lib/request-context";
import type { EventRole } from "@/modules/access/permissions";
import {
  EVENT_DELETION_TRANSACTION_MAX_WAIT_MS,
  EVENT_DELETION_TRANSACTION_TIMEOUT_MS,
  decideEventDeletion,
  eventNameConfirmed,
  type EventDeletionAuditMetadata,
  type EventDeletionCounts,
  type EventDeletionFacts,
} from "@/modules/events/deletion";

export class EventDeletionError extends Error {
  constructor(
    public readonly code:
      | "EVENT_NOT_FOUND"
      | "EVENT_DELETE_FORBIDDEN"
      | "EVENT_NAME_MISMATCH"
      | "EVENT_BUSY"
      | "EVENT_DELETE_TIMEOUT",
    message: string,
  ) {
    super(message);
    this.name = "EventDeletionError";
  }
}

type Db = Prisma.TransactionClient;

async function loadDeletionFacts(db: Db, eventId: string) {
  const event = await db.event.findUnique({
    where: { id: eventId },
    select: { id: true, name: true, startsAt: true, endsAt: true, isPublished: true, billingMode: true },
  });
  if (!event) return null;
  const inEvent = { eventId };
  const [
    registrations,
    attendees,
    payments,
    realPayments,
    invoices,
    honorEnrollments,
    locations,
    forms,
    messages,
    queuedMessages,
    formSubmissions,
    imports,
    merchandiseOrders,
    clubRegistrationDrafts,
    communityPosts,
    announcements,
  ] = await Promise.all([
    db.registration.count({ where: inEvent }),
    db.registrationAttendee.count({ where: inEvent }),
    db.payment.count({ where: inEvent }),
    // Sandbox card payments are test money. Everything else that succeeded
    // (cash, checks, manual entries, production card payments) is real.
    db.payment.count({
      where: { eventId, status: "SUCCEEDED", NOT: { paymentAttempt: { is: { environment: "sandbox" } } } },
    }),
    // Organization-billed events invoice each club's submitted registration later.
    event.billingMode === "DEFERRED_ORGANIZATION_INVOICE"
      ? db.clubEventRegistration.count({
          where: { eventId, registration: { status: { in: ["SUBMITTED", "CONFIRMED"] } } },
        })
      : Promise.resolve(0),
    db.honorEnrollment.count({ where: inEvent }),
    db.eventLocation.count({ where: inEvent }),
    db.registrationForm.count({ where: inEvent }),
    db.messageOutbox.count({ where: inEvent }),
    db.messageOutbox.count({ where: { eventId, status: { in: ["PENDING", "PROCESSING"] } } }),
    db.publicRegistrationSubmission.count({ where: inEvent }),
    db.importRun.count({ where: inEvent }),
    db.merchandiseOrder.count({ where: inEvent }),
    db.clubRegistrationDraft.count({ where: inEvent }),
    db.communityPost.count({ where: inEvent }),
    db.announcement.count({ where: inEvent }),
  ]);
  const counts: EventDeletionCounts = {
    registrations,
    attendees,
    payments,
    invoices,
    honorEnrollments,
    locations,
    forms,
    messages,
    queuedMessages,
    formSubmissions,
    imports,
    merchandiseOrders,
    clubRegistrationDrafts,
    communityPosts,
    announcements,
    realPayments,
  };
  return { event, facts: { isPublished: event.isPublished, counts } satisfies EventDeletionFacts };
}

/**
 * Prisma's interactive-transaction errors (P2028). "Unable to start a
 * transaction in the given time" is the maxWait: nothing ran, so the event was
 * only busy. Any other P2028 is the transaction outliving its deadline; the
 * rollback removed nothing, but a retry will likely take as long.
 */
function isTransactionStartTimeout(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2028" && /start a transaction/i.test(error.message);
}

function isTransactionDeadlineExceeded(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2028" && !isTransactionStartTimeout(error);
}

export type EventDeletionActorInput = { userId: string; globalRole?: "SYSTEM_ADMIN" | null };

async function actorEventRole(db: Db, actor: EventDeletionActorInput, eventId: string): Promise<EventRole | null> {
  if (actor.globalRole === "SYSTEM_ADMIN") return null;
  const membership = await db.eventMembership.findUnique({
    where: { eventId_userId: { eventId, userId: actor.userId } },
    select: { role: true, status: true },
  });
  return membership && membership.status === "ACTIVE" ? membership.role : null;
}

/** What deleting the event would remove, and whether this actor may do it. */
export async function getEventDeletionPreview(eventId: string, actor: EventDeletionActorInput) {
  const db = getPrisma();
  const loaded = await loadDeletionFacts(db, eventId);
  if (!loaded) return null;
  const decision = decideEventDeletion(
    { globalRole: actor.globalRole, eventRole: await actorEventRole(db, actor, eventId) },
    loaded.facts,
  );
  return {
    eventId,
    name: loaded.event.name,
    isPublished: loaded.facts.isPublished,
    counts: loaded.facts.counts,
    decision,
  };
}

/**
 * Deletes an event and everything it owns in one transaction, in dependency
 * order, so nothing is left orphaned. People, accounts, clubs, background
 * checks and every other record shared with other events are kept.
 *
 * Order matters for two reasons. Several foreign keys inside an event are
 * RESTRICT (a location cannot go while a registration uses it; a template
 * version cannot go while a message points at it), and PostgreSQL checks
 * RESTRICT immediately, even for a row that is itself about to be cascaded.
 * So each referencing side is removed first. And a few keys are SET NULL
 * (webhook records, provider events); those rows would otherwise survive with
 * no owner, so they are deleted explicitly.
 *
 * The transaction gets an explicit long timeout instead of Prisma's 5 s
 * default, and takes a row lock on the event so no registration or payment can
 * slip in between the counts and the delete.
 */
export async function deleteEvent(input: {
  eventId: string;
  actor: EventDeletionActorInput;
  confirmName: string;
}) {
  const prisma = getPrisma();
  try {
    const result = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '10s'");
        // FOR UPDATE conflicts with the FOR KEY SHARE lock every insert of a
        // child row takes on the event, so writers wait, then fail on the FK.
        await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${input.eventId} FOR UPDATE`;
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = 0");

        const loaded = await loadDeletionFacts(tx, input.eventId);
        if (!loaded) throw new EventDeletionError("EVENT_NOT_FOUND", "That event no longer exists.");
        const { event, facts } = loaded;

        const decision = decideEventDeletion(
          { globalRole: input.actor.globalRole, eventRole: await actorEventRole(tx, input.actor, input.eventId) },
          facts,
        );
        if (!decision.allowed) throw new EventDeletionError("EVENT_DELETE_FORBIDDEN", decision.reason);
        if (!eventNameConfirmed(event.name, input.confirmName)) {
          throw new EventDeletionError("EVENT_NAME_MISMATCH", "Type the event's exact name to confirm the deletion.");
        }

        // Lets the two append-only ledger tables accept this transaction's deletes (see the migration).
        await tx.$executeRaw`SELECT set_config('imsda.event_deletion', 'on', true)`;

        const storageKeys = (await tx.eventAsset.findMany({ where: { eventId: input.eventId }, select: { storageKey: true } }))
          .map((asset) => asset.storageKey);
        await removeEventOwnedRows(tx, input.eventId);

        // The event's own audit history is kept (its eventId becomes null when
        // the event goes). This row records the deletion itself, with counts
        // and dates only.
        const metadata: EventDeletionAuditMetadata = {
          eventId: event.id,
          name: event.name,
          startsAt: event.startsAt.toISOString(),
          endsAt: event.endsAt.toISOString(),
          wasPublished: facts.isPublished,
          counts: facts.counts,
        };
        await tx.auditLog.create({
          data: {
            actorUserId: input.actor.userId,
            action: "EVENT_DELETED",
            entityType: "Event",
            entityId: event.id,
            correlationId: currentCorrelationId() ?? crypto.randomUUID(),
            summary: `Deleted event: ${event.name}.`,
            metadata: metadata as unknown as Prisma.InputJsonValue,
          },
        });
        return { eventId: event.id, name: event.name, counts: facts.counts, storageKeys };
      },
      { timeout: EVENT_DELETION_TRANSACTION_TIMEOUT_MS, maxWait: EVENT_DELETION_TRANSACTION_MAX_WAIT_MS },
    );
    // Uploaded files go only after the rows are committed away. A file that
    // cannot be removed is logged, never a reason to report the deletion failed.
    if (result.storageKeys.length > 0) {
      const { deleteAsset } = await import("@/modules/events/asset-storage");
      for (const key of result.storageKeys) {
        try { await deleteAsset(key); } catch (error) { logError("Deleted event's uploaded file could not be removed", error); }
      }
    }
    return { eventId: result.eventId, name: result.name, counts: result.counts };
  } catch (error) {
    if (isTransactionDeadlineExceeded(error)) {
      throw new EventDeletionError("EVENT_DELETE_TIMEOUT", "Deleting this event took too long and nothing was removed. Contact support.");
    }
    if (isLockTimeoutError(error) || isDeadlockError(error) || isTransactionStartTimeout(error)) {
      throw new EventDeletionError("EVENT_BUSY", "The event is busy with other changes. Try again in a moment.");
    }
    throw error;
  }
}

/** Removes the event's rows, leaves shared records alone, and deletes the event last. */
async function removeEventOwnedRows(tx: Db, eventId: string) {
  const inEvent = { eventId };

  // 1. Outbound email: cancel what has not gone out, then remove the rows.
  //    Message rows must go before template versions (RESTRICT).
  await tx.messageOutbox.updateMany({
    where: { eventId, status: { in: ["PENDING", "PROCESSING"] } },
    data: { status: "CANCELLED" },
  });
  // Provider events (delivery webhooks, which carry the recipient's address in
  // their payload) go with their messages. They are matched by the outbox rows'
  // provider ids as well as the link, in one statement with a subquery so a large
  // event cannot hit bind-parameter limits. Best effort against concurrency: a
  // webhook committing between this statement and the transaction's end is not
  // seen, and is stored without a message (with the recipient stripped).
  await tx.$executeRaw`
    DELETE FROM "MessageProviderEvent"
    WHERE "messageOutboxId" IN (SELECT "id" FROM "MessageOutbox" WHERE "eventId" = ${eventId})
       OR ("provider" = 'RESEND' AND "providerMessageId" IN (
            SELECT "providerMessageId" FROM "MessageOutbox" WHERE "eventId" = ${eventId} AND "providerMessageId" IS NOT NULL))`;
  await tx.messageOutbox.deleteMany({ where: inEvent });

  // 2. Payment processor bookkeeping, then payments themselves.
  await tx.squareWebhookEvent.deleteMany({ where: inEvent });
  await tx.refund.deleteMany({ where: inEvent });
  await tx.paymentAttempt.deleteMany({ where: inEvent });
  await tx.payment.deleteMany({ where: inEvent });

  // 3. Promo redemptions and adjustments (redemptions RESTRICT the promo code).
  await tx.promoCodeRedemption.deleteMany({ where: inEvent });
  await tx.registrationAdjustment.deleteMany({ where: inEvent });
  await tx.promoCode.deleteMany({ where: inEvent });

  // 4. Merchandise: orders first (lines point at products), then products
  //    (which RESTRICT the artwork asset) and the catalog.
  await tx.merchandiseOrderLine.deleteMany({ where: inEvent });
  await tx.merchandiseOrderStatusChange.deleteMany({ where: inEvent });
  await tx.merchandiseOrder.deleteMany({ where: inEvent });
  await tx.merchandiseProduct.deleteMany({ where: inEvent });
  await tx.merchandiseCatalog.deleteMany({ where: inEvent });

  // 5. Honors: enrollments (RESTRICT their offering), offerings (RESTRICT
  //    session and location), sessions.
  await tx.honorEnrollment.deleteMany({ where: inEvent });
  await tx.honorOffering.deleteMany({ where: inEvent });
  await tx.honorSession.deleteMany({ where: inEvent });

  // 6. Append-only registration ledgers (RESTRICT registration and attendee).
  await tx.registrationOperation.deleteMany({ where: inEvent });
  await tx.registrationPaymentChoiceOperation.deleteMany({ where: inEvent });

  // 7. Forms: capacity reservations and submissions RESTRICT form versions.
  await tx.registrationCapacityReservation.deleteMany({ where: inEvent });
  await tx.publicRegistrationSubmission.deleteMany({ where: inEvent });
  await tx.formTestSubmission.deleteMany({ where: inEvent });

  // 8. Tags and notes on registrations and attendees (assignments RESTRICT tags).
  await tx.attendeeTagAssignment.deleteMany({ where: inEvent });
  await tx.registrationTagAssignment.deleteMany({ where: inEvent });
  await tx.staffNote.deleteMany({ where: inEvent });

  // 9. Shared roster rows may remember which registration created them; the
  //    roster member stays, the pointer to a deleted registration does not.
  await tx.$executeRaw`
    UPDATE "ClubRosterMember" SET "sourceRegistrationId" = NULL
    WHERE "sourceRegistrationId" IN (SELECT "id" FROM "Registration" WHERE "eventId" = ${eventId})`;
  await tx.$executeRaw`
    UPDATE "ImportRecord" SET "matchedRegistrationId" = NULL
    WHERE "matchedRegistrationId" IN (SELECT "id" FROM "Registration" WHERE "eventId" = ${eventId})`;

  // 10. Registrations: cascades attendees, check-ins, waitlist, club
  //     registrations and assignments, access tokens, transfer moves.
  await tx.clubEventAssignment.deleteMany({ where: inEvent });
  await tx.clubEventRegistration.deleteMany({ where: inEvent });
  await tx.clubRegistrationDraft.deleteMany({ where: inEvent });
  await tx.memberTransferRegistrationMove.deleteMany({ where: inEvent });
  await tx.registration.deleteMany({ where: inEvent });

  // 11. Configuration that registrations pointed at.
  await tx.registrationForm.deleteMany({ where: inEvent });
  await tx.eventLocation.deleteMany({ where: inEvent });
  await tx.eventAttendeeType.deleteMany({ where: inEvent });
  await tx.eventAttendeeClassification.deleteMany({ where: inEvent });
  await tx.eventTag.deleteMany({ where: inEvent });
  await tx.eventMessageTemplate.deleteMany({ where: inEvent });

  // 12. Content and files: links RESTRICT assets, and the event RESTRICTs its badge artwork.
  await tx.event.update({ where: { id: eventId }, data: { badgeBackgroundAssetId: null } });
  await tx.eventContentLink.deleteMany({ where: { section: { eventId } } });
  await tx.eventContentSection.deleteMany({ where: inEvent });
  await tx.eventAsset.deleteMany({ where: inEvent });

  // 13. The event: cascades everything still hanging off it (staff access,
  //     settings, community, imports, announcements, awards, and the rest).
  //     Audit history keeps its rows with the event reference cleared.
  await tx.event.delete({ where: { id: eventId } });
}
