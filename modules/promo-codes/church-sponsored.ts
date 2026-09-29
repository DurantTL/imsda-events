/**
 * What a church owes for the promo codes it sponsors on a GENERAL event (#545).
 * Pure, so the staff finance screen, its CSV, and the overview tile agree on
 * one rule. Nothing is stored per redemption: like church-billed club
 * registrations (#409), the amount is worked out when someone looks, from the
 * immutable `PromoCodeRedemption.discountAmountCents`.
 *
 * One line per redeemed registration. The line is the discount the attendee
 * received (the discount already applies to the whole registration, so there
 * is no per-attendee split). It counts only while the registration is
 * SUBMITTED or CONFIRMED (the same statuses `churchOwedCents` bills); a
 * cancelled, waitlisted, or draft registration drops out on its own.
 */
import {
  CHURCH_BILLED_STATUSES,
  isChurchBilledStatus,
  type ClubRegistrationStatus,
} from "@/modules/club-registrations/church-owed";

/** The registration statuses whose sponsored discount is billed to the church. */
export const CHURCH_SPONSORED_BILLED_STATUSES = CHURCH_BILLED_STATUSES;

/**
 * A church is billed for a sponsored code only on a GENERAL, attendee-paid
 * event. A club event, or any event already billed to organizations, bills
 * the church through church billing (#409); billing the discount as well
 * would bill it twice.
 */
export function eventBillsSponsoredPromoCodes(event: {
  audience: "GENERAL" | "CLUB";
  billingMode: "ATTENDEE_PAY" | "DEFERRED_ORGANIZATION_INVOICE";
}) {
  return event.audience === "GENERAL" && event.billingMode === "ATTENDEE_PAY";
}

export type ChurchSponsoredPromoLine = {
  churchId: string;
  churchName: string;
  promoCode: string;
  confirmationCode: string;
  status: ClubRegistrationStatus;
  amountCents: number;
};

/** Keeps only billed lines with a positive amount, ordered church then code then confirmation. */
export function billedSponsoredLines(lines: readonly ChurchSponsoredPromoLine[]) {
  return lines
    .filter((line) => isChurchBilledStatus(line.status) && line.amountCents > 0)
    .sort((left, right) =>
      left.churchName.localeCompare(right.churchName)
      || left.churchId.localeCompare(right.churchId)
      || left.promoCode.localeCompare(right.promoCode)
      || left.confirmationCode.localeCompare(right.confirmationCode));
}

export type ChurchSponsoredSubtotal = {
  churchId: string;
  churchName: string;
  lineCount: number;
  amountCents: number;
  lines: ChurchSponsoredPromoLine[];
};

export function summarizeSponsoredLines(lines: readonly ChurchSponsoredPromoLine[]) {
  const byChurch = new Map<string, ChurchSponsoredSubtotal>();
  for (const line of billedSponsoredLines(lines)) {
    const current = byChurch.get(line.churchId) ?? {
      churchId: line.churchId,
      churchName: line.churchName,
      lineCount: 0,
      amountCents: 0,
      lines: [],
    };
    current.lineCount += 1;
    current.amountCents += line.amountCents;
    current.lines.push(line);
    byChurch.set(line.churchId, current);
  }
  const churches = [...byChurch.values()].sort((left, right) =>
    left.churchName.localeCompare(right.churchName) || left.churchId.localeCompare(right.churchId));
  return {
    churches,
    lineCount: churches.reduce((sum, church) => sum + church.lineCount, 0),
    totalCents: churches.reduce((sum, church) => sum + church.amountCents, 0),
  };
}
