import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../prisma/migrations/20260929100000_event_locations/migration.sql", import.meta.url),
  "utf8",
);
const statements = migration
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");
const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");

describe("event locations migration (#413)", () => {
  it("adds a new table and a nullable column, and nothing else", () => {
    expect(statements).toContain('CREATE TABLE "EventLocation"');
    expect(statements).toContain('ALTER TABLE "Registration" ADD COLUMN     "locationId" TEXT;');
    // Every ALTER TABLE is an ADD COLUMN or ADD CONSTRAINT: no drop, rename, retype, or default backfill.
    const alters = statements.match(/ALTER TABLE "[A-Za-z]+"\s+\w+ \w+/g) ?? [];
    expect(alters.length).toBeGreaterThan(0);
    for (const alter of alters) expect(alter).toMatch(/ADD (COLUMN|CONSTRAINT)$/);
  });

  it("never touches existing rows or drops anything", () => {
    expect(statements).not.toMatch(/\bDROP\b/i);
    expect(statements).not.toMatch(/\bRENAME\b/i);
    expect(statements).not.toMatch(/\bUPDATE\b\s+"/i);
    expect(statements).not.toMatch(/\bDELETE\b\s+FROM/i);
    expect(statements).not.toMatch(/\bTRUNCATE\b/i);
    expect(statements).not.toMatch(/ALTER COLUMN/i);
  });

  it("leaves Registration.locationId nullable with no default, so every existing registration keeps no location", () => {
    const column = statements.match(/ADD COLUMN\s+"locationId"[^;]*;/)?.[0] ?? "";
    expect(column).not.toMatch(/NOT NULL/i);
    expect(column).not.toMatch(/DEFAULT/i);
  });

  it("restricts deleting a location that registrations use, and cascades only from the event", () => {
    expect(statements).toContain('"Registration_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "EventLocation"("id") ON DELETE RESTRICT');
    expect(statements).toContain('"EventLocation_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE');
  });

  it("enforces one name per event, case-insensitively, through the normalized name", () => {
    expect(statements).toContain('CREATE UNIQUE INDEX "EventLocation_eventId_normalizedName_key" ON "EventLocation"("eventId", "normalizedName")');
  });

  it("keeps the schema names other work builds on", () => {
    expect(schema).toMatch(/model EventLocation \{/);
    expect(schema).toMatch(/locations\s+EventLocation\[\]/);
    expect(schema).toMatch(/locationId\s+String\?/);
  });
});
