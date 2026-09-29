import "server-only";

import type { Prisma, PrismaClient } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import {
  CHURCH_SPONSORED_BILLED_STATUSES,
  eventBillsSponsoredPromoCodes,
  type ChurchSponsoredPromoLine,
} from "@/modules/promo-codes/church-sponsored";

type Client = Prisma.TransactionClient | PrismaClient;

async function eventBillsSponsors(client: Client, eventId: string) {
  const event = await client.event.findUnique({
    where: { id: eventId },
    select: { audience: true, billingMode: true },
  });
  return event ? eventBillsSponsoredPromoCodes(event) : false;
}

const sponsoredRedemptionWhere = (eventId: string): Prisma.PromoCodeRedemptionWhereInput => ({
  eventId,
  promoCode: { sponsoringOrganizationId: { not: null } },
  registration: { status: { in: [...CHURCH_SPONSORED_BILLED_STATUSES] } },
  discountAmountCents: { gt: 0 },
});

/**
 * What each sponsoring church owes for this event (#545): one line per
 * redeemed, still-active registration. Staff finance only; carries a
 * confirmation code and amounts, never an attendee name or answer.
 */
export async function listChurchSponsoredPromoLines(
  eventId: string,
  client: Client = getPrisma(),
): Promise<ChurchSponsoredPromoLine[]> {
  if (!await eventBillsSponsors(client, eventId)) return [];
  const rows = await client.promoCodeRedemption.findMany({
    where: sponsoredRedemptionWhere(eventId),
    orderBy: { createdAt: "asc" },
    select: {
      codeSnapshot: true,
      discountAmountCents: true,
      promoCode: {
        select: { sponsoringOrganization: { select: { id: true, name: true } } },
      },
      registration: { select: { confirmationCode: true, status: true } },
    },
  });
  return rows.flatMap((row) => {
    const church = row.promoCode.sponsoringOrganization;
    if (!church) return [];
    return [{
      churchId: church.id,
      churchName: church.name,
      promoCode: row.codeSnapshot,
      confirmationCode: row.registration.confirmationCode,
      status: row.registration.status,
      amountCents: row.discountAmountCents,
    }];
  });
}

/** Total sponsored discount billed to churches for the overview tile (#545). */
export async function sumChurchSponsoredPromoCents(
  eventId: string,
  client: Client = getPrisma(),
) {
  if (!await eventBillsSponsors(client, eventId)) return 0;
  const total = await client.promoCodeRedemption.aggregate({
    where: sponsoredRedemptionWhere(eventId),
    _sum: { discountAmountCents: true },
  });
  return total._sum.discountAmountCents ?? 0;
}
