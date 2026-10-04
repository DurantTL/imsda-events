import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../prisma/migrations/20261004190000_invoice_delivery/migration.sql", import.meta.url), "utf8");
const sql = migration.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");

describe("invoice delivery migration (#168)", () => {
  it("adds the template key and recipient kind without touching existing values", () => {
    expect(sql).toContain(`ALTER TYPE "MessageTemplateKey" ADD VALUE 'INVOICE_DELIVERY'`);
    expect(sql).toContain(`ALTER TYPE "MessageRecipientKind" ADD VALUE 'BILLING_CONTACT'`);
    expect(sql).toContain(`ALTER TYPE "MessageRecipientKind" ADD VALUE 'CLUB_DIRECTOR'`);
  });

  it("stores an attachment once, with its size and hash checked against its content, never rewritten", () => {
    expect(sql).toContain(`"sha256" = encode(sha256("content"), 'hex')`);
    expect(sql).toContain(`"sizeBytes" = octet_length("content")`);
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON "MessageAttachment"');
    expect(sql).toContain("A message attachment is not rewritten.");
    expect(sql).toContain('ADD COLUMN     "attachmentId" TEXT');
  });

  it("keeps one document per version, only for a finalized version, holding exactly its attachment", () => {
    expect(sql).toContain('CREATE UNIQUE INDEX "InvoiceVersionDocument_invoiceVersionId_key"');
    expect(sql).toContain('CREATE UNIQUE INDEX "InvoiceVersionDocument_attachmentId_key"');
    expect(sql).toContain("An invoice document is made only from a finalized invoice version.");
    expect(sql).toContain("An invoice document holds exactly its attachment.");
  });

  it("allows a send only for a FINALIZED version, so a superseded one is refused by the database too", () => {
    expect(sql).toContain("Only a finalized invoice version can be sent; a superseded version cannot.");
    expect(sql).toContain('CREATE UNIQUE INDEX "InvoiceDelivery_invoiceVersionId_sequence_key"');
    expect(sql).toContain('CREATE UNIQUE INDEX "InvoiceDelivery_idempotencyKey_key"');
    expect(sql).toContain('CREATE UNIQUE INDEX "InvoiceDeliveryRecipient_messageOutboxId_key"');
  });

  it("makes AR postings and payments append-only: one root posting per version, corrections and reversals as new rows", () => {
    expect(sql).toContain('CREATE UNIQUE INDEX "InvoiceArPosting_one_root_per_version" ON "InvoiceArPosting"("invoiceVersionId") WHERE "correctsPostingId" IS NULL');
    expect(sql).toContain("An AR posting is not rewritten; correct it with a new posting.");
    expect(sql).toContain("A payment entry is not rewritten; void it with a reversal.");
    expect(sql).toContain('CREATE UNIQUE INDEX "InvoicePayment_reversesPaymentId_key"');
    expect(sql).toContain('CREATE UNIQUE INDEX "InvoicePayment_requestKey_key"');
    expect(sql).toContain('"amountCents" > 0');
    expect(sql).toContain("A payment is recorded against the open receivable of a finalized invoice version.");
    expect(sql).toContain("A reversal repeats the payment it voids.");
  });

  it("lets only the foreign-key actions of a deleted user or event touch an append-only row", () => {
    expect(sql.match(/pg_trigger_depth\(\) > 1/g)!.length).toBeGreaterThanOrEqual(7);
    expect(sql).toContain("An invoice delivery record is never deleted.");
    expect(sql).toContain("A payment entry is never deleted.");
  });

  it("is additive: no drops, deletes, or changes to existing columns", () => {
    for (const statement of sql.split(/;\s*\n/).map((part) => part.trim()).filter(Boolean)) {
      if (/^(CREATE (FUNCTION|TRIGGER)|ALTER TABLE "(MessageAttachment|InvoiceVersionDocument|InvoiceDelivery|InvoiceArPosting|InvoicePayment)" ADD CONSTRAINT)/.test(statement)) continue;
      expect(statement).not.toMatch(/^DROP /);
      expect(statement).not.toMatch(/^DELETE /);
      expect(statement).not.toMatch(/ALTER COLUMN|DROP COLUMN|RENAME/);
    }
    expect(sql).not.toMatch(/\bDROP (TABLE|COLUMN|TYPE|INDEX|TRIGGER|FUNCTION)\b/);
  });

  it("matches the Prisma schema for the new models", () => {
    for (const model of ["MessageAttachment", "InvoiceVersionDocument", "InvoiceDelivery", "InvoiceDeliveryRecipient", "InvoiceArPosting", "InvoicePayment"]) {
      expect(schema).toContain(`model ${model} {`);
      expect(sql).toContain(`CREATE TABLE "${model}"`);
    }
    expect(schema).toContain("invoicePaymentInstructions");
    expect(sql).toContain('ADD COLUMN     "invoicePaymentInstructions" TEXT');
  });
});
