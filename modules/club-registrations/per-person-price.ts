/**
 * What a registrant is shown on a church-billed (DEFERRED_ORGANIZATION_INVOICE)
 * event (#621): the per-person price only, never a total, subtotal, amount due
 * or balance. The church is billed after the event, so the person registering
 * (a club director, deputy or other registrant) has no use for a sum and must
 * not see one. Pure, so the form, the confirmation, the manage and account
 * pages, and the emails all use one rule. Prices themselves never change here;
 * only what is shown does. Staff reports and invoices keep their totals.
 */

export const CHURCH_BILLED_NOTICE = "Your church is billed after the event.";

export function isChurchBilledBillingMode(billingMode: string | null | undefined) {
  return billingMode === "DEFERRED_ORGANIZATION_INVOICE";
}

export type PerPersonLineItem = {
  key?: string;
  label: string;
  amountCents: number;
  pricingLabel?: string;
  attendeeIndex?: number;
  attendeeLabel?: string;
};

export type PerPersonPrice = {
  /** Sentence for the price notice, e.g. "$25 per person. Your church is billed after the event." */
  notice: string;
  /** One entry per attendee, only when attendees' prices differ; empty otherwise. */
  attendeeLines: Array<{ attendeeLabel: string; amountCents: number }>;
  /** The shared per-person price when every attendee pays the same. */
  uniformAmountCents: number | null;
};

export function formatPerPersonAmount(cents: number) {
  const dollars = cents / 100;
  return Number.isInteger(dollars)
    ? `$${dollars.toLocaleString("en-US")}`
    : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(dollars);
}

/**
 * Each attendee's own price is the sum of that person's own lines. Prices are never summed across
 * attendees: identical prices collapse to "$X per person", differing ones are listed per person.
 * Registration-level lines on a roster form (no attendee) are not per-person prices and are ignored.
 */
export function perPersonPrice(lineItems: readonly PerPersonLineItem[]): PerPersonPrice {
  const byAttendee = new Map<number, { label: string; amountCents: number }>();
  for (const item of lineItems) {
    if (item.attendeeIndex === undefined) continue;
    const current = byAttendee.get(item.attendeeIndex)
      ?? { label: item.attendeeLabel ?? `Person ${item.attendeeIndex + 1}`, amountCents: 0 };
    current.amountCents += item.amountCents;
    byAttendee.set(item.attendeeIndex, current);
  }
  let people = [...byAttendee.entries()].sort(([a], [b]) => a - b).map(([, person]) => person);
  if (people.length === 0 && lineItems.length > 0 && lineItems.every((item) => item.attendeeIndex === undefined)) {
    // No roster on the form: the registrant is the one person, priced by the plain lines.
    people = [{ label: "Registrant", amountCents: lineItems.reduce((sum, item) => sum + item.amountCents, 0) }];
  }
  if (people.length === 0) {
    return { notice: CHURCH_BILLED_NOTICE, attendeeLines: [], uniformAmountCents: null };
  }
  const first = people[0].amountCents;
  if (people.every((person) => person.amountCents === first)) {
    return { notice: `${formatPerPersonAmount(first)} per person. ${CHURCH_BILLED_NOTICE}`, attendeeLines: [], uniformAmountCents: first };
  }
  return {
    notice: `Prices are per person. ${CHURCH_BILLED_NOTICE}`,
    attendeeLines: people.map((person) => ({ attendeeLabel: person.label, amountCents: person.amountCents })),
    uniformAmountCents: null,
  };
}

/** The line items a public registration stored in its pricing snapshot; empty for anything malformed or absent. */
export function lineItemsFromPricingSnapshot(value: unknown): PerPersonLineItem[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const items = (value as { lineItems?: unknown }).lineItems;
  if (!Array.isArray(items)) return [];
  return items.flatMap((entry): PerPersonLineItem[] => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    if (typeof item.label !== "string" || typeof item.amountCents !== "number" || !Number.isFinite(item.amountCents)) return [];
    return [{
      label: item.label,
      amountCents: item.amountCents,
      ...(typeof item.pricingLabel === "string" ? { pricingLabel: item.pricingLabel } : {}),
      ...(typeof item.attendeeIndex === "number" ? { attendeeIndex: item.attendeeIndex } : {}),
      ...(typeof item.attendeeLabel === "string" ? { attendeeLabel: item.attendeeLabel } : {}),
    }];
  });
}

/** Plain-text lines for an email: the notice, then each differing per-person price. */
export function perPersonPriceText(lineItems: readonly PerPersonLineItem[]) {
  const price = perPersonPrice(lineItems);
  return [
    price.notice,
    ...price.attendeeLines.map((line) => `${line.attendeeLabel}: ${formatPerPersonAmount(line.amountCents)} per person`),
  ].join("\n");
}

/** One line for an email token: the notice, then each differing per-person price, never a sum. */
export function perPersonPriceInline(lineItems: readonly PerPersonLineItem[]) {
  const price = perPersonPrice(lineItems);
  if (price.attendeeLines.length === 0) return price.notice;
  return `${price.notice} ${price.attendeeLines.map((line) => `${line.attendeeLabel}: ${formatPerPersonAmount(line.amountCents)}`).join("; ")}.`;
}
