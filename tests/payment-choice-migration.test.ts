import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../prisma/migrations/20260723121000_promoted_waitlist_payment_choice/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("promoted-waitlist payment-choice migration", () => {
  it("enforces append-only history and prevents parent deletion from erasing it", () => {
    expect(migration).toContain(
      'CREATE TRIGGER "RegistrationPaymentChoiceOperation_immutable"',
    );
    expect(migration).toContain(
      "BEFORE UPDATE OR DELETE ON \"RegistrationPaymentChoiceOperation\"",
    );
    expect(migration.match(/ON DELETE RESTRICT ON UPDATE CASCADE;/g))
      .toHaveLength(2);
    expect(migration).not.toContain("ON DELETE CASCADE ON UPDATE CASCADE;");
  });
});
