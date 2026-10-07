import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ getPrisma: vi.fn(), writeAuditLog: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: dependencies.writeAuditLog }));

import {
  ChurchSponsorFlagError,
  clearChurchSponsorFlag,
  listOpenChurchSponsorFlags,
  settleChurchShareForLodgingChange,
} from "@/modules/promo-codes/church-sponsor-lodging";
import { lodgingChargeImpact, type RegistrationPromo } from "@/modules/lodging/pricing";

beforeEach(() => { dependencies.writeAuditLog.mockClear(); });

type State = { discount: number; moved: number };

/** A transaction double that behaves like the rows it replaces: an increment really adds, an upsert really stores. */
function transaction(options: { sponsored?: boolean; finalized?: boolean; state?: State } = {}) {
  const state = options.state ?? { discount: 4_500, moved: 0 };
  const flags: Array<Record<string, unknown>> = [];
  const tx = {
    promoCodeRedemption: {
      findUnique: vi.fn().mockResolvedValue({
        id: "red_1",
        promoCode: options.sponsored === false ? { sponsoringOrganizationId: null, sponsoringOrganization: null } : { sponsoringOrganizationId: "church_1", sponsoringOrganization: { name: "Synthetic Church" } },
      }),
      findUniqueOrThrow: vi.fn().mockImplementation(async () => ({ id: "red_1", discountAmountCents: state.discount, sponsorLodgingChangeCents: state.moved })),
      update: vi.fn().mockImplementation(async ({ data }: { data: { sponsorLodgingChangeCents: { increment: number } } }) => {
        state.moved += data.sponsorLodgingChangeCents.increment;
        return { id: "red_1", discountAmountCents: state.discount, sponsorLodgingChangeCents: state.moved };
      }),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
    invoiceVersion: { findFirst: vi.fn().mockResolvedValue(options.finalized ? { id: "inv_v1" } : null) },
    churchSponsorFinanceReview: {
      upsert: vi.fn().mockImplementation(async ({ create }: { create: Record<string, unknown> }) => { flags.push(create); return { id: `flag_${flags.length}` }; }),
    },
  };
  return { tx, state, flags };
}

const settle = (tx: unknown, deltaCents: number) => settleChurchShareForLodgingChange(tx as never, {
  eventId: "event_1", registrationId: "reg_1", lodgingRequestVersionId: `ver_${Math.random()}`, deltaCents, actorUserId: "user_1",
});

describe("a lodging change moves the church's amount owed (#813)", () => {
  it("applies an increase, a decrease and a revert, and lands exactly where it started", async () => {
    const { tx, state } = transaction();
    const up = await settle(tx, 2_000);
    expect(up).toEqual({ status: "UPDATED", deltaCents: 2_000, churchName: "Synthetic Church", registrationOwedCents: 6_500 });
    expect(state).toEqual({ discount: 4_500, moved: 2_000 });
    expect(await settle(tx, 2_000)).toMatchObject({ registrationOwedCents: 8_500 });
    expect(await settle(tx, -2_000)).toMatchObject({ deltaCents: -2_000, registrationOwedCents: 6_500 });
    expect(await settle(tx, -2_000)).toMatchObject({ registrationOwedCents: 4_500 });
    expect(state.moved).toBe(0);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(4);
  });

  it("writes one audit row per change with ids and amounts only", async () => {
    const { tx } = transaction();
    await settle(tx, 2_000);
    expect(dependencies.writeAuditLog).toHaveBeenCalledTimes(1);
    const [entry] = dependencies.writeAuditLog.mock.calls[0]!;
    expect(entry.action).toBe("CHURCH_SPONSOR_SHARE_CHANGED");
    expect(Object.keys(entry.metadata).sort()).toEqual(["churchId", "deltaCents", "fromCents", "lodgingRequestVersionId", "redemptionId", "registrationId", "requestedDeltaCents", "toCents"]);
    expect(entry.metadata).toMatchObject({ fromCents: 4_500, toCents: 6_500, deltaCents: 2_000, churchId: "church_1", redemptionId: "red_1", registrationId: "reg_1" });
    expect(JSON.stringify(entry)).not.toMatch(/Synthetic Church|REG-|@/);
    dependencies.writeAuditLog.mockClear();
  });

  it("never takes a registration below $0, and says what was really applied", async () => {
    const { tx, state } = transaction({ state: { discount: 1_000, moved: 0 } });
    const down = await settle(tx, -4_000);
    expect(down).toMatchObject({ status: "UPDATED", deltaCents: -1_000, registrationOwedCents: 0 });
    expect(state.moved).toBe(-1_000);
    dependencies.writeAuditLog.mockClear();
    const nothing = await settle(tx, -500);
    expect(nothing).toMatchObject({ deltaCents: 0, registrationOwedCents: 0 });
    expect(tx.promoCodeRedemption.update).toHaveBeenCalledTimes(1);
    expect(dependencies.writeAuditLog).not.toHaveBeenCalled();
  });

  it("does nothing for a registration with no church-sponsored code, or no change", async () => {
    const plain = transaction({ sponsored: false });
    expect(await settle(plain.tx, 2_000)).toBeNull();
    expect(plain.tx.promoCodeRedemption.update).not.toHaveBeenCalled();
    const none = transaction();
    expect(await settle(none.tx, 0)).toBeNull();
    expect(none.tx.promoCodeRedemption.findUnique).not.toHaveBeenCalled();
    const noRedemption = transaction();
    noRedemption.tx.promoCodeRedemption.findUnique.mockResolvedValue(null);
    expect(await settle(noRedemption.tx, 2_000)).toBeNull();
  });

  it("follows the code's own math: a 50% code moves half the list change, a 100% code all of it", async () => {
    const promo = (discountValue: number): RegistrationPromo => ({ code: "CHURCH", discountType: "PERCENT_BPS", discountValue, maximumDiscountCents: null, minimumSubtotalCents: null, coversLodging: true, sponsored: true });
    const half = lodgingChargeImpact({ otherCents: 5_000, fromCents: 4_000, toCents: 8_000, promo: promo(5_000) });
    const full = lodgingChargeImpact({ otherCents: 5_000, fromCents: 4_000, toCents: 8_000, promo: promo(10_000) });
    const a = transaction({ state: { discount: 4_500, moved: 0 } });
    expect(await settle(a.tx, half.discountDeltaCents)).toMatchObject({ deltaCents: 2_000, registrationOwedCents: 6_500 });
    expect(half.registrantDeltaCents).toBe(2_000);
    const b = transaction({ state: { discount: 9_000, moved: 0 } });
    expect(await settle(b.tx, full.discountDeltaCents)).toMatchObject({ deltaCents: 4_000, registrationOwedCents: 13_000 });
    expect(full.registrantDeltaCents).toBe(0);
    dependencies.writeAuditLog.mockClear();
  });

  it("a finalized church invoice is flagged for the finance office and nothing moves", async () => {
    const { tx, state, flags } = transaction({ finalized: true });
    const outcome = await settle(tx, 2_000);
    expect(outcome).toEqual({ status: "FLAGGED", deltaCents: 2_000, churchName: "Synthetic Church" });
    expect(state).toEqual({ discount: 4_500, moved: 0 });
    expect(tx.promoCodeRedemption.update).not.toHaveBeenCalled();
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ eventId: "event_1", registrationId: "reg_1", churchId: "church_1", invoiceVersionId: "inv_v1", deltaCents: 2_000 });
    expect(tx.invoiceVersion.findFirst.mock.calls[0]![0].where).toMatchObject({ status: "FINALIZED", invoice: { partyKind: "ORGANIZATION", partyId: "church_1" } });
    const [entry] = dependencies.writeAuditLog.mock.calls.at(-1)!;
    expect(entry.action).toBe("CHURCH_SPONSOR_SHARE_FLAGGED");
    expect(JSON.stringify(entry)).not.toMatch(/Synthetic Church|REG-|@/);
    dependencies.writeAuditLog.mockClear();
  });
});

