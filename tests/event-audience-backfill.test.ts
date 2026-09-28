import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ getPrisma: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));

import { backfillEventAudience } from "@/modules/events/audience-backfill";

beforeEach(() => vi.clearAllMocks());

function fixture() {
  const events = [
    // Church-billed, still GENERAL: the classic candidate for the backfill.
    { id: "evt_camporee", name: "Spring Camporee", billingMode: "DEFERRED_ORGANIZATION_INVOICE" as const, audience: "GENERAL" as const },
    // Attendee-paid, already GENERAL: nothing to do.
    { id: "evt_retreat", name: "Women's Retreat", billingMode: "ATTENDEE_PAY" as const, audience: "GENERAL" as const },
    // Already backfilled: idempotency should leave it untouched.
    { id: "evt_camporee_done", name: "Fall Camporee", billingMode: "DEFERRED_ORGANIZATION_INVOICE" as const, audience: "CLUB" as const },
    // Attendee-paid CLUB event (e.g. Man Camp): audience is independent of
    // billing mode, so the backfill must never revert it to GENERAL.
    { id: "evt_man_camp", name: "Man Camp", billingMode: "ATTENDEE_PAY" as const, audience: "CLUB" as const },
  ];
  const event = {
    findMany: vi.fn(async ({ where }: { where: { billingMode: string; audience: { not: string } } }) =>
      events
        .filter((row) => row.billingMode === where.billingMode && row.audience !== where.audience.not)
        .map(({ id, name, billingMode, audience }) => ({ id, name, billingMode, audience })),
    ),
    update: vi.fn(async ({ where, data }: { where: { id: string; audience: string }; data: { audience: "GENERAL" | "CLUB" } }) => {
      const target = events.find((row) => row.id === where.id);
      if (!target || target.audience !== where.audience) throw new Error("not found");
      target.audience = data.audience;
      return target;
    }),
  };
  const prisma = {
    event,
    $transaction: vi.fn(async (operations: Promise<unknown>[]) => Promise.all(operations)),
  };
  mocks.getPrisma.mockReturnValue(prisma);
  return { prisma, events, event };
}

describe("backfillEventAudience (#481)", () => {
  it("is a no-op report in dry-run mode", async () => {
    const { events } = fixture();
    const report = await backfillEventAudience(false);

    expect(report.dryRun).toBe(true);
    expect(report.totalCandidates).toBe(1);
    expect(report.updatedCount).toBe(0);
    expect(report.rows).toEqual([
      { id: "evt_camporee", name: "Spring Camporee", billingMode: "DEFERRED_ORGANIZATION_INVOICE", fromAudience: "GENERAL", toAudience: "CLUB" },
    ]);
    expect(events.find((row) => row.id === "evt_camporee")?.audience).toBe("GENERAL");
  });

  it("sets club-billed events to CLUB when applied, and leaves everything else alone", async () => {
    const { events } = fixture();
    const report = await backfillEventAudience(true);

    expect(report.dryRun).toBe(false);
    expect(report.updatedCount).toBe(1);
    expect(events.find((row) => row.id === "evt_camporee")?.audience).toBe("CLUB");
    // Attendee-paid GENERAL event: untouched.
    expect(events.find((row) => row.id === "evt_retreat")?.audience).toBe("GENERAL");
    // Already-CLUB church event: untouched.
    expect(events.find((row) => row.id === "evt_camporee_done")?.audience).toBe("CLUB");
    // Attendee-paid CLUB event: billing mode never pulls audience back to GENERAL.
    expect(events.find((row) => row.id === "evt_man_camp")?.audience).toBe("CLUB");
  });

  it("is idempotent: a repeated apply finds nothing left to backfill", async () => {
    const { event } = fixture();

    const first = await backfillEventAudience(true);
    expect(first.updatedCount).toBe(1);

    event.update.mockClear();
    const second = await backfillEventAudience(true);

    expect(second.totalCandidates).toBe(0);
    expect(second.updatedCount).toBe(0);
    expect(event.update).not.toHaveBeenCalled();
  });
});
