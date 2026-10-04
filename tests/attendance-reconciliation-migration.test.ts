import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../prisma/migrations/20261004100000_attendance_reconciliation/migration.sql", import.meta.url),
  "utf8",
);
const sql = migration.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");

describe("attendance reconciliation migration (#166)", () => {
  it("keeps one active correction per person and requires a reason", () => {
    expect(sql).toContain('CREATE UNIQUE INDEX "AttendanceCorrection_one_active_per_attendee" ON "AttendanceCorrection"("registrationAttendeeId") WHERE "supersededAt" IS NULL');
    expect(sql).toContain("AttendanceCorrection_reason_present");
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON "AttendanceCorrection"');
  });

  it("makes versions immutable snapshots with a guarded status path", () => {
    expect(sql).toContain('BEFORE INSERT OR UPDATE OR DELETE ON "AttendanceReconciliationVersion"');
    expect(sql).toContain("A reconciliation version is an immutable snapshot.");
    expect(sql).toContain("AttendanceReconciliationVersion_counts_reconcile");
  });

  it("settles parallel prepares and approvals with partial unique indexes", () => {
    expect(sql).toContain('ON "AttendanceReconciliationVersion"("eventId", "fingerprint") WHERE "status" <> \'SUPERSEDED\'');
    expect(sql).toContain('ON "AttendanceReconciliationVersion"("eventId") WHERE "status" = \'APPROVED\'');
  });

  it("is additive: no drops, deletes, or changes to existing columns", () => {
    for (const statement of sql.split(/;\s*\n/).map((part) => part.trim()).filter(Boolean)) {
      expect(statement).not.toMatch(/^(DELETE|UPDATE|TRUNCATE|DROP)\b/i);
      if (/^ALTER TABLE/.test(statement)) expect(statement).toMatch(/^ALTER TABLE "Attendance(Correction|ReconciliationVersion|ReviewAcknowledgement)"/);
    }
  });
});
