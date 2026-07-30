/** Read-only WR26 configuration evidence for human staging/release review. */
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import { collectEventReadinessReport } from "@/modules/events/event-readiness-report";

loadEnvConfig(process.cwd());

const SEVERITY_MARK = { BLOCKER: "x", WARNING: "!", READY: "." } as const;
const USAGE = "Usage:\n  npm run event:readiness -- --event <slug>";

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(1);
}

function eventSlug(argv: string[]) {
  const index = argv.indexOf("--event");
  if (index === -1) fail("--event is required.");
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) fail("--event needs a value.");
  return value;
}

async function main() {
  const slug = eventSlug(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    const report = await collectEventReadinessReport(prisma, slug, process.env);
    if (!report) fail(`No event has the slug "${slug}".`);

    console.log(`${report.event.name} (${report.event.slug})`);
    console.log(`${report.activeRegistrationCount} active registrations\n`);
    for (const check of report.checks) {
      console.log(`  [${SEVERITY_MARK[check.severity]}] [${check.code}] ${check.label}`);
      if (check.severity !== "READY") console.log(`        ${check.detail}`);
    }
    console.log(report.summary.isReady
      ? `\nNo blockers. ${report.summary.warnings} warning${report.summary.warnings === 1 ? "" : "s"}.`
      : `\n${report.summary.blockers} blocker${report.summary.blockers === 1 ? "" : "s"}, ${report.summary.warnings} warning${report.summary.warnings === 1 ? "" : "s"}.`);
    process.exitCode = report.summary.isReady ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(() => {
  // Raw database/provider exceptions can contain private values. Keep command
  // output safe to attach to a review and leave diagnostics to protected logs.
  console.error(`Readiness could not be evaluated.\n\n${USAGE}`);
  process.exit(1);
});
