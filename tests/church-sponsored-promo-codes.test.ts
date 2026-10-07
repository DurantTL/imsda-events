import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ getPrisma: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));

import { Prisma } from "@prisma/client";
import {
  createPromoCode,
  updatePromoCode,
  PromoCodeOperationError,
} from "@/modules/promo-codes/repository";
import {
  listChurchSponsoredPromoLines,
  sumChurchSponsoredPromoCents,
} from "@/modules/promo-codes/church-sponsored-repository";
import {
  billedSponsoredLines,
  eventBillsSponsoredPromoCodes,
  summarizeSponsoredLines,
  type ChurchSponsoredPromoLine,
} from "@/modules/promo-codes/church-sponsored";
import { churchAmountsOwedCsvRows } from "@/modules/club-registrations/church-owed";
import { promoCodeInputSchema, updatePromoCodeInputSchema } from "@/modules/promo-codes/schemas";
import { savedPromoCodeEditorDraft, normalizePromoCodeEditorDraft, isPromoCodeEditorDraftDirty } from "@/modules/promo-codes/editor-draft";

const baseInput = {
  code: "CHURCH25",
  isActive: true,
  discountType: "FIXED_CENTS" as const,
  discountValue: 2_500,
  startsOn: null,
  endsOn: null,
  minimumSubtotalCents: null,
  maximumUses: null,
  maximumDiscountCents: null,
};

function txFor(options: {
  audience?: "GENERAL" | "CLUB";
  billingMode?: "ATTENDEE_PAY" | "DEFERRED_ORGANIZATION_INVOICE";
  church?: { type: string; isActive: boolean } | null;
  existing?: Record<string, unknown> | null;
  updateCount?: number;
}) {
  const auditLog = { create: vi.fn().mockResolvedValue({}) };
  const promoCode = {
    create: vi.fn().mockImplementation(async ({ data }) => ({ id: "promo_1", ...data })),
    findFirst: vi.fn().mockResolvedValue(options.existing ?? null),
    updateMany: vi.fn().mockResolvedValue({ count: options.updateCount ?? 1 }),
    findMany: vi.fn().mockResolvedValue([]),
  };
  const tx = {
    event: {
      findUnique: vi.fn().mockResolvedValue({
        id: "event_1",
        audience: options.audience ?? "GENERAL",
        billingMode: options.billingMode ?? "ATTENDEE_PAY",
        timezone: "America/Chicago",
      }),
    },
    organization: {
      findUnique: vi.fn().mockResolvedValue(options.church === undefined ? { type: "CHURCH", isActive: true } : options.church),
    },
    promoCode,
    auditLog,
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    $transaction: async (callback: (client: unknown) => unknown) => callback(tx),
  };
  dependencies.getPrisma.mockReturnValue(tx);
  return tx;
}

const existingPromo = (overrides: Record<string, unknown> = {}) => ({
  id: "promo_1",
  eventId: "event_1",
  code: "CHURCH25",
  normalizedCode: "CHURCH25",
  isActive: true,
  redeemedCount: 0,
  sponsoringOrganizationId: null,
  ...overrides,
});

const updateInput = { ...baseInput, expectedUpdatedAt: "2026-09-01T12:00:00.000Z" };

beforeEach(() => vi.clearAllMocks());

