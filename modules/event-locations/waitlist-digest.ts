import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { logError, logInfo } from "@/lib/logger";
import { getAccountEmailSender, isAccountEmailConfigured } from "@/modules/communications/account-email";
import { processAccountEmailQueue } from "@/modules/communications/email-delivery";
import { coordinatorGrantActive } from "@/modules/event-locations/domain";
import {
  buildLocationWaitlistDigest,
  digestIdempotencyKey,
  digestWindow,
  type DigestChange,
  type DigestEventSection,
} from "@/modules/event-locations/waitlist-digest-domain";

/**
 * Sends the daily location waitlist digest (#599) to Area Coordinators and
 * event staff. The scheduled outbox sweep calls this every few minutes; it does
 * nothing until the morning send time (Central), and then at most one email per
 * person per Central date goes out, covering everything that changed on the
 * waitlists they are responsible for since the last digest.
 *
 * - Who: a location's Area Coordinator, only while their grant is active and
 *   their account enabled (revoked or expired: no email), and the event
 *   administrators of the event (an active membership with the EVENT_ADMIN role
 *   on an active staff account). One person in both roles gets one email.
 * - Idempotent: each message has the key `location-waitlist-digest:<date>:<email>`,
 *   so a retry or a second run reuses the message. Changes are stamped
 *   `digestedAt` in the same transaction that queues the messages.
 * - Delivery: messages are queued in the outbox (with no event, like other
 *   account email) and delivered after the transaction. A delivery failure
 *   leaves the message queued with its status and backoff, and the sweep
 *   retries it; it never touches a registration.
 * - Nothing is queued while account email is not configured; the changes wait.
 */

export type LocationWaitlistDigestResult = {
  status: "NOT_DUE" | "NO_CHANGES" | "EMAIL_NOT_CONFIGURED" | "QUEUED";
  dateKey: string;
  changesCovered: number;
  recipients: number;
  messageIds: string[];
  delivered: number;
};

type Db = Prisma.TransactionClient;

type Recipient = {
  email: string;
  name: string;
  accountUserId: string | null;
  accountAttendeeId: string | null;
  coordinator: boolean;
  staff: boolean;
  /** eventId -> locationId -> changes */
  changes: Map<string, Map<string, DigestChange[]>>;
};

function addChange(recipient: Recipient, eventId: string, locationId: string, change: DigestChange) {
  const perLocation = recipient.changes.get(eventId) ?? new Map<string, DigestChange[]>();
  const list = perLocation.get(locationId) ?? [];
  list.push(change);
  perLocation.set(locationId, list);
  recipient.changes.set(eventId, perLocation);
}

async function collectRecipients(
  tx: Db,
  changes: Array<{
    eventId: string;
    locationId: string;
    kind: DigestChange["kind"];
    clubName: string;
    locationName: string;
    attendeeCount: number;
    place: number | null;
    occurredAt: Date;
  }>,
  now: Date,
) {
  const eventIds = [...new Set(changes.map((change) => change.eventId))];
  const locationIds = [...new Set(changes.map((change) => change.locationId))];
  const [locations, memberships] = await Promise.all([
    tx.eventLocation.findMany({
      where: { id: { in: locationIds } },
      select: {
        id: true,
        coordinator: {
          select: {
            id: true,
            email: true,
            displayName: true,
            disabledAt: true,
            areaCoordinatorGrant: { select: { revokedAt: true, expiresAt: true } },
          },
        },
      },
    }),
    tx.eventMembership.findMany({
      where: {
        eventId: { in: eventIds },
        role: "EVENT_ADMIN",
        status: "ACTIVE",
        // An activated staff account whose sign-in has not been disabled.
        user: { accountStatus: "ACTIVE", NOT: { credential: { is: { disabledAt: { not: null } } } } },
      },
      select: { eventId: true, user: { select: { id: true, email: true, displayName: true } } },
    }),
  ]);
  const coordinatorByLocation = new Map(locations.map((location) => [location.id, location.coordinator]));
  const staffByEvent = new Map<string, Array<{ id: string; email: string; displayName: string }>>();
  for (const membership of memberships) {
    const list = staffByEvent.get(membership.eventId) ?? [];
    list.push(membership.user);
    staffByEvent.set(membership.eventId, list);
  }

  const recipients = new Map<string, Recipient>();
  const recipientFor = (email: string, name: string) => {
    const key = email.trim().toLowerCase();
    let recipient = recipients.get(key);
    if (!recipient) {
      recipient = { email: key, name, accountUserId: null, accountAttendeeId: null, coordinator: false, staff: false, changes: new Map() };
      recipients.set(key, recipient);
    }
    return recipient;
  };

  for (const change of changes) {
    const digestChange: DigestChange = {
      kind: change.kind,
      clubName: change.clubName,
      attendeeCount: change.attendeeCount,
      place: change.place,
      occurredAt: change.occurredAt,
    };
    const coordinator = coordinatorByLocation.get(change.locationId);
    if (coordinator && !coordinator.disabledAt && coordinatorGrantActive(coordinator.areaCoordinatorGrant, now)) {
      const recipient = recipientFor(coordinator.email, coordinator.displayName);
      recipient.coordinator = true;
      recipient.accountAttendeeId = coordinator.id;
      addChange(recipient, change.eventId, change.locationId, digestChange);
    }
    for (const user of staffByEvent.get(change.eventId) ?? []) {
      const recipient = recipientFor(user.email, user.displayName);
      recipient.staff = true;
      recipient.accountUserId = user.id;
      // A person who is both coordinator and administrator sees a change once.
      const already = recipient.changes.get(change.eventId)?.get(change.locationId)?.includes(digestChange);
      if (!already) addChange(recipient, change.eventId, change.locationId, digestChange);
    }
  }
  return recipients;
}

