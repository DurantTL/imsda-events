/**
 * What a church owes for the promo codes it sponsors on a GENERAL event (#545).
 * Pure, so the staff finance screen, its CSV, and the overview tile agree on
 * one rule. Nothing is stored per redemption: like church-billed club
 * registrations (#409), the amount is worked out when someone looks, from the
 * `PromoCodeRedemption`: `discountAmountCents` (recorded when the code was used and
 * rewritten only by an amendment of the answers) plus `sponsorLodgingChangeCents`
 * (what staff lodging edits have moved the church's share by, #813).
 *
 * One line per redemption: a whole-registration code is one line
 * (`PromoCodeRedemption`), and a per-person or staff-applied code is one line
 * per person (`RegistrationAdjustment` of kind PROMO_CODE, #397), unless a
 * later adjustment reverses it. Each source is counted exactly once. The line
 * is the discount the attendee received. It counts only while the registration is
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
  /**
   * Unique per line: the redemption id (whole-registration code) or the
   * adjustment id (per-person or staff-applied code), so a registration with
   * several lines keeps each one distinct.
   */
  lineId: string;
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
      || left.confirmationCode.localeCompare(right.confirmationCode)
      || left.lineId.localeCompare(right.lineId));
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
