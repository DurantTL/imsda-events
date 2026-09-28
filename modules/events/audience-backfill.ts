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
 * Verifies the explicit `Event.audience` backfill (#481). The migration
 * `20260928120000_event_audience` itself sets every event billed to a club or
 * church (`billingMode: DEFERRED_ORGANIZATION_INVOICE`) to `CLUB`, so on a
 * migrated database this report should find 0 rows. It lists any
 * deferred-billed event that is not `CLUB`.
 *
 * After the migration, a deferred-billed event that is `GENERAL` is a
 * deliberate human choice (audience is independent of billing mode), so this
 * is read-only by default. `apply` exists only as a forced repair, and the
 * CLI refuses it unless `--force` is also passed; it never sets any event to
 * `GENERAL`. Running it against production is a human step.
 *
 * Idempotent, mirroring `backfillAttendeeTypes` (`modules/attendee-types/repository.ts`)
 * and `backfillHouseholdMembershipEffectiveDates`
 * (`modules/people/household-backfill.ts`): it only selects deferred-billed
 * rows not already `CLUB`, so a repeated run finds nothing left.
 */
/**
 * How the CLI should run, from its arguments: a report by default; `--apply`
 * alone is refused (it could override a human's later choice of GENERAL);
 * only `--apply --force` writes.
 */
export function resolveEventAudienceBackfillMode(argv: readonly string[]): "report" | "refuse" | "apply" {
  const apply = argv.includes("--apply");
  if (!apply) return "report";
  return argv.includes("--force") ? "apply" : "refuse";
}

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
