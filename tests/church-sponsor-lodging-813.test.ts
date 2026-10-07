import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ getPrisma: vi.fn(), writeAuditLog: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: dependencies.writeAuditLog }));

import {
  ChurchSponsorFlagError,
  clearChurchSponsorFlag,
  listOpenChurchSponsorFlags,
  setChurchShare,
} from "@/modules/promo-codes/church-sponsor-lodging";
import { lodgingChargeImpact, type RegistrationPromo } from "@/modules/lodging/pricing";

beforeEach(() => { dependencies.writeAuditLog.mockClear(); });

type State = { discount: number; moved: number };

/** A transaction double that behaves like the rows it replaces: an update really stores, a flag really opens and closes. */
function transaction(options: { sponsored?: boolean; deferred?: boolean; finalized?: boolean; state?: State; reviewedShareCents?: number | null } = {}) {
  const state = options.state ?? { discount: 4_500, moved: 0 };
  let open: { id: string; deltaCents: number; sourceKey: string } | null = null;
  const tx = {
    promoCodeRedemption: {
      findUnique: vi.fn().mockResolvedValue({
        id: "red_1",
        promoCode: options.sponsored === false ? { sponsoringOrganizationId: null, sponsoringOrganization: null } : { sponsoringOrganizationId: "church_1", sponsoringOrganization: { name: "Synthetic Church" } },
      }),
      findUniqueOrThrow: vi.fn().mockImplementation(async () => ({ id: "red_1", discountAmountCents: state.discount, sponsorLodgingChangeCents: state.moved })),
      update: vi.fn().mockImplementation(async ({ data }: { data: { sponsorLodgingChangeCents: number } }) => { state.moved = data.sponsorLodgingChangeCents; return {}; }),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
    event: { findUnique: vi.fn().mockResolvedValue({ billingMode: options.deferred ? "DEFERRED_ORGANIZATION_INVOICE" : "ATTENDEE_PAY" }) },
    invoiceVersion: { findFirst: vi.fn().mockResolvedValue(options.finalized ? { id: "inv_v1" } : null) },
    churchSponsorFinanceReview: {
      findFirst: vi.fn().mockImplementation(async ({ where }: { where: { reviewedShareCents?: unknown } }) => (
        where.reviewedShareCents !== undefined ? (options.reviewedShareCents === undefined || options.reviewedShareCents === null ? null : { reviewedShareCents: options.reviewedShareCents }) : open ? { id: open.id } : null
      )),
      create: vi.fn().mockImplementation(async ({ data }: { data: { deltaCents: number; sourceKey: string } }) => { open = { id: "flag_1", deltaCents: data.deltaCents, sourceKey: data.sourceKey }; return { id: "flag_1" }; }),
      update: vi.fn().mockImplementation(async ({ data }: { data: { deltaCents?: number; sourceKey?: string; clearedAt?: Date } }) => {
        if (data.clearedAt) open = null;
        else if (open) open = { ...open, deltaCents: data.deltaCents ?? open.deltaCents, sourceKey: data.sourceKey ?? open.sourceKey };
        return { id: "flag_1" };
      }),
    },
  };
  return { tx, state, flag: () => open };
}

const basis = { currentLodgingCents: 8_000, storedLodgingCents: 4_000 };
const set = (tx: unknown, desiredCents: number, sourceKey = "lodging:ver_1") => setChurchShare(tx as never, { eventId: "event_1", registrationId: "reg_1", desiredCents, sourceKey, basis, actorUserId: "user_1" });

describe("the church's share is a recomputed figure, stored idempotently (#813)", () => {
  it("stores the recomputed figure, whatever it was before, and returns exactly to zero on a revert", async () => {
    const { tx, state } = transaction();
    expect(await set(tx, 2_000)).toEqual({ status: "UPDATED", deltaCents: 2_000, churchName: "Synthetic Church", registrationOwedCents: 6_500 });
    expect(await set(tx, 4_000)).toMatchObject({ status: "UPDATED", deltaCents: 2_000, registrationOwedCents: 8_500 });
    expect(await set(tx, 0)).toMatchObject({ status: "UPDATED", deltaCents: -4_000, registrationOwedCents: 4_500 });
    expect(state.moved).toBe(0);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
  });

  it("says nothing moved, and writes no audit row, when the stored value already equals the recomputed one", async () => {
    const { tx } = transaction({ state: { discount: 4_500, moved: 2_000 } });
    expect(await set(tx, 2_000)).toEqual({ status: "UNCHANGED", churchName: "Synthetic Church", registrationOwedCents: 6_500 });
    // The row is touched (same value) so a racing amendment on an older snapshot conflicts and retries; nothing is audited.
    expect(tx.promoCodeRedemption.update).toHaveBeenCalledTimes(1);
    expect(tx.promoCodeRedemption.update.mock.calls[0]![0].data).toEqual({ sponsorLodgingChangeCents: 2_000 });
    expect(dependencies.writeAuditLog).not.toHaveBeenCalled();
  });

  it("audits every stored change with before, after and the basis, ids and amounts only", async () => {
    const { tx } = transaction();
    await set(tx, 2_000);
    const [entry] = dependencies.writeAuditLog.mock.calls[0]!;
    expect(entry.action).toBe("CHURCH_SPONSOR_SHARE_CHANGED");
    expect(Object.keys(entry.metadata).sort()).toEqual(["afterCents", "beforeCents", "churchId", "currentLodgingCents", "deltaCents", "fromCents", "redemptionId", "registrationId", "sourceKey", "storedLodgingCents", "toCents"]);
    expect(entry.metadata).toMatchObject({ beforeCents: 0, afterCents: 2_000, fromCents: 4_500, toCents: 6_500, deltaCents: 2_000, currentLodgingCents: 8_000, storedLodgingCents: 4_000, sourceKey: "lodging:ver_1" });
    expect(JSON.stringify(entry)).not.toMatch(/Synthetic Church|REG-|@/);
  });

  it("has no clamp: the stored figure is the recomputed one, and the readers floor the registration at $0", async () => {
    const { tx, state } = transaction({ state: { discount: 1_000, moved: 0 } });
    expect(await set(tx, -4_000)).toMatchObject({ status: "UPDATED", deltaCents: -4_000, registrationOwedCents: 0 });
    expect(state.moved).toBe(-4_000);
    expect(await set(tx, 0)).toMatchObject({ status: "UPDATED", registrationOwedCents: 1_000 });
  });

  it("does nothing for a registration with no church-sponsored code", async () => {
    const plain = transaction({ sponsored: false });
    expect(await set(plain.tx, 2_000)).toBeNull();
    expect(plain.tx.promoCodeRedemption.update).not.toHaveBeenCalled();
    const noRedemption = transaction();
    noRedemption.tx.promoCodeRedemption.findUnique.mockResolvedValue(null);
    expect(await set(noRedemption.tx, 2_000)).toBeNull();
  });

  it("a capped code plus an amendment never takes the church past the cap, and a 50% code splits the change in half", () => {
    const promo = (discountValue: number, maximumDiscountCents: number | null): RegistrationPromo => ({ code: "CHURCH", discountType: "PERCENT_BPS", discountValue, maximumDiscountCents, minimumSubtotalCents: null, coversLodging: true, sponsored: true });
    const share = (other: number, stored: number, current: number, p: RegistrationPromo) => lodgingChargeImpact({ otherCents: other, fromCents: stored, toCents: current, promo: p }).discountDeltaCents;
    // 50% code, no cap: half of the lodging change.
    expect(share(5_000, 4_000, 8_000, promo(5_000, null))).toBe(2_000);
    // 50% code capped at $60: the amendment recorded discount(other + stored); the share tops it up to the cap and no further.
    const capped = promo(5_000, 6_000);
    for (const other of [5_000, 9_000, 20_000]) {
      for (const current of [0, 4_000, 8_000, 40_000]) {
        const total = Math.min(6_000, Math.round((other + 4_000) * 0.5)) + share(other, 4_000, current, capped);
        expect(total).toBeLessThanOrEqual(6_000);
        expect(total).toBe(Math.min(6_000, Math.round((other + current) * 0.5)));
      }
    }
    // A full revert is exactly zero whatever the cap does.
    expect(share(20_000, 4_000, 4_000, capped)).toBe(0);
  });
});

describe("the finalized-invoice rule (#813)", () => {
  it("a finalized church invoice on an invoiced event is flagged for the finance office and nothing is stored", async () => {
    const { tx, state, flag } = transaction({ deferred: true, finalized: true });
    expect(await set(tx, 2_000, "lodging:ver_1")).toEqual({ status: "FLAGGED", deltaCents: 2_000, churchName: "Synthetic Church" });
    expect(state).toEqual({ discount: 4_500, moved: 0 });
    expect(tx.promoCodeRedemption.update).not.toHaveBeenCalled();
    expect(flag()).toMatchObject({ deltaCents: 2_000, sourceKey: "lodging:ver_1" });
    expect(tx.invoiceVersion.findFirst.mock.calls[0]![0].where).toMatchObject({ status: "FINALIZED", invoice: { partyKind: "ORGANIZATION", partyId: "church_1" } });
    const [entry] = dependencies.writeAuditLog.mock.calls.at(-1)!;
    expect(entry.action).toBe("CHURCH_SPONSOR_SHARE_FLAGGED");
    expect(JSON.stringify(entry)).not.toMatch(/Synthetic Church|REG-|@/);
  });

  it("keeps one open flag per registration, updated in place, and closes it when the share returns to the invoiced amount", async () => {
    const { tx, flag } = transaction({ deferred: true, finalized: true });
    await set(tx, 2_000, "lodging:ver_1");
    await set(tx, 4_000, "lodging:ver_2");
    expect(tx.churchSponsorFinanceReview.create).toHaveBeenCalledTimes(1);
    expect(flag()).toMatchObject({ deltaCents: 4_000, sourceKey: "lodging:ver_2" });
    expect(await set(tx, 0, "lodging:ver_3")).toMatchObject({ status: "UNCHANGED" });
    expect(flag()).toBeNull();
  });

  it("once finance has cleared a flag, only a recompute that differs from the reviewed share raises another", async () => {
    const same = transaction({ deferred: true, finalized: true, reviewedShareCents: 2_000 });
    expect(await set(same.tx, 2_000)).toMatchObject({ status: "UNCHANGED" });
    expect(same.tx.churchSponsorFinanceReview.create).not.toHaveBeenCalled();
    const different = transaction({ deferred: true, finalized: true, reviewedShareCents: 2_000 });
    expect(await set(different.tx, 2_500)).toEqual({ status: "FLAGGED", deltaCents: 500, churchName: "Synthetic Church" });
    expect(different.tx.churchSponsorFinanceReview.create.mock.calls[0]![0].data).toMatchObject({ deltaCents: 500, desiredShareCents: 2_500 });
  });

  it("an attendee-pay event has no invoice vehicle: an old invoice of the church never freezes the share", async () => {
    const { tx, state } = transaction({ deferred: false, finalized: true });
    expect(await set(tx, 2_000)).toMatchObject({ status: "UPDATED", deltaCents: 2_000 });
    expect(state.moved).toBe(2_000);
    expect(tx.invoiceVersion.findFirst).not.toHaveBeenCalled();
    expect(tx.churchSponsorFinanceReview.create).not.toHaveBeenCalled();
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
        findFirst: vi.fn().mockResolvedValue(flag && { id: "flag_1", churchId: "church_1", registrationId: "reg_1", deltaCents: 2_000, desiredShareCents: 4_000, ...flag }),
        updateMany: vi.fn().mockResolvedValue({ count: updated }),
      },
    };
    return { tx, prisma: { $transaction: (run: (client: unknown) => unknown) => run(tx) } };
  }

  it("clears a flag once, audited, changing no amount", async () => {
    const { tx, prisma } = clearPrisma({ clearedAt: null });
    await clearChurchSponsorFlag({ eventId: "event_1", flagId: "flag_1", actorUserId: "user_1", note: "  Revised through the invoice revision path  " }, prisma as never);
    expect(tx.churchSponsorFinanceReview.updateMany.mock.calls[0]![0]).toMatchObject({ where: { id: "flag_1", clearedAt: null }, data: { clearedByUserId: "user_1", clearNote: "Revised through the invoice revision path", reviewedShareCents: 4_000 } });
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
