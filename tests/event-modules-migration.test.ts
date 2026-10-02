import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../prisma/migrations/20261002040000_event_modules/migration.sql", import.meta.url),
  "utf8",
);
const sql = migration.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
const statements = sql.split(";").map((statement) => statement.trim()).filter(Boolean);
const insertFor = (key: string) => statements.find((statement) => statement.startsWith("INSERT") && statement.includes(`'${key}'`)) ?? "";

describe("event modules migration (#741)", () => {
  it("creates the table with a unique event+module key and cascades from Event", () => {
    expect(sql).toContain('CREATE UNIQUE INDEX "EventModule_eventId_moduleKey_key" ON "EventModule"("eventId", "moduleKey")');
    expect(sql).toContain('FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE');
    expect(sql).not.toMatch(/ADD COLUMN/);
  });

  it("backfills each module from the data behind it", () => {
    expect(insertFor("public-content")).not.toContain("WHERE");
    expect(insertFor("honors")).toContain(`"audience" = 'CLUB'`);
    expect(insertFor("honors")).toContain('"HonorSession"');
    // An all-sessions class has no session, so offerings and enrollments count too.
    expect(insertFor("honors")).toContain('"HonorOffering"');
    expect(insertFor("honors")).toContain('"HonorEnrollment"');
    expect(insertFor("event-patches")).toContain(`"audience" = 'CLUB'`);
    expect(insertFor("club-assignments")).toContain(`"audience" = 'CLUB'`);
    expect(insertFor("merchandise")).toContain('"MerchandiseProduct"');
    expect(insertFor("seminar-assignments")).toContain("RANKED_CHOICE");
    expect(insertFor("seminar-assignments")).toContain("RANKED_INTEREST");
    // A null or empty mode counts as no mode, like getAvailabilityMode.
    expect(insertFor("seminar-assignments")).toContain('@.availabilityMode == null');
    expect(insertFor("seminar-assignments")).toContain('@.availabilityMode == ""');
    expect(insertFor("seminar-assignments")).toContain('"ProgramAssignmentRun"');
    expect(insertFor("attendee-community")).toContain('"EventCommunitySettings"');
    expect(insertFor("attendee-community")).toContain('"CommunityPost"');
  });

  it("only inserts, idempotently, and never deletes or updates data", () => {
    const inserts = statements.filter((statement) => statement.startsWith("INSERT"));
    expect(inserts).toHaveLength(6);
    for (const insert of inserts) expect(insert).toContain('ON CONFLICT ("eventId", "moduleKey") DO NOTHING');
    for (const statement of statements) expect(statement).not.toMatch(/^(DELETE|UPDATE|TRUNCATE|DROP)\b/i);
  });
});
