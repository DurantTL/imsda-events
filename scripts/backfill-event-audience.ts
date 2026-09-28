/**
 * Read-only verification report for the Event.audience backfill (#481). The
 * migration 20260928120000_event_audience already sets every event billed to
 * a club or church (DEFERRED_ORGANIZATION_INVOICE) to CLUB, so this should
 * report 0 rows. It never changes any event to GENERAL.
 *
 * After the migration, a deferred-billed GENERAL event is a human choice, so
 * --apply alone is refused; --apply --force forces those rows to CLUB and
 * overrides that choice. Running this against production is a human step.
 *
 *   npm run event-audience:backfill                      # report only
 *   npm run event-audience:backfill -- --apply --force   # forced repair
 */
import { loadEnvConfig } from "@next/env";
import { backfillEventAudience, resolveEventAudienceBackfillMode } from "@/modules/events/audience-backfill";

loadEnvConfig(process.cwd());

async function main() {
  const mode = resolveEventAudienceBackfillMode(process.argv.slice(2));
  if (mode === "refuse") {
    process.stderr.write(
      "Refusing --apply: the event_audience migration already set club-billed events to CLUB, "
      + "so any remaining GENERAL row may be a deliberate human choice. "
      + "Re-run with --apply --force only if you mean to override it.\n",
    );
    process.exitCode = 1;
    return;
  }
  const report = await backfillEventAudience(mode === "apply");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(
    report.dryRun
      ? `Verification: ${report.totalCandidates} club-billed event(s) are not CLUB (expected 0 after the migration).\n`
      : `Forced: ${report.updatedCount} event(s) set to CLUB.\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
