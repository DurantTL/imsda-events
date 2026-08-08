import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const schema = readFileSync("prisma/schema.prisma", "utf8");
const migration = readFileSync(
  "prisma/migrations/20260807130000_event_payment_instruction_versions/migration.sql",
  "utf8",
);
const repository = readFileSync("modules/events/repository.ts", "utf8");
const messaging = readFileSync("modules/communications/transactional-messages.ts", "utf8");

describe("event-owned payment instruction contract", () => {
  it("stores approved instructions as immutable event versions", () => {
    expect(schema).toContain("model EventPaymentInstructionVersion");
    expect(schema).toContain("@@unique([eventId, versionNumber])");
    expect(migration).toContain('CREATE TABLE "EventPaymentInstructionVersion"');
    expect(migration).toContain('ON DELETE CASCADE');
    expect(repository).toContain("eventPaymentInstructionVersion.create");
    expect(repository).toContain("versionNumber: (currentPaymentInstructions?.versionNumber ?? 0) + 1");
  });

  it("uses approved event guidance only for applicable attendee-pay balances", () => {
    expect(messaging).toContain("approvedInstructions?.trim() || \"\"");
    expect(messaging).toContain('billingMode === "ATTENDEE_PAY" && balanceCents > 0');
    expect(messaging).toContain('if (key === "WAITLIST_JOINED")');
  });
});
