/**
 * Re-runs the event-modules backfill (#741): the same INSERT ... ON CONFLICT DO
 * NOTHING statements the migration 20261002040000_event_modules runs, read from
 * that file so there is one copy. It only inserts missing rows, so it is safe to
 * run any number of times and in production; it never deletes, updates, or
 * turns off anything, and never touches the data behind a module.
 *
 * Use it after a deploy if a club event was created in the window between the
 * migration and the new code starting:
 *
 *   npm run event-modules:backfill
 */
import { readFileSync } from "node:fs";
import { loadEnvConfig } from "@next/env";
import { getPrisma } from "@/lib/prisma";

loadEnvConfig(process.cwd());

const MIGRATION = "prisma/migrations/20261002040000_event_modules/migration.sql";
const BACKFILL_MARKER = "-- Public content";

export function backfillStatements(sql: string) {
  const start = sql.indexOf(BACKFILL_MARKER);
  if (start < 0) throw new Error("The backfill section was not found in the event modules migration.");
  return sql
    .slice(start)
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function main() {
  const statements = backfillStatements(readFileSync(MIGRATION, "utf8"));
  const prisma = getPrisma();
  let added = 0;
  for (const statement of statements) {
    if (!statement.startsWith("INSERT")) throw new Error("Refusing to run a statement that is not an INSERT.");
    added += await prisma.$executeRawUnsafe(statement);
  }
  process.stdout.write(`Event modules backfill: ${added} missing row(s) added.\n`);
  await prisma.$disconnect();
}

if (process.argv[1]?.endsWith("backfill-event-modules.ts")) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
