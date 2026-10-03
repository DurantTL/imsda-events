import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../prisma/migrations/20261003140000_module_requests/migration.sql", import.meta.url),
  "utf8",
);
const sql = migration.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");

describe("module requests migration (#741 slice 3)", () => {
  it("creates the table with the status enum and cascades from the event", () => {
    expect(sql).toContain("CREATE TYPE \"ModuleRequestStatus\" AS ENUM ('PENDING', 'APPROVED', 'DECLINED')");
    expect(sql).toContain('CREATE TABLE "ModuleRequest"');
    for (const column of ["eventId", "moduleKey", "requestedByUserId", "reason", "status", "decidedByUserId", "decidedAt", "declineReason", "createdAt"]) {
      expect(sql).toContain(`"${column}"`);
    }
    expect(sql).toContain('FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE');
  });

  it("enforces one pending request per event and module with a partial unique index", () => {
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "ModuleRequest_one_pending_per_module" ON "ModuleRequest"("eventId", "moduleKey") WHERE "status" = \'PENDING\'',
    );
  });

  it("is additive: no drops, deletes, updates, or column changes on existing tables", () => {
    for (const statement of sql.split(";").map((part) => part.trim()).filter(Boolean)) {
      expect(statement).not.toMatch(/^(DELETE|UPDATE|TRUNCATE|DROP)\b/i);
      expect(statement).not.toMatch(/^ALTER TABLE "(?!ModuleRequest")/);
    }
    expect(sql).toContain("ADD VALUE 'MODULE_REQUEST_SUBMITTED'");
    expect(sql).toContain("ADD VALUE 'MODULE_REQUEST_DECIDED'");
  });
});
