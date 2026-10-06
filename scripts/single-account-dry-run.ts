/**
 * READ-ONLY dry run for the single-account work (#554, ADR 0013): lists pairs
 * of a staff User and an AttendeeAccount that share a normalised email, the
 * conflicts a person must resolve for each, and counts of linked rows.
 *
 *   npm run accounts:dry-run                  # counts + masked emails
 *   npm run accounts:dry-run -- --json
 *   npm run accounts:dry-run -- --show-emails # full emails: personal data
 *
 * It never writes: every query runs in a `SET TRANSACTION READ ONLY`
 * transaction. It does not merge, link or change anything; merging identities
 * is a human gate (AGENTS.md).
 */
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import { runSingleAccountDryRun } from "../modules/account-merge/dry-run";
import { formatReportText, SHOW_EMAILS_WARNING } from "../modules/account-merge/dry-run-domain";

loadEnvConfig(process.cwd());

const USAGE = "Usage: npm run accounts:dry-run -- [--json] [--show-emails]\n";

async function main() {
  const args = process.argv.slice(2);
  const known = new Set(["--json", "--show-emails", "--help"]);
  const unknown = args.filter((arg) => !known.has(arg));
  if (unknown.length > 0 || args.includes("--help")) {
    process.stderr.write(USAGE);
    process.exitCode = args.includes("--help") && unknown.length === 0 ? 0 : 1;
    return;
  }
  const showEmails = args.includes("--show-emails");
  const json = args.includes("--json");
  if (showEmails) process.stderr.write(`${SHOW_EMAILS_WARNING}\n`);

  const prisma = new PrismaClient();
  try {
    const report = await runSingleAccountDryRun(prisma, { showEmails });
    process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : formatReportText(report));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
