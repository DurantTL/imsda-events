/**
 * Backfills Event.audience (#481) from billing mode: deferred-organization
 * (club/church) billed events become CLUB, every other event GENERAL. Dry
 * run by default; pass --apply to write. Running this against production is
 * a human step.
 *
 *   npm run event-audience:backfill              # dry run, prints the plan
 *   npm run event-audience:backfill -- --apply    # writes the plan
 */
import { loadEnvConfig } from "@next/env";
import { backfillEventAudience } from "@/modules/events/audience-backfill";

loadEnvConfig(process.cwd());

async function main() {
  const apply = process.argv.includes("--apply");
  const report = await backfillEventAudience(apply);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(
    report.dryRun
      ? `Dry run: ${report.totalCandidates} event(s) would change. Re-run with --apply to write.\n`
      : `Applied: ${report.updatedCount} event(s) updated.\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