describe("linking a sponsoring church (#545)", () => {
  it("links an active CHURCH organization on a GENERAL event and audits ids only", async () => {
    const tx = txFor({});
    await createPromoCode("event_1", { ...baseInput, sponsoringOrganizationId: "church_1" }, "user_1");
    expect(tx.promoCode.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ sponsoringOrganizationId: "church_1" }),
    });
    const audit = tx.auditLog.create.mock.calls.map(([call]) => call.data);
    const linked = audit.find((entry) => entry.action === "PROMO_CODE_SPONSOR_LINKED");
    expect(linked?.metadata).toEqual({
      promoCodeId: "promo_1",
      sponsoringOrganizationId: "church_1",
      previousSponsoringOrganizationId: null,
    });
    expect(JSON.stringify(linked)).not.toMatch(/name/i);
  });

  it.each(["COMPANY", "GROUP"])("links an active %s as the sponsoring congregation (#822)", async (type) => {
    const tx = txFor({ church: { type, isActive: true } });
    await createPromoCode("event_1", { ...baseInput, sponsoringOrganizationId: "church_1" }, "user_1");
    expect(tx.promoCode.create).toHaveBeenCalledWith({ data: expect.objectContaining({ sponsoringOrganizationId: "church_1" }) });
  });

  it.each([{ type: "SCHOOL", isActive: true }, { type: "COMPANY", isActive: false }])("rejects %j as a sponsor (#822)", async (church) => {
    const tx = txFor({ church });
    await expect(
      createPromoCode("event_1", { ...baseInput, sponsoringOrganizationId: "church_1" }, "user_1"),
    ).rejects.toMatchObject({ code: "PROMO_CODE_SPONSOR_INVALID" });
    expect(tx.promoCode.create).not.toHaveBeenCalled();
  });

  it("rejects a sponsor on a CLUB event", async () => {
    txFor({ audience: "CLUB" });
    await expect(
      createPromoCode("event_1", { ...baseInput, sponsoringOrganizationId: "church_1" }, "user_1"),
    ).rejects.toMatchObject({ code: "PROMO_CODE_SPONSOR_INVALID" } satisfies Partial<PromoCodeOperationError>);
  });

  it("rejects a sponsor on a GENERAL event that bills organizations (#545)", async () => {
    const tx = txFor({ billingMode: "DEFERRED_ORGANIZATION_INVOICE" });
    await expect(
      createPromoCode("event_1", { ...baseInput, sponsoringOrganizationId: "church_1" }, "user_1"),
    ).rejects.toMatchObject({ code: "PROMO_CODE_SPONSOR_INVALID" });
    expect(tx.promoCode.create).not.toHaveBeenCalled();
  });

  it("locks the event row FOR NO KEY UPDATE with the timeout scoped to the lock wait only (#545)", async () => {
    const tx = txFor({});
    await createPromoCode("event_1", { ...baseInput, sponsoringOrganizationId: "church_1" }, "user_1");
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    const [strings] = tx.$queryRaw.mock.calls[0] as unknown as [string[]];
    expect(strings.join("?")).toContain("FOR NO KEY UPDATE");
    expect(strings.join("?")).not.toMatch(/FOR UPDATE/);
    expect(tx.$executeRawUnsafe.mock.calls.map(([sql]) => sql)).toEqual([
      "SET LOCAL lock_timeout = '5s'",
      "SET LOCAL lock_timeout = 0",
    ]);
    const order = [tx.$executeRawUnsafe.mock.invocationCallOrder[0], tx.$queryRaw.mock.invocationCallOrder[0], tx.$executeRawUnsafe.mock.invocationCallOrder[1]];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("reports a lock timeout or deadlock as a readable retry message, not a 500", async () => {
    for (const failure of [
      Object.assign(new Error("lock timeout"), { code: "55P03" }),
      new Prisma.PrismaClientKnownRequestError("deadlock detected", { code: "P2034", clientVersion: "test" }),
    ]) {
      const tx = txFor({ existing: existingPromo() });
      tx.promoCode.updateMany.mockRejectedValue(failure);
      await expect(
        updatePromoCode("event_1", "promo_1", { ...updateInput, isActive: false }, "user_1"),
      ).rejects.toMatchObject({ code: "PROMO_CODE_BUSY" });
      const createTx = txFor({});
      createTx.promoCode.create.mockRejectedValue(failure);
      await expect(createPromoCode("event_1", baseInput, "user_1")).rejects.toMatchObject({ code: "PROMO_CODE_BUSY" });
    }
  });

  it("rejects a club organization, an inactive church, and an unknown organization", async () => {
    for (const church of [{ type: "CLUB", isActive: true }, { type: "CHURCH", isActive: false }, null]) {
      txFor({ church });
      await expect(
        createPromoCode("event_1", { ...baseInput, sponsoringOrganizationId: "org_1" }, "user_1"),
      ).rejects.toMatchObject({ code: "PROMO_CODE_SPONSOR_INVALID" });
    }
  });

  it("creates a code with no sponsor and no sponsor audit when none is given", async () => {
    const tx = txFor({});
    await createPromoCode("event_1", baseInput, "user_1");
    expect(tx.organization.findUnique).not.toHaveBeenCalled();
    expect(tx.auditLog.create.mock.calls.map(([call]) => call.data.action)).toEqual(["PROMO_CODE_CREATED"]);
  });

  it("links and unlinks an unused code, auditing both with ids only", async () => {
    const link = txFor({ existing: existingPromo() });
    await updatePromoCode("event_1", "promo_1", { ...updateInput, sponsoringOrganizationId: "church_1" }, "user_1");
    expect(link.promoCode.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ redeemedCount: 0 }),
      data: expect.objectContaining({ sponsoringOrganizationId: "church_1" }),
    }));
    expect(link.auditLog.create.mock.calls.map(([call]) => call.data.action)).toContain("PROMO_CODE_SPONSOR_LINKED");

    const unlink = txFor({ existing: existingPromo({ sponsoringOrganizationId: "church_1" }) });
    await updatePromoCode("event_1", "promo_1", { ...updateInput, sponsoringOrganizationId: null }, "user_1");
    const audit = unlink.auditLog.create.mock.calls.map(([call]) => call.data);
    expect(audit.find((entry) => entry.action === "PROMO_CODE_SPONSOR_UNLINKED")?.metadata).toEqual({
      promoCodeId: "promo_1",
      sponsoringOrganizationId: null,
      previousSponsoringOrganizationId: "church_1",
    });
  });

  it("leaves the sponsor alone when an update omits it (for example a deactivation)", async () => {
    const tx = txFor({ existing: existingPromo({ sponsoringOrganizationId: "church_1", redeemedCount: 4 }) });
    await updatePromoCode("event_1", "promo_1", { ...updateInput, isActive: false }, "user_1");
    const call = tx.promoCode.updateMany.mock.calls[0][0];
    expect(call.data.sponsoringOrganizationId).toBe("church_1");
    expect(call.where).not.toHaveProperty("redeemedCount");
    expect(tx.auditLog.create.mock.calls.map(([entry]) => entry.data.action)).toEqual(["PROMO_CODE_DEACTIVATED"]);
  });

  it("locks the sponsor once a code has been used", async () => {
    for (const next of [null, "church_2"]) {
      txFor({ existing: existingPromo({ sponsoringOrganizationId: "church_1", redeemedCount: 1 }) });
      await expect(
        updatePromoCode("event_1", "promo_1", { ...updateInput, sponsoringOrganizationId: next }, "user_1"),
      ).rejects.toMatchObject({ code: "PROMO_CODE_SPONSOR_LOCKED" });
    }
  });

  it("reports a conflict when a use is claimed between the read and the guarded write", async () => {
    txFor({ existing: existingPromo(), updateCount: 0 });
    await expect(
      updatePromoCode("event_1", "promo_1", { ...updateInput, sponsoringOrganizationId: "church_1" }, "user_1"),
    ).rejects.toMatchObject({ code: "PROMO_CODE_CONFLICT" });
  });

  it("keeps the sponsor optional in input validation and the editor dirty check", () => {
    expect(promoCodeInputSchema.parse(baseInput).sponsoringOrganizationId).toBeUndefined();
    expect(updatePromoCodeInputSchema.parse(updateInput).sponsoringOrganizationId).toBeUndefined();
    expect(promoCodeInputSchema.parse({ ...baseInput, sponsoringOrganizationId: null }).sponsoringOrganizationId).toBeNull();
    expect(() => promoCodeInputSchema.parse({ ...baseInput, sponsoringOrganizationId: "" })).toThrow();
    const saved = savedPromoCodeEditorDraft({ ...baseInput, sponsoringOrganizationId: "church_1" });
    const raw = {
      code: "CHURCH25", isActive: true, discountType: "FIXED_CENTS", discountValue: "25", startsOn: "", endsOn: "",
      minimumSubtotal: "", maximumUses: "", maximumDiscount: "", sponsoringOrganizationId: "church_1",
    };
    expect(isPromoCodeEditorDraftDirty(saved, normalizePromoCodeEditorDraft(raw))).toBe(false);
    expect(isPromoCodeEditorDraftDirty(saved, normalizePromoCodeEditorDraft({ ...raw, sponsoringOrganizationId: "" }))).toBe(true);
  });
});

