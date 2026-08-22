import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../prisma/migrations/20260808130000_merchandise_catalog/migration.sql", import.meta.url),
  "utf8",
);

/**
 * A minimal simulation of Postgres three-valued (TRUE/FALSE/UNKNOWN) logic,
 * used to prove the artwork-alt-text CHECK constraint the migration installs
 * behaves correctly without needing a live Postgres connection. Only FALSE
 * violates a CHECK constraint — UNKNOWN (SQL NULL) is treated as satisfied,
 * which is exactly the trap the original constraint fell into.
 */
type Trit = true | false | null;
const sqlAnd = (a: Trit, b: Trit): Trit => (a === false || b === false ? false : a === null || b === null ? null : true);
const sqlOr = (a: Trit, b: Trit): Trit => (a === true || b === true ? true : a === null || b === null ? null : false);
const isNull = (value: unknown): Trit => value === null;
const isNotNull = (value: unknown): Trit => value !== null;
/** length(trim(NULL)) >= 3 evaluates to NULL in Postgres, not FALSE. */
const altTextLongEnough = (altText: string | null): Trit => (altText === null ? null : altText.trim().length >= 3);
const checkPasses = (expr: Trit) => expr !== false;

function buggyConstraint(assetId: string | null, altText: string | null) {
  const bothNull = sqlAnd(isNull(assetId), isNull(altText));
  const assetOnlyGate = sqlAnd(isNotNull(assetId), altTextLongEnough(altText));
  return checkPasses(sqlOr(bothNull, assetOnlyGate));
}

function fixedConstraint(assetId: string | null, altText: string | null) {
  const bothNull = sqlAnd(isNull(assetId), isNull(altText));
  const bothPresentAndValid = sqlAnd(sqlAnd(isNotNull(assetId), isNotNull(altText)), altTextLongEnough(altText));
  return checkPasses(sqlOr(bothNull, bothPresentAndValid));
}

describe("merchandise catalog migration: artwork alt-text constraint", () => {
  it("installs the fixed constraint text with an explicit artworkAltText IS NOT NULL conjunct", () => {
    expect(migration).toContain(
      'CHECK (("artworkAssetId" IS NULL AND "artworkAltText" IS NULL) OR ("artworkAssetId" IS NOT NULL AND "artworkAltText" IS NOT NULL AND length(trim("artworkAltText")) >= 3));',
    );
  });

  it("would have silently let a NULL alt text through the old constraint", () => {
    // This is the regression: an assetId with no alt text made the second
    // branch evaluate to NULL/UNKNOWN, not FALSE, so the row passed.
    expect(buggyConstraint("asset_1", null)).toBe(true);
  });

  it("rejects the same NULL alt text under the fixed constraint", () => {
    expect(fixedConstraint("asset_1", null)).toBe(false);
    expect(fixedConstraint("asset_1", "  ")).toBe(false);
    expect(fixedConstraint(null, "orphaned alt text")).toBe(false);
  });

  it("still accepts the two legitimate pairings under the fixed constraint", () => {
    expect(fixedConstraint(null, null)).toBe(true);
    expect(fixedConstraint("asset_1", "A blue camp shirt")).toBe(true);
  });
});
