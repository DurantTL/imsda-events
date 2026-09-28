import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../prisma/migrations/20260928120000_event_audience/migration.sql", import.meta.url),
  "utf8",
);
const statements = migration
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

describe("event audience migration (#481)", () => {
  it("adds the audience column with a GENERAL default", () => {
    expect(statements).toContain(`CREATE TYPE "EventAudience" AS ENUM ('GENERAL', 'CLUB');`);
    expect(statements).toContain(
      `ALTER TABLE "Event" ADD COLUMN "audience" "EventAudience" NOT NULL DEFAULT 'GENERAL';`,
    );
  });

  it("backfills club-billed events to CLUB in the same migration, so deploy never drops their club features", () => {
    expect(statements).toContain(
      `UPDATE "Event" SET "audience" = 'CLUB' WHERE "billingMode" = 'DEFERRED_ORGANIZATION_INVOICE' AND "audience" <> 'CLUB';`,
    );
    // The backfill runs after the column exists.
    expect(statements.indexOf(`UPDATE "Event"`)).toBeGreaterThan(statements.indexOf(`ADD COLUMN "audience"`));
  });

  it("never sets any event to GENERAL", () => {
    expect(statements).not.toMatch(/SET\s+"audience"\s*=\s*'GENERAL'/);
  });
});
