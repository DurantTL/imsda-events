import { describe, expect, it } from "vitest";
import {
  membershipCoversDate,
  membershipIntervalsOverlap,
} from "@/modules/people/household-domain";

const d = (iso: string) => new Date(iso);

describe("membershipIntervalsOverlap", () => {
  it("treats two open-ended memberships as overlapping", () => {
    expect(
      membershipIntervalsOverlap(
        { effectiveFrom: d("2026-01-01T00:00:00.000Z"), effectiveTo: null },
        { effectiveFrom: d("2026-06-01T00:00:00.000Z"), effectiveTo: null },
      ),
    ).toBe(true);
  });

  it("does not overlap a closed membership followed by a later open one", () => {
    expect(
      membershipIntervalsOverlap(
        { effectiveFrom: d("2026-01-01T00:00:00.000Z"), effectiveTo: d("2026-06-01T00:00:00.000Z") },
        { effectiveFrom: d("2026-06-01T00:00:00.000Z"), effectiveTo: null },
      ),
    ).toBe(false);
  });

  it("overlaps when the new interval starts before the old one closes", () => {
    expect(
      membershipIntervalsOverlap(
        { effectiveFrom: d("2026-01-01T00:00:00.000Z"), effectiveTo: d("2026-06-01T00:00:00.000Z") },
        { effectiveFrom: d("2026-05-31T00:00:00.000Z"), effectiveTo: null },
      ),
    ).toBe(true);
  });

  it("treats a null effectiveFrom as unbounded in the past", () => {
    expect(
      membershipIntervalsOverlap(
        { effectiveFrom: null, effectiveTo: null },
        { effectiveFrom: d("2026-01-01T00:00:00.000Z"), effectiveTo: null },
      ),
    ).toBe(true);
  });

  it("does not overlap two closed intervals in different years", () => {
    expect(
      membershipIntervalsOverlap(
        { effectiveFrom: d("2025-01-01T00:00:00.000Z"), effectiveTo: d("2025-06-01T00:00:00.000Z") },
        { effectiveFrom: d("2026-01-01T00:00:00.000Z"), effectiveTo: d("2026-06-01T00:00:00.000Z") },
      ),
    ).toBe(false);
  });
});

describe("membershipCoversDate", () => {
  it("covers a date within an open-ended membership", () => {
    expect(
      membershipCoversDate(
        { effectiveFrom: d("2026-01-01T00:00:00.000Z"), effectiveTo: null },
        d("2026-06-01T00:00:00.000Z"),
      ),
    ).toBe(true);
  });

  it("does not cover a date after the membership closed", () => {
    expect(
      membershipCoversDate(
        { effectiveFrom: d("2026-01-01T00:00:00.000Z"), effectiveTo: d("2026-06-01T00:00:00.000Z") },
        d("2026-07-01T00:00:00.000Z"),
      ),
    ).toBe(false);
  });

  it("does not cover a date before the membership started", () => {
    expect(
      membershipCoversDate(
        { effectiveFrom: d("2026-01-01T00:00:00.000Z"), effectiveTo: null },
        d("2025-12-01T00:00:00.000Z"),
      ),
    ).toBe(false);
  });

  it("the closing instant itself is no longer covered ([from, to) is half-open)", () => {
    expect(
      membershipCoversDate(
        { effectiveFrom: d("2026-01-01T00:00:00.000Z"), effectiveTo: d("2026-06-01T00:00:00.000Z") },
        d("2026-06-01T00:00:00.000Z"),
      ),
    ).toBe(false);
  });

  it("treats a null effectiveFrom as always started", () => {
    expect(membershipCoversDate({ effectiveFrom: null, effectiveTo: null }, d("1999-01-01T00:00:00.000Z"))).toBe(true);
  });
});
