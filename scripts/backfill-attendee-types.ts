import { backfillAttendeeTypes } from "@/modules/attendee-types/repository";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1] ?? null;
}

async function main() {
  const eventId = argument("--event-id");
  if (!eventId) throw new Error("Usage: npm run attendee-types:backfill -- --event-id <id> [--apply]");
  const report = await backfillAttendeeTypes(eventId, process.argv.includes("--apply"));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.rows.some((row) => row.status !== "MAPPABLE")) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
