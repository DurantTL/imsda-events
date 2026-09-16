import { backfillHouseholdMembershipEffectiveDates } from "@/modules/people/household-backfill";

async function main() {
  const report = await backfillHouseholdMembershipEffectiveDates(process.argv.includes("--apply"));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
