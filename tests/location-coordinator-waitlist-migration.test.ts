import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const name = "20260929193000_location_coordinator_waitlist";
const migration = readFileSync(new URL(`../prisma/migrations/${name}/migration.sql`, import.meta.url), "utf8");
const statements = migration
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");
const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");

describe("location coordinator and waitlist migration (#599)", () => {
  it("sorts after the event locations migration it builds on, and after the migrations that came before", () => {
    const names = readdirSync(new URL("../prisma/migrations/", import.meta.url)).filter((entry) => /^\d{14}_/.test(entry)).sort();
    expect(names.indexOf(name)).toBeGreaterThan(names.indexOf("20260929190000_event_locations"));
    expect(names.indexOf(name)).toBeGreaterThan(names.indexOf("20260929180000_member_honor_entry_void"));
    expect(names).toContain(name);
  });

  it("is additive: a nullable column, one new table, one enum, one enum value, and nothing dropped or rewritten", () => {
    expect(statements).toContain('ALTER TABLE "EventLocation" ADD COLUMN     "coordinatorAccountId" TEXT;');
    expect(statements).toContain('CREATE TABLE "LocationWaitlistChange"');
    expect(statements).toContain(`CREATE TYPE "LocationWaitlistChangeKind" AS ENUM ('JOINED', 'PROMOTED', 'REMOVED')`);
    expect(statements).toContain(`ALTER TYPE "MessageTemplateKey" ADD VALUE IF NOT EXISTS 'LOCATION_WAITLIST_DIGEST'`);
    expect(statements).not.toMatch(/\bDROP\b/i);
    expect(statements).not.toMatch(/\bRENAME\b/i);
    expect(statements).not.toMatch(/\bUPDATE\b\s+"/i);
    expect(statements).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(statements).not.toMatch(/\bTRUNCATE\b/i);
    expect(statements).not.toMatch(/ALTER COLUMN/i);
    const alters = statements.match(/ALTER TABLE "[A-Za-z]+"\s+\w+ \w+/g) ?? [];
    expect(alters.length).toBeGreaterThan(0);
    for (const alter of alters) expect(alter).toMatch(/ADD (COLUMN|CONSTRAINT)$/);
  });

  it("leaves every existing location without a coordinator: the column is nullable with no default", () => {
    const column = statements.match(/ADD COLUMN\s+"coordinatorAccountId"[^;]*;/)?.[0] ?? "";
    expect(column).not.toMatch(/NOT NULL/i);
    expect(column).not.toMatch(/DEFAULT/i);
  });

  it("forgets a deleted coordinator account rather than blocking it, and cascades the change log from its event, location and registration", () => {
    expect(statements).toContain('"EventLocation_coordinatorAccountId_fkey" FOREIGN KEY ("coordinatorAccountId") REFERENCES "AttendeeAccount"("id") ON DELETE SET NULL');
    expect(statements).toContain('"LocationWaitlistChange_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE');
    expect(statements).toContain('"LocationWaitlistChange_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "EventLocation"("id") ON DELETE CASCADE');
    expect(statements).toContain('"LocationWaitlistChange_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE CASCADE');
  });

  it("indexes the digest's read of changes not yet sent, in the order they happened", () => {
    expect(statements).toContain('CREATE INDEX "LocationWaitlistChange_digestedAt_occurredAt_idx" ON "LocationWaitlistChange"("digestedAt", "occurredAt")');
  });

  it("closes the implicit transaction after adding the enum value, which cannot be used in the transaction that adds it", () => {
    expect(migration.indexOf("ADD VALUE")).toBeLessThan(migration.indexOf("COMMIT;"));
    expect(migration.indexOf("COMMIT;")).toBeLessThan(migration.indexOf("CREATE TYPE"));
  });

  it("matches the schema names other work builds on", () => {
    expect(schema).toMatch(/model LocationWaitlistChange \{/);
    expect(schema).toMatch(/coordinatorAccountId\s+String\?/);
    expect(schema).toMatch(/LOCATION_WAITLIST_DIGEST/);
  });
});
