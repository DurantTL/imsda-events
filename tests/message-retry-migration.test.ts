import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("message-retry active-child database invariant", () => {
  it("covers every active retry child regardless of staff trigger", () => {
    const sql = readFileSync(join(
      process.cwd(),
      "prisma/migrations/20260723130000_message_retry_idempotency/migration.sql",
    ), "utf8");
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "MessageOutbox_active_retry_source_key"',
    );
    expect(sql).toContain(
      '"status" IN (\'PENDING\', \'PROCESSING\')',
    );
    expect(sql).not.toContain("metadata\"->>'trigger'");
  });
});
