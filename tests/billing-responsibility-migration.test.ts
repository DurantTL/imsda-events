import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../prisma/migrations/20261004040000_billing_responsibility/migration.sql", import.meta.url),
  "utf8",
);
const sql = migration.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");

describe("billing responsibility migration (#165 slice 1)", () => {
  it("adds the grouping setting with the per-church default", () => {
    expect(sql).toContain('ALTER TABLE "Event" ADD COLUMN     "invoiceGrouping" "InvoiceGrouping" NOT NULL DEFAULT \'PER_CHURCH\'');
  });

  it("allows one active billing contact per organization, enforced by a partial unique index", () => {
    expect(sql).toContain('CREATE UNIQUE INDEX "OrganizationBillingContact_one_active_per_organization" ON "OrganizationBillingContact"("organizationId") WHERE "effectiveTo" IS NULL');
  });

  it("never deletes a contact and keeps the history append-only", () => {
    expect(sql).toContain('BEFORE DELETE ON "OrganizationBillingContact"');
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON "RegistrationBillingResponsibilityChange"');
    expect(sql).toContain('OrganizationBillingContact_guard_update');
  });

  it("constrains the responsible party to its kind and an override to a reason", () => {
    expect(sql).toContain("RegistrationBillingResponsibility_party_matches_kind");
    expect(sql).toContain("RegistrationBillingResponsibility_staff_source_rules");
  });

  it("is additive: no drops, deletes, or changes to existing columns", () => {
    for (const statement of sql.split(/;\s*\n/).map((part) => part.trim()).filter(Boolean)) {
      expect(statement).not.toMatch(/^(DELETE|UPDATE|TRUNCATE|DROP)\b/i);
      if (/^ALTER TABLE "Event"/.test(statement)) expect(statement).toMatch(/ADD COLUMN/);
    }
  });
});