const line = (overrides: Partial<ChurchSponsoredPromoLine> = {}): ChurchSponsoredPromoLine => ({
  lineId: `line-${overrides.confirmationCode ?? "SYN-0001"}`,
  churchId: "church_1",
  churchName: "Synthetic Church",
  promoCode: "CHURCH25",
  confirmationCode: "SYN-0001",
  status: "CONFIRMED",
  amountCents: 2_500,
  ...overrides,
});

describe("what a sponsoring church owes (#545)", () => {
  it("bills only submitted or confirmed registrations, so a cancellation drops the line", () => {
    const lines = [
      line({ confirmationCode: "A", status: "SUBMITTED" }),
      line({ confirmationCode: "B", status: "CONFIRMED" }),
      line({ confirmationCode: "C", status: "CANCELLED" }),
      line({ confirmationCode: "D", status: "WAITLISTED" }),
      line({ confirmationCode: "E", status: "DRAFT" }),
      line({ confirmationCode: "F", amountCents: 0 }),
    ];
    expect(billedSponsoredLines(lines).map((entry) => entry.confirmationCode)).toEqual(["A", "B"]);
    const afterCancel = lines.map((entry) => entry.confirmationCode === "B" ? { ...entry, status: "CANCELLED" as const } : entry);
    expect(summarizeSponsoredLines(afterCancel).totalCents).toBe(2_500);
  });

  it("groups lines under each church with a subtotal", () => {
    const summary = summarizeSponsoredLines([
      line({ confirmationCode: "A", amountCents: 2_500 }),
      line({ confirmationCode: "B", amountCents: 1_000 }),
      line({ churchId: "church_0", churchName: "Another Church", confirmationCode: "C", amountCents: 500 }),
    ]);
    expect(summary.churches.map((church) => [church.churchName, church.lineCount, church.amountCents])).toEqual([
      ["Another Church", 1, 500],
      ["Synthetic Church", 2, 3_500],
    ]);
    expect(summary.totalCents).toBe(4_000);
    expect(summary.lineCount).toBe(3);
  });

  it("bills only GENERAL attendee-paid events, never one that already bills churches", () => {
    expect(eventBillsSponsoredPromoCodes({ audience: "GENERAL", billingMode: "ATTENDEE_PAY" })).toBe(true);
    expect(eventBillsSponsoredPromoCodes({ audience: "CLUB", billingMode: "DEFERRED_ORGANIZATION_INVOICE" })).toBe(false);
    expect(eventBillsSponsoredPromoCodes({ audience: "CLUB", billingMode: "ATTENDEE_PAY" })).toBe(false);
    expect(eventBillsSponsoredPromoCodes({ audience: "GENERAL", billingMode: "DEFERRED_ORGANIZATION_INVOICE" })).toBe(false);
  });

  it("adds sponsored lines to the church CSV with names and amounts only", () => {
    const rows = churchAmountsOwedCsvRows([
      {
        organizationId: "club_1", organizationName: "Synthetic Club", churchId: "church_1", churchName: "Synthetic Church",
        confirmationCode: "CLUB-1", status: "CONFIRMED", attendeeCount: 3, isBilled: true, amountOwedCents: 10_000,
      },
    ], billedSponsoredLines([line()]));
    expect(rows).toHaveLength(3);
    expect(rows[2]).toEqual([
      "Synthetic Church",
      "Promo code CHURCH25",
      "SYN-0001",
      "CONFIRMED",
      "Yes",
      "",
      "25.00",
      "125.00",
      "Church-sponsored promo code; billed to the church after the event, not paid online",
    ]);
    expect(rows[1][7]).toBe("125.00");
    expect(churchAmountsOwedCsvRows([], [])).toHaveLength(1);
  });
});

