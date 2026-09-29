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

const activeRegistration = { status: { in: [...CHURCH_SPONSORED_BILLED_STATUSES] } };

/** A code entered for the whole registration (a `PromoCodeRedemption`). */
const sponsoredRedemptionWhere = (eventId: string): Prisma.PromoCodeRedemptionWhereInput => ({
  eventId,
  promoCode: { sponsoringOrganizationId: { not: null } },
  registration: activeRegistration,
  discountAmountCents: { gt: 0 },
});

/**
 * A per-person or staff-applied code (#397): a PROMO_CODE adjustment holds the
 * discount as a negative amount. An adjustment that was reversed, and the
 * reversal row itself, are both left out.
 */
const sponsoredAdjustmentWhere = (eventId: string): Prisma.RegistrationAdjustmentWhereInput => ({
  eventId,
  kind: "PROMO_CODE",
  amountCents: { lt: 0 },
  reversesAdjustmentId: null,
  reversedBy: null,
  promoCode: { sponsoringOrganizationId: { not: null } },
  registration: activeRegistration,
});

/**
 * What each sponsoring church owes for this event (#545): one line per
 * redeemed, still-active registration (or per person for per-person codes).
 * Staff finance only; carries a confirmation code and amounts, never an
 * attendee name or answer.
 */
export async function listChurchSponsoredPromoLines(
  eventId: string,
  client: Client = getPrisma(),
): Promise<ChurchSponsoredPromoLine[]> {
  if (!await eventBillsSponsors(client, eventId)) return [];
  const [redemptions, adjustments] = await Promise.all([
    client.promoCodeRedemption.findMany({
      where: sponsoredRedemptionWhere(eventId),
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        codeSnapshot: true,
        discountAmountCents: true,
        promoCode: {
          select: { sponsoringOrganization: { select: { id: true, name: true } } },
        },
        registration: { select: { confirmationCode: true, status: true } },
      },
    }),
    client.registrationAdjustment.findMany({
      where: sponsoredAdjustmentWhere(eventId),
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        promoCodeSnapshot: true,
        amountCents: true,
        promoCode: {
          select: { code: true, sponsoringOrganization: { select: { id: true, name: true } } },
        },
        registration: { select: { confirmationCode: true, status: true } },
      },
    }),
  ]);
  const lines: ChurchSponsoredPromoLine[] = [];
  for (const row of redemptions) {
    const church = row.promoCode.sponsoringOrganization;
    if (!church) continue;
    lines.push({
      lineId: `redemption:${row.id}`,
      churchId: church.id,
      churchName: church.name,
      promoCode: row.codeSnapshot,
      confirmationCode: row.registration.confirmationCode,
      status: row.registration.status,
      amountCents: row.discountAmountCents,
    });
  }
  for (const row of adjustments) {
    const church = row.promoCode?.sponsoringOrganization;
    if (!church) continue;
    lines.push({
      lineId: `adjustment:${row.id}`,
      churchId: church.id,
      churchName: church.name,
      promoCode: row.promoCodeSnapshot ?? row.promoCode?.code ?? "",
      confirmationCode: row.registration.confirmationCode,
      status: row.registration.status,
      // The adjustment stores the discount as a negative change to the total.
      amountCents: -row.amountCents,
    });
  }
  return lines;
}

/** Total sponsored discount billed to churches for the overview tile (#545). */
export async function sumChurchSponsoredPromoCents(
  eventId: string,
  client: Client = getPrisma(),
) {
  if (!await eventBillsSponsors(client, eventId)) return 0;
  const [redemptions, adjustments] = await Promise.all([
    client.promoCodeRedemption.aggregate({
      where: sponsoredRedemptionWhere(eventId),
      _sum: { discountAmountCents: true },
    }),
    client.registrationAdjustment.aggregate({
      where: sponsoredAdjustmentWhere(eventId),
      _sum: { amountCents: true },
    }),
  ]);
  return (redemptions._sum.discountAmountCents ?? 0) - (adjustments._sum.amountCents ?? 0);
}
