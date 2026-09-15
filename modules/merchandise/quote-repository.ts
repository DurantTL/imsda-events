import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import {
  assertMerchandiseInventoryAvailable,
  buildMerchandiseQuoteDraft,
  MerchandiseQuoteError,
  merchandiseQuoteRequestFingerprint,
  merchandiseQuoteRequestSchema,
  replayMerchandiseQuote,
  type MerchandiseQuoteCatalog,
  type MerchandiseQuoteEligibility,
  type MerchandiseQuoteRequest,
} from "@/modules/merchandise/quote-domain";

export const merchandiseQuoteReleaseReasons = [
  "EXPIRED",
  "FAILED_PAYMENT",
  "CANCELLED_PAYMENT",
  "ABANDONED",
  "STALE_CATALOG",
] as const;
export type MerchandiseQuoteReleaseReason =
  typeof merchandiseQuoteReleaseReasons[number];

export type CreateMerchandiseQuoteContext = {
  registrationId?: string | null;
  actorUserId?: string | null;
  purchaserSnapshot: Prisma.InputJsonValue;
  eligibility: MerchandiseQuoteEligibility;
};

const availabilitySelect = {
  id: true,
  versionNumber: true,
  priceCents: true,
  taxTreatment: true,
  feePolicy: true,
  inventoryPolicy: true,
  inventoryQuantity: true,
  salesStartsAt: true,
  salesEndsAt: true,
  minQuantity: true,
  maxQuantity: true,
  attendeeAvailability: true,
  isActive: true,
} as const;

const quoteInclude = {
  lines: { orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }] },
  reservations: { orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }] },
} satisfies Prisma.MerchandiseQuoteInclude;

function retryableTransactionError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && (error.code === "P2034" || error.code === "P2002");
}

async function runSerializable<T>(
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  const prisma = getPrisma();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (!retryableTransactionError(error)) throw error;
    }
  }
  throw new MerchandiseQuoteError(
    "QUOTE_CONFLICT",
    "Merchandise inventory changed at the same time. Try the quote again.",
    true,
  );
}

async function catalogForQuote(
  tx: Prisma.TransactionClient,
  eventId: string,
  variantIds: string[],
): Promise<MerchandiseQuoteCatalog> {
  const [catalog, event, products] = await Promise.all([
    tx.merchandiseCatalog.findUnique({ where: { eventId } }),
    tx.event.findUnique({ where: { id: eventId }, select: { isPublished: true } }),
    tx.merchandiseProduct.findMany({
      where: {
        eventId,
        variants: { some: { id: { in: variantIds } } },
      },
      select: {
        id: true,
        name: true,
        isEnabled: true,
        isArchived: true,
        variants: {
          where: { id: { in: variantIds } },
          select: {
            id: true,
            label: true,
            isEnabled: true,
            isArchived: true,
            availability: {
              where: { isActive: true },
              orderBy: { versionNumber: "desc" },
              take: 1,
              select: availabilitySelect,
            },
          },
        },
      },
    }),
  ]);

  return {
    id: catalog?.id ?? "missing-catalog",
    eventId,
    eventIsPublished: Boolean(event?.isPublished),
    isEnabled: catalog?.isEnabled ?? false,
    status: catalog?.status ?? "DRAFT",
    taxRateBasisPoints: catalog?.taxRateBasisPoints ?? 0,
    cardFeePercentageBasisPoints:
      catalog?.cardFeePercentageBasisPoints ?? 0,
    cardFeeFixedCents: catalog?.cardFeeFixedCents ?? 0,
    quoteTtlMinutes: catalog?.quoteTtlMinutes ?? 15,
    products: products.map((product) => ({
      ...product,
      variants: product.variants.map((variant) => ({
        ...variant,
        availability: variant.availability[0] ?? null,
      })),
    })),
  };
}

