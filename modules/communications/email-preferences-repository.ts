import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import type { EventAnnouncementOptOutRow } from "@/modules/communications/types";
import { announcementRecipientEmail } from "@/modules/communications/announcement-broadcast-preview";
import {
  announcementOptOutFor,
  normalizeEmailAddress,
  optOutScopeKey,
  type AnnouncementOptOutRow,
  type AnnouncementOptOutScope,
} from "@/modules/communications/email-preferences";

type OptOutClient = Pick<PrismaClient, "emailAnnouncementOptOut"> | Prisma.TransactionClient;

/**
 * Every opt-out that could apply to these addresses for this event: the event's own and the global ones. One query
 * for a whole broadcast, so the review and the send count from the same rows.
 */
export async function loadAnnouncementOptOuts(
  client: OptOutClient,
  emails: readonly string[],
  eventId: string,
): Promise<AnnouncementOptOutRow[]> {
  const normalized = [...new Set(emails.map(normalizeEmailAddress).filter(Boolean))];
  if (normalized.length === 0) return [];
  const rows = await client.emailAnnouncementOptOut.findMany({
    where: {
      normalizedEmail: { in: normalized },
      OR: [{ scope: "ALL" }, { scope: "EVENT", eventId }],
    },
    select: { normalizedEmail: true, scope: true, eventId: true },
  });
  return rows;
}

/** The opt-out that applies right now to one address for one event, for the delivery step's last check. */
export async function findAnnouncementOptOut(
  client: OptOutClient,
  email: string,
  eventId: string,
): Promise<AnnouncementOptOutScope | null> {
  return announcementOptOutFor(await loadAnnouncementOptOuts(client, [email], eventId), email, eventId);
}

export type OptOutSource = "UNSUBSCRIBE_PAGE" | "ONE_CLICK";

/**
 * Records an opt-out for an address. Idempotent: choosing the same scope again changes nothing and writes no second
 * audit row. The audit entry carries the scope and how it was recorded, never the address.
 */
export async function recordAnnouncementOptOut(input: {
  email: string;
  eventId: string;
  scope: AnnouncementOptOutScope;
  source: OptOutSource;
}) {
  const normalizedEmail = normalizeEmailAddress(input.email);
  const scopeKey = optOutScopeKey(input.scope, input.eventId);
  return getPrisma().$transaction(async (tx) => {
    const existing = await tx.emailAnnouncementOptOut.findUnique({
      where: { normalizedEmail_scopeKey: { normalizedEmail, scopeKey } },
      select: { id: true },
    });
    if (existing) return { recorded: false as const, id: existing.id };
    const row = await tx.emailAnnouncementOptOut.create({
      data: {
        normalizedEmail,
        scope: input.scope,
        eventId: input.scope === "EVENT" ? input.eventId : null,
        scopeKey,
        source: input.source,
      },
      select: { id: true },
    });
    await tx.auditLog.create({
      data: {
        eventId: input.eventId,
        action: "EMAIL_ANNOUNCEMENT_OPT_OUT_RECORDED",
        entityType: "EmailAnnouncementOptOut",
        entityId: row.id,
        correlationId: randomUUID(),
        summary: input.scope === "ALL"
          ? "A recipient opted out of all IMSDA Events announcements."
          : "A recipient opted out of this event's announcements.",
        metadata: { scope: input.scope, source: input.source },
      },
    });
    return { recorded: true as const, id: row.id };
  });
}

/** Re-subscribes an address to this event's announcements: clears its event opt-out and any global one. */
export async function removeAnnouncementOptOuts(input: { email: string; eventId: string }) {
  const normalizedEmail = normalizeEmailAddress(input.email);
  return getPrisma().$transaction(async (tx) => {
    const removed = await tx.emailAnnouncementOptOut.deleteMany({
      where: { normalizedEmail, OR: [{ scope: "ALL" }, { scope: "EVENT", eventId: input.eventId }] },
    });
    if (removed.count > 0) {
      await tx.auditLog.create({
        data: {
          eventId: input.eventId,
          action: "EMAIL_ANNOUNCEMENT_OPT_OUT_REMOVED",
          entityType: "EmailAnnouncementOptOut",
          correlationId: randomUUID(),
          summary: "A recipient re-subscribed to announcements.",
          metadata: { removedCount: removed.count },
        },
      });
    }
    return { removedCount: removed.count };
  });
}

export type AnnouncementOptOutState = { event: boolean; all: boolean };

export async function getAnnouncementOptOutState(email: string, eventId: string): Promise<AnnouncementOptOutState> {
  const rows = await loadAnnouncementOptOuts(getPrisma(), [email], eventId);
  return {
    event: rows.some((row) => row.scope === "EVENT"),
    all: rows.some((row) => row.scope === "ALL"),
  };
}

/**
 * Who in this event opted out of announcements, for staff: the registrations whose contact address has an opt-out,
 * with which kind. It is derived from the registrations the event already holds, so it never lists an address the
 * event has no registration for.
 */
export async function listEventAnnouncementOptOuts(eventId: string): Promise<EventAnnouncementOptOutRow[]> {
  const prisma = getPrisma();
  const registrations = await prisma.registration.findMany({
    where: { eventId },
    orderBy: [{ submittedAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      confirmationCode: true,
      status: true,
      contactSnapshot: true,
      accountHolderPerson: { select: { normalizedEmail: true, firstName: true, lastName: true } },
    },
  });
  const withEmail = registrations.map((registration) => {
    const contact = registration.contactSnapshot && typeof registration.contactSnapshot === "object" && !Array.isArray(registration.contactSnapshot)
      ? registration.contactSnapshot as Record<string, unknown>
      : {};
    const first = typeof contact.firstName === "string" && contact.firstName.trim() ? contact.firstName.trim() : registration.accountHolderPerson?.firstName ?? "";
    const last = typeof contact.lastName === "string" && contact.lastName.trim() ? contact.lastName.trim() : registration.accountHolderPerson?.lastName ?? "";
    return {
      registration,
      email: announcementRecipientEmail(registration.contactSnapshot, registration.accountHolderPerson?.normalizedEmail ?? null),
      name: `${first} ${last}`.trim(),
    };
  }).filter((entry) => entry.email);
  const optOuts = await prisma.emailAnnouncementOptOut.findMany({
    where: {
      normalizedEmail: { in: [...new Set(withEmail.map((entry) => entry.email))] },
      OR: [{ scope: "ALL" }, { scope: "EVENT", eventId }],
    },
    select: { normalizedEmail: true, scope: true, eventId: true, createdAt: true },
  });
  const rows: EventAnnouncementOptOutRow[] = [];
  for (const entry of withEmail) {
    const scope = announcementOptOutFor(optOuts, entry.email, eventId);
    if (!scope) continue;
    const match = optOuts.find((row) => row.normalizedEmail === entry.email && row.scope === scope);
    rows.push({
      registrationId: entry.registration.id,
      confirmationCode: entry.registration.confirmationCode,
      registrationStatus: entry.registration.status,
      contactName: entry.name,
      email: entry.email,
      scope,
      optedOutAt: (match?.createdAt ?? new Date(0)).toISOString(),
    });
  }
  return rows;
}
