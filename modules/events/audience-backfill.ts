import "server-only";

import { getPrisma } from "@/lib/prisma";

export type EventAudienceBackfillRow = {
  id: string;
  name: string;
  billingMode: "ATTENDEE_PAY" | "DEFERRED_ORGANIZATION_INVOICE";
  fromAudience: "GENERAL" | "CLUB";
  toAudience: "CLUB";
};

export type EventAudienceBackfillReport = {
  dryRun: boolean;
  totalCandidates: number;
  updatedCount: number;
  rows: EventAudienceBackfillRow[];
};

/**
 * Backfills the explicit `Event.audience` field (#481) from how "club event"
 * was inferred before it existed: an event billed to a club or church
 * (`billingMode: DEFERRED_ORGANIZATION_INVOICE`) becomes `CLUB`. Every other
 * event stays whatever it already is — `audience` defaults to `GENERAL` on
 * every row via the migration's column default, so "the rest become GENERAL"
 * needs no write here.
 *
 * Deliberately one-directional: this never sets an event back to `GENERAL`,
 * even one billed `ATTENDEE_PAY`. Audience is independent of billing mode
 * (a CLUB event may be attendee-paid, e.g. Man Camp), so an event someone has
 * already marked `CLUB` — however it was billed — must never be reclassified
 * by a later run of this backfill.
 *
 * Idempotent, mirroring `backfillAttendeeTypes` (`modules/attendee-types/repository.ts`)
 * and `backfillHouseholdMembershipEffectiveDates`
 * (`modules/people/household-backfill.ts`): it only selects deferred-billed
 * rows not already `CLUB`, so a repeated run — dry or applied — finds
 * nothing left once every deferred-billed event is `CLUB`.
 *
 * `apply` defaults to false (dry run): the report, including a per-event
 * plan, is always returned; rows are only written when `apply` is true. This
 * is the human checkpoint AGENTS.md requires before writing existing data —
 * running it against production is a human step, never automated here.
 */
export async function backfillEventAudience(apply = false): Promise<EventAudienceBackfillReport> {
  const prisma = getPrisma();
  const events = await prisma.event.findMany({
    where: { billingMode: "DEFERRED_ORGANIZATION_INVOICE", audience: { not: "CLUB" } },
    select: { id: true, name: true, billingMode: true, audience: true },
    orderBy: { startsAt: "asc" },
  });

  const candidates = events.map((event) => ({
    id: event.id,
    name: event.name,
    billingMode: event.billingMode,
    fromAudience: event.audience,
    toAudience: "CLUB" as const,
  }));

  let updatedCount = 0;
  if (apply && candidates.length > 0) {
    await prisma.$transaction(
      candidates.map((row) =>
        prisma.event.update({
          where: { id: row.id, audience: row.fromAudience },
          data: { audience: row.toAudience },
        }),
      ),
    );
    updatedCount = candidates.length;
  }

  return {
    dryRun: !apply,
    totalCandidates: candidates.length,
    updatedCount,
    rows: candidates,
  };
}