describe("the finance office's flags (#813)", () => {
  it("lists open flags with a church name and confirmation code only", async () => {
    const prisma = {
      churchSponsorFinanceReview: {
        findMany: vi.fn().mockResolvedValue([
          { id: "flag_1", churchId: "church_1", deltaCents: 2_000, createdAt: new Date("2027-05-20T12:00:00Z"), invoiceVersionId: "inv_v1", church: { name: "Synthetic Church" }, registration: { confirmationCode: "SYN-0001" } },
        ]),
      },
    };
    const rows = await listOpenChurchSponsorFlags("event_1", prisma as never);
    expect(rows).toEqual([{ id: "flag_1", churchId: "church_1", churchName: "Synthetic Church", confirmationCode: "SYN-0001", deltaCents: 2_000, createdAt: "2027-05-20T12:00:00.000Z", invoiceVersionId: "inv_v1" }]);
    const query = prisma.churchSponsorFinanceReview.findMany.mock.calls[0]![0];
    expect(query.where).toEqual({ eventId: "event_1", clearedAt: null });
    expect(JSON.stringify(query.select)).not.toMatch(/attendee|firstName|lastName|email|profile/i);
  });

  function clearPrisma(flag: { clearedAt: Date | null } | null, updated = 1) {
    const tx = {
      churchSponsorFinanceReview: {
        findFirst: vi.fn().mockResolvedValue(flag && { id: "flag_1", churchId: "church_1", registrationId: "reg_1", deltaCents: 2_000, ...flag }),
        updateMany: vi.fn().mockResolvedValue({ count: updated }),
      },
    };
    return { tx, prisma: { $transaction: (run: (client: unknown) => unknown) => run(tx) } };
  }

  it("clears a flag once, audited, changing no amount", async () => {
    const { tx, prisma } = clearPrisma({ clearedAt: null });
    await clearChurchSponsorFlag({ eventId: "event_1", flagId: "flag_1", actorUserId: "user_1", note: "  Revised through the invoice revision path  " }, prisma as never);
    expect(tx.churchSponsorFinanceReview.updateMany.mock.calls[0]![0]).toMatchObject({ where: { id: "flag_1", clearedAt: null }, data: { clearedByUserId: "user_1", clearNote: "Revised through the invoice revision path" } });
    const [entry] = dependencies.writeAuditLog.mock.calls.at(-1)!;
    expect(entry.action).toBe("CHURCH_SPONSOR_FLAG_CLEARED");
    dependencies.writeAuditLog.mockClear();
  });

  it("refuses a second clear and a flag of another event", async () => {
    const twice = clearPrisma({ clearedAt: new Date() }, 0);
    const again = await clearChurchSponsorFlag({ eventId: "event_1", flagId: "flag_1", actorUserId: "user_1" }, twice.prisma as never).catch((error: unknown) => error);
    expect(again).toBeInstanceOf(ChurchSponsorFlagError);
    expect((again as ChurchSponsorFlagError).code).toBe("ALREADY_CLEARED");
    const missing = clearPrisma(null);
    const gone = await clearChurchSponsorFlag({ eventId: "event_2", flagId: "flag_1", actorUserId: "user_1" }, missing.prisma as never).catch((error: unknown) => error);
    expect((gone as ChurchSponsorFlagError).code).toBe("FLAG_NOT_FOUND");
    expect(missing.tx.churchSponsorFinanceReview.findFirst.mock.calls[0]![0].where).toEqual({ id: "flag_1", eventId: "event_2" });
    expect(dependencies.writeAuditLog).not.toHaveBeenCalled();
  });
});
