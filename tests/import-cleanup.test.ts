import { describe, expect, it } from "vitest";
import { planImportCleanup, type CleanupCandidate } from "@/modules/registrations/import-cleanup";

const CANONICAL = /^WR26-\d{13}-[0-9A-Fa-f]{4}$/;

function candidate(overrides: Partial<CleanupCandidate> & { confirmationCode: string }): CleanupCandidate {
  return {
    id: `reg_${overrides.confirmationCode}`,
    accountHolder: "Someone Real",
    status: "CONFIRMED",
    attendeeCount: 1,
    totalCents: 12_500,
    netPaidCents: 0,
    hasImmutableHistory: false,
    ...overrides,
  };
}

describe("planImportCleanup", () => {
  it("keeps canonical bundle codes and drops the legacy per-attendee run", () => {
    const plan = planImportCleanup(
      [
        candidate({ confirmationCode: "WR26-1780602786558-7AC3", totalCents: 25_000 }),
        candidate({ confirmationCode: "WR26-3857-1", totalCents: 25_000 }),
        candidate({ confirmationCode: "WR26-3857-2", totalCents: 0 }),
      ],
      CANONICAL,
    );

    expect(plan.kept.map((row) => row.confirmationCode)).toEqual(["WR26-1780602786558-7AC3"]);
    expect(plan.deleting.map((row) => row.confirmationCode)).toEqual(["WR26-3857-1", "WR26-3857-2"]);
    expect(plan.withheld).toEqual([]);
  });

  it("removes the double-counted money from the event total", () => {
    const plan = planImportCleanup(
      [
        candidate({ confirmationCode: "WR26-1780602786558-7AC3", totalCents: 25_000 }),
        candidate({ confirmationCode: "WR26-3857-1", totalCents: 25_000 }),
      ],
      CANONICAL,
    );

    expect(plan.beforeTotalCents).toBe(50_000);
    expect(plan.afterTotalCents).toBe(25_000);
    expect(plan.beforeCount).toBe(2);
    expect(plan.afterCount).toBe(1);
  });

  it("never deletes a registration that received money", () => {
    const plan = planImportCleanup(
      [candidate({ confirmationCode: "TEST-1001", netPaidCents: 17_500 })],
      CANONICAL,
    );

    expect(plan.deleting).toEqual([]);
    expect(plan.withheld.map((row) => row.confirmationCode)).toEqual(["TEST-1001"]);
    expect(plan.withheld[0].reason).toBe("RECEIVED_MONEY");
    // A withheld row is still counted in the event afterwards.
    expect(plan.afterTotalCents).toBe(plan.beforeTotalCents);
  });

  it("deletes a paid registration only when its code is named explicitly", () => {
    const rows = [candidate({ confirmationCode: "REG-5245C6E924DE", netPaidCents: 12_905 })];

    expect(planImportCleanup(rows, CANONICAL).deleting).toEqual([]);
    expect(
      planImportCleanup(rows, CANONICAL, new Set(["REG-5245C6E924DE"]))
        .deleting.map((row) => row.confirmationCode),
    ).toEqual(["REG-5245C6E924DE"]);
  });

  it("an unrelated code in --also-delete does not widen the delete set", () => {
    const plan = planImportCleanup(
      [candidate({ confirmationCode: "TEST-1001", netPaidCents: 17_500 })],
      CANONICAL,
      new Set(["SOMETHING-ELSE"]),
    );

    expect(plan.deleting).toEqual([]);
    expect(plan.withheld).toHaveLength(1);
  });

  it("withholds a registration carrying immutable operation history", () => {
    const plan = planImportCleanup(
      [candidate({ confirmationCode: "WR26-3857-1", hasImmutableHistory: true })],
      CANONICAL,
    );

    expect(plan.deleting).toEqual([]);
    expect(plan.withheld[0].reason).toBe("IMMUTABLE_HISTORY");
  });

  it("does not let --also-delete override immutable history", () => {
    // The rows are rejected by a database trigger; forcing it would abort the
    // whole transaction rather than delete anything.
    const plan = planImportCleanup(
      [candidate({ confirmationCode: "WR26-3857-1", hasImmutableHistory: true, netPaidCents: 5_000 })],
      CANONICAL,
      new Set(["WR26-3857-1"]),
    );

    expect(plan.deleting).toEqual([]);
    expect(plan.withheld[0].reason).toBe("IMMUTABLE_HISTORY");
  });

  it("still deletes clean duplicates alongside a withheld one", () => {
    const plan = planImportCleanup(
      [
        candidate({ confirmationCode: "WR26-3857-1", hasImmutableHistory: true }),
        candidate({ confirmationCode: "WR26-3857-2" }),
      ],
      CANONICAL,
    );

    expect(plan.deleting.map((row) => row.confirmationCode)).toEqual(["WR26-3857-2"]);
    expect(plan.withheld).toHaveLength(1);
  });

  it("deletes nothing when every code is canonical", () => {
    const plan = planImportCleanup(
      [
        candidate({ confirmationCode: "WR26-1780602786558-7AC3" }),
        candidate({ confirmationCode: "WR26-1785175207169-B9C6" }),
      ],
      CANONICAL,
    );

    expect(plan.deleting).toEqual([]);
    expect(plan.afterCount).toBe(2);
  });

  it("survives a global-flagged pattern instead of skipping alternate rows", () => {
    const plan = planImportCleanup(
      [
        candidate({ confirmationCode: "WR26-1780602786558-7AC3" }),
        candidate({ confirmationCode: "WR26-1785175207169-B9C6" }),
      ],
      /^WR26-\d{13}-[0-9A-Fa-f]{4}$/g,
    );

    expect(plan.kept).toHaveLength(2);
    expect(plan.deleting).toEqual([]);
  });
});