function redemptionPrisma(event: { audience: string; billingMode: string } | null) {
  return {
    event: { findUnique: vi.fn().mockResolvedValue(event) },
    promoCodeRedemption: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "red_1",
          codeSnapshot: "CHURCH25",
          discountAmountCents: 2_500,
          sponsorLodgingChangeCents: 0,
          promoCode: { sponsoringOrganization: { id: "church_1", name: "Synthetic Church" } },
          registration: { confirmationCode: "SYN-0001", status: "CONFIRMED" },
        },
        {
          id: "red_2",
          codeSnapshot: "CHURCH25",
          discountAmountCents: 900,
          sponsorLodgingChangeCents: 0,
          promoCode: { sponsoringOrganization: null },
          registration: { confirmationCode: "SYN-0002", status: "CONFIRMED" },
        },
      ]),
      aggregate: vi.fn(),
    },
    registrationAdjustment: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "adj_1",
          promoCodeSnapshot: "CHURCH25",
          amountCents: -1_500,
          promoCode: { code: "CHURCH25", sponsoringOrganization: { id: "church_1", name: "Synthetic Church" } },
          registration: { confirmationCode: "SYN-0003", status: "SUBMITTED" },
        },
        {
          id: "adj_2",
          promoCodeSnapshot: "GONE",
          amountCents: -700,
          promoCode: { code: "GONE", sponsoringOrganization: null },
          registration: { confirmationCode: "SYN-0004", status: "SUBMITTED" },
        },
      ]),
      aggregate: vi.fn().mockResolvedValue({ _sum: { amountCents: -1_500 } }),
    },
  };
}