export async function sendDueLocationWaitlistDigests(
  now = new Date(),
  options: { deliver?: (messageIds: string[]) => Promise<{ sentIds: string[] }> } = {},
): Promise<LocationWaitlistDigestResult> {
  const window = digestWindow(now);
  const result: LocationWaitlistDigestResult = {
    status: "NOT_DUE",
    dateKey: window.dateKey,
    changesCovered: 0,
    recipients: 0,
    messageIds: [],
    delivered: 0,
  };
  if (!window.due) return result;

  const prisma = getPrisma();
  // Cheap early exit on the common run: nothing changed since the last digest.
  const waiting = await prisma.locationWaitlistChange.count({ where: { digestedAt: null, occurredAt: { lt: window.sendAt } } });
  if (waiting === 0) return { ...result, status: "NO_CHANGES" };
  if (!isAccountEmailConfigured()) {
    logInfo("Location waitlist digest is waiting for account email to be configured.", { waiting });
    return { ...result, status: "EMAIL_NOT_CONFIGURED" };
  }
  const sender = getAccountEmailSender();

  const queued = await prisma.$transaction(async (tx) => {
    const changes = await tx.locationWaitlistChange.findMany({
      where: { digestedAt: null, occurredAt: { lt: window.sendAt } },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    });
    if (changes.length === 0) return { changesCovered: 0, messageIds: [] as string[], recipients: 0 };

    const recipients = await collectRecipients(tx, changes, now);
    const events = await tx.event.findMany({
      where: { id: { in: [...new Set(changes.map((change) => change.eventId))] } },
      select: { id: true, name: true },
    });
    const eventNames = new Map(events.map((event) => [event.id, event.name]));
    const locationNames = new Map(changes.map((change) => [change.locationId, change.locationName]));

    const messageIds: string[] = [];
    let createdAny = false;
    for (const recipient of recipients.values()) {
      const idempotencyKey = digestIdempotencyKey(window.dateKey, recipient.email);
      const existing = await tx.messageOutbox.findUnique({ where: { idempotencyKey }, select: { id: true } });
      // Today's digest already went to this person: their changes wait for tomorrow's.
      if (existing) continue;
      const sections: DigestEventSection[] = [...recipient.changes.entries()].map(([eventId, perLocation]) => ({
        eventName: eventNames.get(eventId) ?? "Event",
        locations: [...perLocation.entries()].map(([locationId, list]) => ({
          locationName: locationNames.get(locationId) ?? "Location",
          changes: list,
        })),
      }));
      const content = buildLocationWaitlistDigest({
        recipientName: recipient.name,
        dateKey: window.dateKey,
        sections,
        reason: recipient.coordinator && recipient.staff ? "BOTH" : recipient.coordinator ? "COORDINATOR" : "STAFF",
      });
      const message = await tx.messageOutbox.create({
        data: {
          eventId: null,
          // Attached to the person's own account when they hold only one role;
          // a person in both has one email and no single account to attach it to.
          accountUserId: recipient.staff && !recipient.coordinator ? recipient.accountUserId : null,
          accountAttendeeId: recipient.coordinator && !recipient.staff ? recipient.accountAttendeeId : null,
          templateKey: "LOCATION_WAITLIST_DIGEST",
          recipientKind: "INTERNAL",
          recipientEmail: recipient.email,
          recipientName: recipient.name.trim() || null,
          senderNameSnapshot: sender.name,
          senderEmailSnapshot: sender.address,
          replyToEmailSnapshot: sender.replyTo,
          subjectSnapshot: content.subject,
          bodyTextSnapshot: content.bodyText,
          metadata: {
            trigger: "LOCATION_WAITLIST_DIGEST",
            digestDate: window.dateKey,
            accountEmail: true,
            realDelivery: true,
            changeCount: [...recipient.changes.values()].reduce((sum, perLocation) => sum + [...perLocation.values()].reduce((n, list) => n + list.length, 0), 0),
          },
          idempotencyKey,
          correlationId: randomUUID(),
          status: "PENDING",
        },
        select: { id: true },
      });
      messageIds.push(message.id);
      createdAny = true;
    }

    // Stamped in the same transaction that queued the emails. Changes nobody
    // is responsible for are stamped too, so they do not pile up. Changes
    // whose recipients all already had today's digest stay for tomorrow's.
    if (createdAny || recipients.size === 0) {
      await tx.locationWaitlistChange.updateMany({
        where: { id: { in: changes.map((change) => change.id) }, digestedAt: null },
        data: { digestedAt: now },
      });
    }
    return { changesCovered: createdAny || recipients.size === 0 ? changes.length : 0, messageIds, recipients: recipients.size };
  });

  const outcome: LocationWaitlistDigestResult = {
    ...result,
    status: queued.changesCovered === 0 ? "NO_CHANGES" : "QUEUED",
    changesCovered: queued.changesCovered,
    recipients: queued.recipients,
    messageIds: queued.messageIds,
  };
  if (queued.messageIds.length === 0) return outcome;

  // After the commit. A failure leaves each message queued with its status and
  // backoff, and the sweep's next run delivers it.
  try {
    const delivery = await (options.deliver ?? ((messageIds) => processAccountEmailQueue({ messageIds })))(queued.messageIds);
    outcome.delivered = delivery.sentIds.length;
  } catch (error) {
    logError("Location waitlist digest emails were queued but not delivered on the first attempt.", error, { messages: queued.messageIds.length });
  }
  return outcome;
}
