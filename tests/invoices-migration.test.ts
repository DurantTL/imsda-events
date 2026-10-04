import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../prisma/migrations/20261004150000_invoices/migration.sql", import.meta.url), "utf8");
const sql = migration.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");

describe("invoices migration (#167)", () => {
  it("adds the dedicated permission without touching existing values", () => {
    expect(sql).toContain(`ALTER TYPE "EventPermission" ADD VALUE 'FINALIZE_INVOICES'`);
  });

  it("makes finalized and superseded versions immutable, with one open draft and one finalized version per invoice", () => {
    expect(sql).toContain('BEFORE INSERT OR UPDATE OR DELETE ON "InvoiceVersion"');
    expect(sql).toContain("A finalized invoice version is an immutable snapshot.");
    expect(sql).toContain("An invoice version starts as a draft.");
    expect(sql).toContain('ON "InvoiceVersion"("invoiceId") WHERE "status" = \'DRAFT\'');
    expect(sql).toContain('ON "InvoiceVersion"("invoiceId") WHERE "status" = \'FINALIZED\'');
    expect(sql).toContain("pg_trigger_depth() > 1");
  });

  it("assigns the number once, from a counter that only counts up, unique per code and year", () => {
    expect(sql).toContain("An invoice number is assigned once and never changed.");
    expect(sql).toContain("An invoice number counter only counts up by one.");
    expect(sql).toContain('CREATE UNIQUE INDEX "InvoiceNumberCounter_code_year_key" ON "InvoiceNumberCounter"("code", "year")');
    expect(sql).toContain('CREATE UNIQUE INDEX "Invoice_baseNumber_key"');
    expect(sql).toContain('CREATE UNIQUE INDEX "InvoiceVersion_number_key"');
    expect(sql).toContain('CREATE UNIQUE INDEX "InvoiceVersion_finalizeIdempotencyKey_key"');
  });

  it("keeps one receivable per finalized version for exactly its amount, one open per invoice", () => {
    expect(sql).toContain('CREATE UNIQUE INDEX "InvoiceReceivable_one_open_per_invoice" ON "InvoiceReceivable"("invoiceId") WHERE "status" = \'OPEN\'');
    expect(sql).toContain("A receivable matches exactly one finalized invoice version and its amount.");
    expect(sql).toContain('CREATE UNIQUE INDEX "InvoiceReceivable_invoiceVersionId_key"');
  });

  it("locks the event's invoice code once numbers exist", () => {
    expect(sql).toContain("The invoice code is locked");
    expect(sql).toContain('BEFORE UPDATE OF "invoiceCode" ON "Event"');
  });

  it("is additive: no drops, deletes, or changes to existing columns", () => {
    for (const statement of sql.split(/;\s*\n/).map((part) => part.trim()).filter(Boolean)) {
      expect(statement).not.toMatch(/^(DELETE|UPDATE|TRUNCATE|DROP)\b/i);
      if (/^ALTER TABLE/.test(statement)) {
        expect(statement).toMatch(/^ALTER TABLE "(Invoice|InvoiceVersion|InvoiceReceivable|InvoiceNumberCounter|Event)"/);
        if (/^ALTER TABLE "Event"/.test(statement)) expect(statement).toMatch(/ADD (COLUMN\s+"invoiceCode" TEXT|CONSTRAINT "Event_invoiceCode_shape")/);
      }
    }
  });
});
