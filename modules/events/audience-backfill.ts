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
  /** Deferred-billed GENERAL events left alone on purpose (#606): none of their forms has the club shape. */
  skipped: Array<{ id: string; name: string; reason: string }>;
};

/**
 * Verifies the explicit `Event.audience` backfill (#481). The migration
 * `20260928120000_event_audience` itself sets every event billed to a club or
 * church (`billingMode: DEFERRED_ORGANIZATION_INVOICE`) to `CLUB`, so on a
 * migrated database this report should find 0 rows, except for events
 * that are deliberately GENERAL and church-billed (#606: Leadership Weekend
 * and Outdoor School, where individuals or a school register and the church
 * or school is billed later). Those are recognised by their forms: an event
 * whose forms all lack the club-registration shape (see
 * `hasClubRegistrationShape`) is skipped, so neither the report nor
 * `--apply` can flip it to CLUB. An event with no forms is still listed.
 * It lists any other deferred-billed event that is not `CLUB`.
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

/**
 * Whether a stored form definition has the shape club registration needs (#606): a club chosen from the
 * directory (any field with `optionSource: "CLUBS_DIRECTORY"`, whatever its key) on a form with a repeatable
 * roster. Leadership Weekend has no roster and Outdoor School has no club selector, so neither has it.
 */
export function hasClubRegistrationShape(definition: unknown): boolean {
  if (!definition || typeof definition !== "object") return false;
  const { sections, attendeeRoster } = definition as { sections?: unknown; attendeeRoster?: { enabled?: unknown } };
  if (attendeeRoster?.enabled !== true || !Array.isArray(sections)) return false;
  return sections.some((section) => Array.isArray((section as { fields?: unknown })?.fields)
    && (section as { fields: Array<{ optionSource?: unknown }> }).fields.some((field) => field?.optionSource === "CLUBS_DIRECTORY"));
}

export async function backfillEventAudience(apply = false): Promise<EventAudienceBackfillReport> {
  const prisma = getPrisma();
  const events = await prisma.event.findMany({
    where: { billingMode: "DEFERRED_ORGANIZATION_INVOICE", audience: { not: "CLUB" } },
    select: {
      id: true,
      name: true,
      billingMode: true,
      audience: true,
      registrationForms: {
        select: {
          // The published version when there is one, else the newest of any status.
          versions: { orderBy: { versionNumber: "desc" }, take: 10, select: { definition: true, status: true } },
        },
      },
    },
    orderBy: { startsAt: "asc" },
  });

  // An event with forms, none of which has the club shape, is a deliberate GENERAL church-billed event (#606).
  const skipped: EventAudienceBackfillReport["skipped"] = [];
  const clubShaped = events.filter((event) => {
    const forms = event.registrationForms ?? [];
    const keep = forms.length === 0 || forms.some((form) => hasClubRegistrationShape((form.versions.find((version) => version.status === "PUBLISHED") ?? form.versions[0])?.definition));
    if (!keep) skipped.push({ id: event.id, name: event.name, reason: "No form has a club selector and a roster, so this church-billed event is deliberately GENERAL." });
    return keep;
  });
  const candidates = clubShaped.map((event) => ({
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
    skipped,
  };
}