describe("sponsored promo code queries (#545)", () => {
  it("lists one line per redemption on a billable event and selects no attendee fields", async () => {
    const prisma = redemptionPrisma({ audience: "GENERAL", billingMode: "ATTENDEE_PAY" });
    dependencies.getPrisma.mockReturnValue(prisma);
    const lines = await listChurchSponsoredPromoLines("event_1");
    expect(lines).toEqual([
      line({ lineId: "redemption:red_1" }),
      line({ lineId: "adjustment:adj_1", confirmationCode: "SYN-0003", status: "SUBMITTED", amountCents: 1_500 }),
    ]);
    const adjustmentWhere = prisma.registrationAdjustment.findMany.mock.calls[0][0].where;
    expect(adjustmentWhere).toMatchObject({
      eventId: "event_1",
      kind: "PROMO_CODE",
      amountCents: { lt: 0 },
      reversesAdjustmentId: null,
      reversedBy: null,
      registration: { status: { in: ["SUBMITTED", "CONFIRMED"] } },
    });
    const query = prisma.promoCodeRedemption.findMany.mock.calls[0][0];
    expect(query.where).toMatchObject({
      eventId: "event_1",
      registration: { status: { in: ["SUBMITTED", "CONFIRMED"] } },
    });
    expect(JSON.stringify(query.select)).not.toMatch(/attendee|firstName|lastName|email|profile/i);
  });

  it("bills nothing for a club event or an event already billed to churches (no double billing)", async () => {
    for (const event of [
      { audience: "CLUB", billingMode: "DEFERRED_ORGANIZATION_INVOICE" },
      { audience: "CLUB", billingMode: "ATTENDEE_PAY" },
      { audience: "GENERAL", billingMode: "DEFERRED_ORGANIZATION_INVOICE" },
      null,
    ]) {
      const prisma = redemptionPrisma(event);
      dependencies.getPrisma.mockReturnValue(prisma);
      expect(await listChurchSponsoredPromoLines("event_1")).toEqual([]);
      expect(await sumChurchSponsoredPromoCents("event_1")).toBe(0);
      expect(prisma.promoCodeRedemption.findMany).not.toHaveBeenCalled();
      expect(prisma.promoCodeRedemption.aggregate).not.toHaveBeenCalled();
      expect(prisma.registrationAdjustment.findMany).not.toHaveBeenCalled();
      expect(prisma.registrationAdjustment.aggregate).not.toHaveBeenCalled();
    }
  });

  it("sums the same active, sponsored redemptions for the overview tile", async () => {
    const prisma = redemptionPrisma({ audience: "GENERAL", billingMode: "ATTENDEE_PAY" });
    dependencies.getPrisma.mockReturnValue(prisma);
    // A recorded discount plus what lodging edits moved the church's share by (#813), per registration and never below zero.
    prisma.promoCodeRedemption.findMany.mockResolvedValue([
      { discountAmountCents: 4_000, sponsorLodgingChangeCents: 1_000 },
      { discountAmountCents: 500, sponsorLodgingChangeCents: -800 },
    ]);
    expect(await sumChurchSponsoredPromoCents("event_1")).toBe(6_500);
    expect(prisma.promoCodeRedemption.findMany.mock.calls[0][0].where).toMatchObject({
      eventId: "event_1",
      promoCode: { sponsoringOrganizationId: { not: null } },
      registration: { status: { in: ["SUBMITTED", "CONFIRMED"] } },
    });
  });

  it("counts a registration while either its discount or its lodging change is positive", async () => {
    const prisma = redemptionPrisma({ audience: "GENERAL", billingMode: "ATTENDEE_PAY" });
    dependencies.getPrisma.mockReturnValue(prisma);
    prisma.promoCodeRedemption.findMany.mockResolvedValue([{ discountAmountCents: 0, sponsorLodgingChangeCents: 2_000 }]);
    expect(await sumChurchSponsoredPromoCents("event_1")).toBe(2_000 + 1_500);
    const where = prisma.promoCodeRedemption.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([{ discountAmountCents: { gt: 0 } }, { sponsorLodgingChangeCents: { gt: 0 } }]);
  });

  it("a line is the recorded discount plus the lodging change (#813)", async () => {
    const prisma = redemptionPrisma({ audience: "GENERAL", billingMode: "ATTENDEE_PAY" });
    dependencies.getPrisma.mockReturnValue(prisma);
    prisma.promoCodeRedemption.findMany.mockResolvedValue([
      { id: "red_1", codeSnapshot: "CHURCH25", discountAmountCents: 2_500, sponsorLodgingChangeCents: 2_000, promoCode: { sponsoringOrganization: { id: "church_1", name: "Synthetic Church" } }, registration: { confirmationCode: "SYN-0001", status: "CONFIRMED" } },
    ]);
    const lines = await listChurchSponsoredPromoLines("event_1");
    expect(lines.find((line) => line.lineId === "redemption:red_1")?.amountCents).toBe(4_500);
  });
});
