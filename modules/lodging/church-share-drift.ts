import "server-only";

import type { PrismaClient } from "@prisma/client";
import { computeChurchShare } from "@/modules/lodging/preferences-service";
import { CHURCH_SPONSORED_BILLED_STATUSES } from "@/modules/promo-codes/church-sponsored";

export type ChurchShareDriftRow = {
  registrationId: string;
  eventId: string;
  promoCodeId: string;
  churchId: string;
  /** `PromoCodeRedemption.sponsorLodgingChangeCents` as stored today. */
  storedCents: number;
  /** What the recompute gives now; the next staff lodging edit or amendment of this registration will store it. */
  recomputedCents: number;
  differenceCents: number;
};

/**
 * Before #813 a lodging edit never moved a church's bill, and #806 told staff to ask the finance office instead. The first
 * time a registration edited under that interim rule is touched after #813, the recompute moves the church's share. This
 * report shows, for every church-sponsored registration-level redemption, what is stored against what the recompute would
 * give, so finance can see what will move before the deploy. It runs in a READ ONLY transaction (the database itself refuses a
 * write), and returns ids and amounts only: no names, confirmation codes or contact details.
 */
export async function reportChurchShareDrift(client: PrismaClient, options: { batchSize?: number } = {}): Promise<{ scanned: number; rows: ChurchShareDriftRow[] }> {
  const batchSize = Math.max(1, options.batchSize ?? 100);
  const rows: ChurchShareDriftRow[] = [];
  let scanned = 0;
  let cursor: string | null = null;
  // Batches by id, each in its own READ ONLY transaction, so a large event never holds one long transaction open.
  for (;;) {
    const lastId: string | null = cursor;
    const batch: { count: number; lastId: string | null; found: ChurchShareDriftRow[] } = await client.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const redemptions = await tx.promoCodeRedemption.findMany({
        where: {
          promoCode: { sponsoringOrganizationId: { not: null } },
          registration: { status: { in: [...CHURCH_SPONSORED_BILLED_STATUSES] } },
          ...(lastId ? { id: { gt: lastId } } : {}),
        },
        orderBy: { id: "asc" },
        take: batchSize,
        select: { id: true, registrationId: true, eventId: true, promoCodeId: true, sponsorLodgingChangeCents: true, promoCode: { select: { sponsoringOrganizationId: true } } },
      });
      const found: ChurchShareDriftRow[] = [];
      for (const redemption of redemptions) {
        const figures = await computeChurchShare(tx, { eventId: redemption.eventId, registrationId: redemption.registrationId });
        if (!figures || figures.desiredCents === redemption.sponsorLodgingChangeCents) continue;
        found.push({
          registrationId: redemption.registrationId, eventId: redemption.eventId, promoCodeId: redemption.promoCodeId,
          churchId: redemption.promoCode.sponsoringOrganizationId ?? "", storedCents: redemption.sponsorLodgingChangeCents,
          recomputedCents: figures.desiredCents, differenceCents: figures.desiredCents - redemption.sponsorLodgingChangeCents,
        });
      }
      return { count: redemptions.length, lastId: redemptions.at(-1)?.id ?? null, found };
    }, { timeout: 120_000, maxWait: 30_000 });
    scanned += batch.count;
    rows.push(...batch.found);
    if (batch.count < batchSize || !batch.lastId) break;
    cursor = batch.lastId;
  }
  return { scanned, rows };
}
