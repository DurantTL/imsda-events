import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MerchandiseQuoteRequest } from "@/modules/merchandise/quote-domain";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => database }));

import {
  createMerchandiseQuote,
  prepareMerchandiseQuoteForPayment,
  releaseExpiredMerchandiseQuotes,
  releaseMerchandiseQuote,
} from "@/modules/merchandise/quote-repository";

const database = new PrismaClient();
const now = new Date("2026-09-14T15:00:00.000Z");
const context = {
  purchaserSnapshot: { source: "synthetic-test" },
  eligibility: "PUBLIC" as const,
};
const eventIds: string[] = [];
let eventId: string;
let variantId: string;
let userId: string;

function request(clientRequestId = randomUUID()): MerchandiseQuoteRequest {
  return { clientRequestId, paymentMethod: "CARD", lines: [{ variantId, quantity: 1 }] };
}

// CI provisions and migrates PostgreSQL before npm test. Ordinary unit runs
// stay database-free; CI=true also runs this suite against a local test database.
describe.skipIf(process.env.CI !== "true")("merchandise quotes in PostgreSQL", () => {
  beforeEach(async () => {
    const id = randomUUID();
    const user = await database.user.create({
      data: { email: `quote-${id}@example.invalid`, displayName: "Synthetic quote test" },
    });
    userId = user.id;
    const event = await database.event.create({
      data: {
        slug: `quote-${id}`,
        name: "Synthetic quote test",
        startsAt: now,
        endsAt: new Date("2026-09-15T15:00:00.000Z"),
        isPublished: true,
        merchandiseCatalog: { create: {
          isEnabled: true, status: "APPROVED", taxRateBasisPoints: 0,
          cardFeePercentageBasisPoints: 290, cardFeeFixedCents: 30, quoteTtlMinutes: 15,
        } },
        merchandiseProducts: { create: {
          name: "Synthetic shirt",
          variants: { create: {
            label: "Last item",
            availability: { create: {
              versionNumber: 1, priceCents: 1_000, taxTreatment: "TAXABLE",
              feePolicy: "PASSED_TO_BUYER", inventoryPolicy: "TRACKED",
              inventoryQuantity: 1, minQuantity: 1, maxQuantity: 1,
              attendeeAvailability: "ALL", createdByUserId: userId,
            } },
          } },
        } },
      },
      include: { merchandiseProducts: { include: { variants: true } } },
    });
    eventId = event.id;
    eventIds.push(eventId);
    variantId = event.merchandiseProducts[0]!.variants[0]!.id;
  });

  afterAll(async () => {
    const creators = await database.merchandiseVariantAvailability.findMany({
      where: { variant: { product: { eventId: { in: eventIds } } } },
      select: { createdByUserId: true },
    });
    // Delete only this run's synthetic fixtures, in foreign-key order.
    await database.merchandiseInventoryReservation.deleteMany({ where: { eventId: { in: eventIds } } });
    await database.event.deleteMany({ where: { id: { in: eventIds } } });
    await database.user.deleteMany({ where: { id: { in: creators.map((row) => row.createdByUserId) } } });
    await database.$disconnect();
  });

  it("persists server-priced amounts, lines and the reservation", async () => {
    const quote = await createMerchandiseQuote(eventId, request(), context, { now });
    const stored = await database.merchandiseQuote.findUniqueOrThrow({
      where: { id: quote.id }, include: { lines: true, reservations: true },
    });
    expect(stored).toMatchObject({
      subtotalCents: 1_000, taxCents: 0, feeCents: 61, totalCents: 1_061,
      paymentIdempotencyKey: `merchandise-quote:${quote.id}`,
      expiresAt: new Date("2026-09-14T15:15:00.000Z"),
      lines: [expect.objectContaining({ variantId, quantity: 1, unitPriceCentsSnapshot: 1_000 })],
      reservations: [expect.objectContaining({ variantId, quantity: 1, releasedAt: null })],
    });
  });

  it("allows exactly one concurrent purchaser to reserve the last item", async () => {
    const results = await Promise.allSettled([
      createMerchandiseQuote(eventId, request(), context, { now }),
      createMerchandiseQuote(eventId, request(), context, { now }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: { code: "OUT_OF_STOCK" } });
    expect(await database.merchandiseQuote.count({ where: { eventId } })).toBe(1);
    const reservations = await database.merchandiseInventoryReservation.findMany({ where: { eventId } });
    expect(reservations.map((reservation) => reservation.quantity)).toEqual([1]);
  });

  it("reuses one quote and reservation for concurrent duplicate submissions", async () => {
    const input = request();
    const quotes = await Promise.all([
      createMerchandiseQuote(eventId, input, context, { now }),
      createMerchandiseQuote(eventId, input, context, { now }),
    ]);
    expect(quotes[0].id).toBe(quotes[1].id);
    expect(quotes[0].paymentIdempotencyKey).toBe(quotes[1].paymentIdempotencyKey);
    expect(await database.merchandiseInventoryReservation.count({ where: { eventId } })).toBe(1);
    await expect(createMerchandiseQuote(
      eventId, { ...input, paymentMethod: "CASH" }, context, { now },
    )).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it.each(["CASH", "CHECK"] as const)("does not add a card fee for %s", async (paymentMethod) => {
    const quote = await createMerchandiseQuote(eventId, { ...request(), paymentMethod }, context, { now });
    expect(quote).toMatchObject({ feeCents: 0, totalCents: 1_000 });
    await expect(prepareMerchandiseQuoteForPayment(quote.id, context, { now }))
      .rejects.toMatchObject({ code: "PAYMENT_METHOD_NOT_CARD" });
  });

  it("revalidates persisted terms and reuses the payment idempotency key", async () => {
    const quote = await createMerchandiseQuote(eventId, request(), context, { now });
    const prepared = await prepareMerchandiseQuoteForPayment(quote.id, context, { now });
    const replay = await prepareMerchandiseQuoteForPayment(quote.id, context, { now });
    expect(prepared).toMatchObject({ status: "PAYMENT_PENDING", totalCents: quote.totalCents });
    expect(replay.paymentIdempotencyKey).toBe(quote.paymentIdempotencyKey);
    expect(await database.merchandiseInventoryReservation.count({ where: { eventId } })).toBe(1);
  });

  it.each(["price", "disabled", "window", "eligibility", "quantity", "inventory"])(
    "invalidates a quote after a %s change and persists its release",
    async (change) => {
      const quote = await createMerchandiseQuote(eventId, request(), context, { now });
      if (change === "disabled") {
        await database.merchandiseProductVariant.update({ where: { id: variantId }, data: { isEnabled: false } });
      } else {
        const previous = await database.merchandiseVariantAvailability.findFirstOrThrow({
          where: { variantId, isActive: true },
        });
        await database.$transaction([
          database.merchandiseVariantAvailability.update({ where: { id: previous.id }, data: { isActive: false } }),
          database.merchandiseVariantAvailability.create({ data: {
            variantId, versionNumber: 2, createdByUserId: userId,
            priceCents: change === "price" ? 1_100 : previous.priceCents,
            taxTreatment: previous.taxTreatment, feePolicy: previous.feePolicy,
            inventoryPolicy: previous.inventoryPolicy,
            inventoryQuantity: change === "inventory" ? 0 : 1,
            attendeeAvailability: change === "eligibility" ? "REGISTERED" : "ALL",
            minQuantity: change === "quantity" ? 2 : 1,
            maxQuantity: change === "quantity" ? 2 : 1,
            salesEndsAt: change === "window" ? new Date(now.getTime() - 1) : null,
          } }),
        ]);
      }
      await expect(prepareMerchandiseQuoteForPayment(quote.id, context, { now }))
        .rejects.toMatchObject({ code: "QUOTE_STALE" });
      const stored = await database.merchandiseQuote.findUniqueOrThrow({
        where: { id: quote.id }, include: { reservations: true },
      });
      expect(stored).toMatchObject({
        status: "RELEASED", totalCents: quote.totalCents, releaseReason: "STALE_CATALOG",
        reservations: [expect.objectContaining({ releasedAt: now, releaseReason: "STALE_CATALOG" })],
      });
    },
  );

  it("rejects another purchaser without invalidating the owner's reservation", async () => {
    const owner = { ...context, actorUserId: userId };
    const quote = await createMerchandiseQuote(eventId, request(), owner, { now });
    await expect(prepareMerchandiseQuoteForPayment(quote.id, context, { now }))
      .rejects.toMatchObject({ code: "QUOTE_NOT_FOUND" });
    const stored = await database.merchandiseQuote.findUniqueOrThrow({ where: { id: quote.id } });
    expect(stored.status).toBe("ACTIVE");
    await expect(prepareMerchandiseQuoteForPayment(quote.id, owner, { now }))
      .resolves.toMatchObject({ status: "PAYMENT_PENDING" });
  });

  it.each(["FAILED_PAYMENT", "CANCELLED_PAYMENT", "ABANDONED"] as const)(
    "releases %s idempotently and makes the item available again",
    async (reason) => {
      const quote = await createMerchandiseQuote(eventId, request(), context, { now });
      const released = await releaseMerchandiseQuote(quote.id, reason, { now });
      const replay = await releaseMerchandiseQuote(quote.id, reason, { now: new Date(now.getTime() + 1) });
      expect(released.status).toBe("RELEASED");
      expect(replay.releasedAt).toEqual(now);
      expect(replay.reservations).toEqual(released.reservations);
      const replacement = await createMerchandiseQuote(eventId, request(), context, { now });
      expect(replacement.status).toBe("ACTIVE");
      expect(await database.merchandiseInventoryReservation.count({
        where: { eventId, releasedAt: null },
      })).toBe(1);
    },
  );

  it("commits expiry release before rejecting a duplicate or payment preparation", async () => {
    const input = request();
    const quote = await createMerchandiseQuote(eventId, input, context, { now });
    await expect(createMerchandiseQuote(eventId, input, context, { now: quote.expiresAt }))
      .rejects.toMatchObject({ code: "QUOTE_EXPIRED" });
    const released = await database.merchandiseQuote.findUniqueOrThrow({
      where: { id: quote.id }, include: { reservations: true },
    });
    expect(released).toMatchObject({
      status: "RELEASED", releaseReason: "EXPIRED",
      reservations: [expect.objectContaining({ releasedAt: quote.expiresAt })],
    });
    const replacement = await createMerchandiseQuote(eventId, request(), context, { now: quote.expiresAt });
    await expect(prepareMerchandiseQuoteForPayment(replacement.id, context, { now: replacement.expiresAt }))
      .rejects.toMatchObject({ code: "QUOTE_EXPIRED" });
    expect(await releaseExpiredMerchandiseQuotes({ eventId, now: replacement.expiresAt })).toBe(0);
  });

  it("sweeps expired reservations once and supports a subsequent checkout", async () => {
    const quote = await createMerchandiseQuote(eventId, request(), context, { now });
    expect(await releaseExpiredMerchandiseQuotes({ eventId, now: quote.expiresAt, limit: 1 })).toBe(1);
    expect(await releaseExpiredMerchandiseQuotes({ eventId, now: quote.expiresAt, limit: 1 })).toBe(0);
    await expect(createMerchandiseQuote(eventId, request(), context, { now: quote.expiresAt }))
      .resolves.toMatchObject({ status: "ACTIVE" });
  });
});