async function reservedQuantityByVariant(
  tx: Prisma.TransactionClient,
  variantIds: string[],
  now: Date,
  excludedQuoteId?: string,
) {
  const reservations = await tx.merchandiseInventoryReservation.findMany({
    where: {
      variantId: { in: variantIds },
      releasedAt: null,
      ...(excludedQuoteId ? { quoteId: { not: excludedQuoteId } } : {}),
      OR: [
        { completedAt: { not: null } },
        { expiresAt: { gt: now } },
      ],
    },
    select: { variantId: true, quantity: true },
  });
  const totals = new Map<string, number>();
  for (const reservation of reservations) {
    totals.set(
      reservation.variantId,
      (totals.get(reservation.variantId) ?? 0) + reservation.quantity,
    );
  }
  return totals;
}

async function releaseQuotesInTransaction(
  tx: Prisma.TransactionClient,
  quoteIds: string[],
  reason: MerchandiseQuoteReleaseReason,
  now: Date,
) {
  if (quoteIds.length === 0) return;
  await tx.merchandiseInventoryReservation.updateMany({
    where: {
      quoteId: { in: quoteIds },
      releasedAt: null,
      completedAt: null,
    },
    data: { releasedAt: now, releaseReason: reason },
  });
  await tx.merchandiseQuote.updateMany({
    where: {
      id: { in: quoteIds },
      status: { in: ["ACTIVE", "PAYMENT_PENDING"] },
    },
    data: {
      status: "RELEASED",
      releasedAt: now,
      releaseReason: reason,
    },
  });
}

async function releaseExpiredInTransaction(
  tx: Prisma.TransactionClient,
  now: Date,
  options: { eventId?: string; limit?: number } = {},
) {
  const expired = await tx.merchandiseQuote.findMany({
    where: {
      ...(options.eventId ? { eventId: options.eventId } : {}),
      status: { in: ["ACTIVE", "PAYMENT_PENDING"] },
      expiresAt: { lte: now },
    },
    orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
    take: options.limit ?? 100,
    select: { id: true },
  });
  await releaseQuotesInTransaction(
    tx,
    expired.map((quote) => quote.id),
    "EXPIRED",
    now,
  );
  return expired.length;
}

export async function createMerchandiseQuote(
  eventId: string,
  rawRequest: unknown,
  context: CreateMerchandiseQuoteContext,
  options: { now?: Date } = {},
) {
  const request = merchandiseQuoteRequestSchema.parse(rawRequest);
  const now = options.now ?? new Date();
  const identity = {
    registrationId: context.registrationId ?? null,
    actorUserId: context.actorUserId ?? null,
  };
  const requestFingerprint = merchandiseQuoteRequestFingerprint(
    eventId,
    request,
    identity,
  );

  const outcome = await runSerializable(async (tx) => {
    const existing = await tx.merchandiseQuote.findUnique({
      where: {
        eventId_clientRequestId: {
          eventId,
          clientRequestId: request.clientRequestId,
        },
      },
      include: quoteInclude,
    });
    if (existing) {
      replayMerchandiseQuote(existing, requestFingerprint);
      if (
        (existing.status === "ACTIVE" || existing.status === "PAYMENT_PENDING")
        && existing.expiresAt.getTime() <= now.getTime()
      ) {
        await releaseQuotesInTransaction(tx, [existing.id], "EXPIRED", now);
        return {
          error: new MerchandiseQuoteError(
            "QUOTE_EXPIRED",
            "The merchandise quote expired. Use a new request ID for a new quote.",
          ),
        } as const;
      }
      return { quote: existing } as const;
    }

    await releaseExpiredInTransaction(tx, now, { eventId });
    const catalog = await catalogForQuote(
      tx,
      eventId,
      request.lines.map((line) => line.variantId),
    );
    const draft = buildMerchandiseQuoteDraft({
      eventId,
      request,
      identity,
      eligibility: context.eligibility,
      catalog,
      now,
    });
    const reserved = await reservedQuantityByVariant(
      tx,
      draft.lines.map((line) => line.variantId),
      now,
    );
    assertMerchandiseInventoryAvailable(draft, reserved);

    const quoteId = randomUUID();
    return {
      quote: await tx.merchandiseQuote.create({
        data: {
        id: quoteId,
        eventId,
        registrationId: identity.registrationId,
        actorUserId: identity.actorUserId,
        purchaserSnapshot: context.purchaserSnapshot,
        clientRequestId: request.clientRequestId,
        requestFingerprint: draft.requestFingerprint,
        catalogFingerprint: draft.catalogFingerprint,
        paymentIdempotencyKey: `merchandise-quote:${quoteId}`,
        paymentMethod: draft.paymentMethod,
        eligibilitySnapshot: draft.eligibilitySnapshot,
        subtotalCents: draft.subtotalCents,
        taxCents: draft.taxCents,
        feeCents: draft.feeCents,
        totalCents: draft.totalCents,
        expiresAt: draft.expiresAt,
        lines: {
          create: draft.lines.map((line) => ({
            eventId: line.eventId,
            productId: line.productId,
            productNameSnapshot: line.productNameSnapshot,
            variantId: line.variantId,
            variantLabelSnapshot: line.variantLabelSnapshot,
            availabilityId: line.availabilityId,
            unitPriceCentsSnapshot: line.unitPriceCentsSnapshot,
            quantity: line.quantity,
            taxTreatmentSnapshot: line.taxTreatmentSnapshot,
            feePolicySnapshot: line.feePolicySnapshot,
            lineSubtotalCents: line.lineSubtotalCents,
            lineTaxCents: line.lineTaxCents,
          })),
        },
        reservations: {
          create: draft.lines.flatMap((line) => (
            line.inventoryPolicy === "TRACKED"
              ? [{
                eventId,
                variantId: line.variantId,
                quantity: line.quantity,
                expiresAt: draft.expiresAt,
              }]
              : []
          )),
        },
        },
        include: quoteInclude,
      }),
    } as const;
  });
  if ("error" in outcome) throw outcome.error;
  return outcome.quote;
}

