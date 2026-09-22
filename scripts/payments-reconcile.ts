/**
 * Read-only Square reconciliation for human review. Takes no money, writes
 * nothing, and is safe to run against Production.
 */
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import { getSquareConfiguration } from "@/modules/payments/square-config-domain";
import {
  collectSquareReconciliationReport,
  isActionable,
} from "@/modules/payments/square-reconciliation";

loadEnvConfig(process.cwd());

const USAGE = "Usage:\n"
  + "  npm run payments:reconcile -- [--days <n>] [--since <ISO-8601>] [--until <ISO-8601>]\n"
  + "\n"
  + "Defaults to the last 30 days.";

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(1);
}

function option(argv: string[], name: string) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) fail(`--${name} needs a value.`);
  return value;
}

function window(argv: string[]) {
  const until = option(argv, "until");
  const since = option(argv, "since");
  const days = option(argv, "days");
  if (since && days) fail("Use --since or --days, not both.");
  const endTime = until ? new Date(until) : null;
  if (endTime && Number.isNaN(endTime.getTime())) fail("--until is not a date.");
  if (since) {
    const beginTime = new Date(since);
    if (Number.isNaN(beginTime.getTime())) fail("--since is not a date.");
    return { beginTime, endTime };
  }
  const count = days ? Number(days) : 30;
  if (!Number.isInteger(count) || count < 1 || count > 365) {
    fail("--days must be a whole number from 1 to 365.");
  }
  const anchor = endTime ?? new Date();
  return {
    beginTime: new Date(anchor.getTime() - count * 24 * 60 * 60 * 1000),
    endTime,
  };
}

function money(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

async function main() {
  const argv = process.argv.slice(2);
  const { beginTime, endTime } = window(argv);
  const configuration = getSquareConfiguration();
  if (!configuration.paymentConfigured) {
    fail(`Square is not configured for reconciliation (${configuration.issue}).`);
  }

  const prisma = new PrismaClient();
  try {
    const report = await collectSquareReconciliationReport(
      prisma,
      configuration,
      {
        beginTime: beginTime.toISOString(),
        ...(endTime ? { endTime: endTime.toISOString() } : {}),
      },
    );

    console.log(`Square ${report.environment}, location ${report.locationId}`);
    console.log(`Window ${report.beginTime} to ${report.endTime ?? "now"}`);
    console.log(`${report.examined} completed Square payment${report.examined === 1 ? "" : "s"} examined\n`);
    if (report.unreachableSquare) {
      console.log("  [!] Square could not be reached. The listing below may be incomplete.\n");
    }

    const actionable = report.findings.filter(isActionable);
    if (actionable.length === 0) {
      console.log("  [.] Every completed Square payment is recorded in IMSDA Events.\n");
    } else {
      for (const finding of actionable) {
        console.log(`  [!] [${finding.code}] ${money(finding.amountCents)} ${finding.providerPaymentId}`);
        console.log(`        ${finding.createdAt ?? "unknown date"}${finding.confirmationCode ? ` · registration ${finding.confirmationCode}` : ""}`);
        if (finding.balanceCents !== null && finding.balanceCents !== finding.amountCents) {
          console.log(`        Outstanding balance ${money(finding.balanceCents)}`);
        }
        console.log(`        ${finding.detail}`);
      }
      console.log("");
    }

    if (report.ignoredWebhookEvents.length > 0) {
      console.log(`${report.ignoredWebhookEvents.length} webhook deliver${report.ignoredWebhookEvents.length === 1 ? "y was" : "ies were"} received and not acted on:`);
      for (const row of report.ignoredWebhookEvents) {
        console.log(`  - ${row.occurredAt} ${row.eventType} ${row.objectId ?? ""}`);
        if (row.reason) console.log(`        ${row.reason}`);
      }
      console.log("");
    } else if (report.examined > 0) {
      console.log("No webhook delivery was declined in this window.\n");
    }

    console.log(actionable.length === 0
      ? "Nothing needs attention."
      : `${actionable.length} payment${actionable.length === 1 ? "" : "s"} need${actionable.length === 1 ? "s" : ""} attention.`);
    process.exitCode = actionable.length === 0 ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(() => {
  // Raw database/provider exceptions can carry private values. Keep the output
  // safe to paste into a review and leave diagnostics to protected logs.
  console.error(`Reconciliation could not be completed.\n\n${USAGE}`);
  process.exit(1);
});
