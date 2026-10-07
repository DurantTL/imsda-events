/**
 * How a church-sponsorship flag reads to the finance office (#813). Pure, so the screen and its tests share one wording.
 * `shareCents` is what the church's share should be now; `reviewedShareCents` is the share finance last reviewed when they
 * cleared an earlier flag for the registration (null when none was). Amounts are cents; ids and names are not part of it.
 */
export type ChurchSponsorFlagFigures = { shareCents: number; reviewedShareCents: number | null; deltaCents: number };

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Math.abs(cents) / 100);
}

export function signedMoney(cents: number) {
  return `${cents < 0 ? "-" : "+"}${money(cents)}`;
}

export function churchSponsorFlagLabel(flag: ChurchSponsorFlagFigures) {
  if (flag.reviewedShareCents === null) return `church share ${signedMoney(flag.deltaCents)} not applied`;
  return `Church share now ${money(flag.shareCents)}; finance reviewed ${money(flag.reviewedShareCents)} (difference ${signedMoney(flag.deltaCents)} not applied)`;
}