function requestFromStoredQuote(quote: {
  clientRequestId: string;
  paymentMethod: "CARD" | "CASH" | "CHECK";
  lines: Array<{ variantId: string | null; quantity: number }>;
}): MerchandiseQuoteRequest {
  const lines = quote.lines.map((line) => {
    if (!line.variantId) {
      throw new MerchandiseQuoteError(
        "QUOTE_STALE",
        "A quoted merchandise variant no longer exists. Request a new quote.",
      );
    }
    return { variantId: line.variantId, quantity: line.quantity };
  });
  return { clientRequestId: quote.clientRequestId, paymentMethod: quote.paymentMethod, lines };
}

export async function prepareMerchandiseQuoteForPayment(
  quoteId: string,
  context: Pick<CreateMerchandiseQuoteContext, "registrationId" | "actorUserId" | "eligibility">,
  options: { now?: Date } = {},
) {
  const now = options.now ?? new Date();
  const outcome = await runSerializable(async (tx) => {
    const quote = await tx.merchandiseQuote.findUnique({
      where: { id: quoteId },
      include: quoteInclude,
    });
    if (
      !quote
      || quote.registrationId !== (context.registrationId ?? null)
      || quote.actorUserId !== (context.actorUserId ?? null)
    ) {
      throw new MerchandiseQuoteError("QUOTE_NOT_FOUND", "The merchandise quote was not found.");
    }
    if (quote.status === "COMPLETED") {
      throw new MerchandiseQuoteError("QUOTE_COMPLETED", "The merchandise quote has already been completed.");
    }
    if (quote.status === "RELEASED") {
      throw new MerchandiseQuoteError("QUOTE_RELEASED", "The merchandise quote was released. Request a new quote.");
    }
    if (quote.paymentMethod !== "CARD") {
      throw new MerchandiseQuoteError(
        "PAYMENT_METHOD_NOT_CARD",
        "Cash and check merchandise quotes cannot create a card payment.",
      );
    }
    if (quote.expiresAt.getTime() <= now.getTime()) {
      await releaseQuotesInTransaction(tx, [quote.id], "EXPIRED", now);
      return {
        error: new MerchandiseQuoteError(
          "QUOTE_EXPIRED",
          "The merchandise quote expired. Request a new quote.",
        ),
      } as const;
    }

    let request: MerchandiseQuoteRequest;
    try {
      request = requestFromStoredQuote(quote);
      const identity = {
        registrationId: context.registrationId ?? null,
        actorUserId: context.actorUserId ?? null,
      };
      const catalog = await catalogForQuote(
        tx,
        quote.eventId,
        request.lines.map((line) => line.variantId),
      );
      const draft = buildMerchandiseQuoteDraft({
        eventId: quote.eventId,
        request,
        identity,
        eligibility: context.eligibility,
        catalog,
        now,
      });
      const storedTermsMatch = draft.requestFingerprint === quote.requestFingerprint
        && draft.catalogFingerprint === quote.catalogFingerprint
        && draft.paymentMethod === quote.paymentMethod
        && draft.subtotalCents === quote.subtotalCents
        && draft.taxCents === quote.taxCents
        && draft.feeCents === quote.feeCents
        && draft.totalCents === quote.totalCents;
      if (!storedTermsMatch) {
        throw new MerchandiseQuoteError(
          "QUOTE_STALE",
          "The merchandise catalog changed. Request a new quote.",
        );
      }

      const reservationsByVariant = new Map(
        quote.reservations.map((reservation) => [reservation.variantId, reservation]),
      );
      const trackedLineCount = draft.lines.filter(
        (line) => line.inventoryPolicy === "TRACKED",
      ).length;
      if (reservationsByVariant.size !== trackedLineCount) {
        throw new MerchandiseQuoteError(
          "QUOTE_STALE",
          "The quote reservation is inconsistent. Request a new quote.",
        );
      }
      for (const line of draft.lines) {
        const reservation = reservationsByVariant.get(line.variantId);
        if (line.inventoryPolicy === "UNLIMITED") {
          if (reservation) throw new MerchandiseQuoteError("QUOTE_STALE", "The quote reservation is inconsistent. Request a new quote.");
          continue;
        }
        if (
          !reservation
          || reservation.quantity !== line.quantity
          || reservation.releasedAt
          || reservation.completedAt
          || reservation.expiresAt.getTime() <= now.getTime()
          || reservation.expiresAt.getTime() !== quote.expiresAt.getTime()
        ) {
          throw new MerchandiseQuoteError("QUOTE_STALE", "The quote reservation is no longer valid. Request a new quote.");
        }
      }
      const otherReserved = await reservedQuantityByVariant(
        tx,
        draft.lines.map((line) => line.variantId),
        now,
        quote.id,
      );
      assertMerchandiseInventoryAvailable(draft, otherReserved);
    } catch (error) {
      if (!(error instanceof MerchandiseQuoteError)) throw error;
      await releaseQuotesInTransaction(tx, [quote.id], "STALE_CATALOG", now);
      return {
        error: new MerchandiseQuoteError(
          "QUOTE_STALE",
          "The merchandise catalog or eligibility changed. Request a new quote.",
        ),
      } as const;
    }

    if (quote.status === "PAYMENT_PENDING") return { quote } as const;
    return {
      quote: await tx.merchandiseQuote.update({
        where: { id: quote.id },
        data: { status: "PAYMENT_PENDING" },
        include: quoteInclude,
      }),
    } as const;
  });
  if ("error" in outcome) throw outcome.error;
  return outcome.quote;
}

export async function releaseMerchandiseQuote(
  quoteId: string,
  reason: Exclude<
    MerchandiseQuoteReleaseReason,
    "STALE_CATALOG" | "EXPIRED"
  >,
  options: { now?: Date } = {},
) {
  const now = options.now ?? new Date();
  return runSerializable(async (tx) => {
    const quote = await tx.merchandiseQuote.findUnique({
      where: { id: quoteId },
      include: quoteInclude,
    });
    if (!quote) throw new MerchandiseQuoteError("QUOTE_NOT_FOUND", "The merchandise quote was not found.");
    if (quote.status === "COMPLETED") {
      throw new MerchandiseQuoteError("QUOTE_COMPLETED", "A completed merchandise quote cannot be released.");
    }
    if (quote.status === "RELEASED") return quote;
    await releaseQuotesInTransaction(tx, [quote.id], reason, now);
    return tx.merchandiseQuote.findUniqueOrThrow({
      where: { id: quote.id },
      include: quoteInclude,
    });
  });
}

export async function releaseExpiredMerchandiseQuotes(
  options: { eventId?: string; now?: Date; limit?: number } = {},
) {
  const now = options.now ?? new Date();
  return runSerializable((tx) => releaseExpiredInTransaction(tx, now, options));
}
