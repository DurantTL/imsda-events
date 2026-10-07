/**
 * What a registrant is shown on a church-billed (DEFERRED_ORGANIZATION_INVOICE)
 * event (#621): the per-person price only, never a total, subtotal, amount due
 * or balance. The church is billed after the event, so the person registering
 * (a club director, deputy or other registrant) has no use for a sum and must
 * not see one. Pure, so the form, the confirmation, the manage and account
 * pages, and the emails all use one rule. Prices themselves never change here;
 * only what is shown does. Staff reports and invoices keep their totals.
 *
 * Only the computed `PerPersonPrice` ever leaves the server for a church-billed
 * registrant: raw line items would let anyone add them back up to the total.
 */

export const CHURCH_BILLED_NOTICE = "Your church is billed after the event.";

/** What a registrant is told when a team event costs nothing: there is no church bill to announce (#809). */
export const NO_COST_NOTICE = "No cost.";

/** Whether any field of the form carries a price (a regular price, a choice price or late pricing). */
export function formHasPrices(definition: { sections: ReadonlyArray<{ fields: ReadonlyArray<{ priceCents?: number; choicePricesCents?: unknown; latePricing?: unknown }> }> }): boolean {
  return definition.sections.some((section) => section.fields.some((field) => field.priceCents !== undefined || field.choicePricesCents !== undefined || Boolean(field.latePricing)));
}

/** The price notice for an event with no prices at all: "No cost." instead of "billed to your church". Other prices are left as they are. */
export function noCostPrice(price: PerPersonPrice): PerPersonPrice {
  const free = price.attendeeLines.length === 0 && price.registrationLines.length === 0 && (price.uniformAmountCents === null || price.uniformAmountCents === 0);
  return free ? { ...price, notice: NO_COST_NOTICE } : price;
}

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
  /** True when the form has an attendee roster, so prices are per person. */
  roster: boolean;
  /** One entry per attendee (including free ones), only when attendees' prices differ; empty otherwise. */
  attendeeLines: Array<{ attendeeLabel: string; amountCents: number }>;
  /**
   * Registration-level lines, each shown on its own and never summed. On a roster
   * form these are fees for the whole registration; without a roster they are the price lines.
   */
  registrationLines: Array<{ label: string; amountCents: number }>;
  /** The shared per-person price when every attendee pays the same. */
  uniformAmountCents: number | null;
};

export function formatPerPersonAmount(cents: number) {
  const dollars = Math.abs(cents) / 100;
  const text = Number.isInteger(dollars)
    ? `$${dollars.toLocaleString("en-US")}`
    : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(dollars);
  return cents < 0 ? `-${text}` : text;
}

export type PerPersonPriceInput = {
  lineItems: readonly PerPersonLineItem[];
  /** Whether the form has an attendee roster (decides the wording, not the shape of the lines). */
  roster: boolean;
  /** Attendee names, in order, so free attendees still count. */
  attendeeNames?: readonly string[];
  attendeeCount?: number;
};

/**
 * On a roster form each attendee's own price is the sum of that person's own lines, $0 included.
 * Prices are never summed across attendees: identical prices collapse to "$X per person", differing
 * ones are listed per person. Registration-level lines are listed on their own, not added to anyone.
 * Without a roster nothing is called "per person": each line is listed as it is.
 */
export function perPersonPrice(input: PerPersonPriceInput): PerPersonPrice {
  const registrationLines = input.lineItems
    .filter((item) => !input.roster || item.attendeeIndex === undefined)
    .map((item) => ({ label: item.label, amountCents: item.amountCents }));
  if (!input.roster) {
    return { notice: CHURCH_BILLED_NOTICE, roster: false, attendeeLines: [], registrationLines, uniformAmountCents: null };
  }
  const lastIndexWithLine = input.lineItems.reduce((max, item) => Math.max(max, item.attendeeIndex ?? -1), -1);
  const count = Math.max(input.attendeeCount ?? 0, input.attendeeNames?.length ?? 0, lastIndexWithLine + 1);
  const people = Array.from({ length: count }, (_, index) => ({
    label: input.attendeeNames?.[index]?.trim()
      || input.lineItems.find((item) => item.attendeeIndex === index)?.attendeeLabel
      || `Person ${index + 1}`,
    amountCents: 0,
  }));
  for (const item of input.lineItems) {
    if (item.attendeeIndex === undefined) continue;
    people[item.attendeeIndex].amountCents += item.amountCents;
  }
  if (people.length === 0) {
    return { notice: CHURCH_BILLED_NOTICE, roster: true, attendeeLines: [], registrationLines, uniformAmountCents: null };
  }
  const first = people[0].amountCents;
  if (people.every((person) => person.amountCents === first)) {
    return {
      notice: `${formatPerPersonAmount(first)} per person. ${CHURCH_BILLED_NOTICE}`,
      roster: true,
      attendeeLines: [],
      registrationLines,
      uniformAmountCents: first,
    };
  }
  return {
    notice: `Prices are per person. ${CHURCH_BILLED_NOTICE}`,
    roster: true,
    attendeeLines: people.map((person) => ({ attendeeLabel: person.label, amountCents: person.amountCents })),
    registrationLines,
    uniformAmountCents: null,
  };
}

/** The display text of one registration-level line, in the words the roster setting calls for. */
export function registrationLineText(price: Pick<PerPersonPrice, "roster">, line: { label: string; amountCents: number }) {
  const amount = formatPerPersonAmount(line.amountCents);
  return price.roster ? `${line.label}: ${amount}` : `Price: ${line.label} ${amount}`;
}

/** The snapshot of what a registration is priced at now: the latest amendment's, else the original submission's. */
export function currentPricingSnapshot(registration: {
  operations?: ReadonlyArray<{ afterSnapshot: unknown }>;
  publicFormSubmission: { pricingSnapshot: unknown } | null;
}): Record<string, unknown> {
  const record = (value: unknown): Record<string, unknown> => (
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
  );
  const amended = record(record(registration.operations?.[0]?.afterSnapshot).pricingSnapshot);
  return Object.keys(amended).length > 0 ? amended : record(registration.publicFormSubmission?.pricingSnapshot);
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

/**
 * The per-person price from a stored pricing snapshot. `roster` comes from the form definition when the
 * caller has it; otherwise from the flag saved with the snapshot, then from whether any line names an attendee.
 */
export function perPersonPriceFromSnapshot(
  snapshot: unknown,
  roster?: boolean,
  /** The registration's current attendees, in order. Preferred over the snapshot's names, which a substitution leaves stale. */
  currentAttendeeNames?: readonly string[],
): PerPersonPrice {
  const record = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) ? snapshot as Record<string, unknown> : {};
  const lineItems = lineItemsFromPricingSnapshot(record);
  const rosterEnabled = roster
    ?? (typeof record.rosterEnabled === "boolean"
      ? record.rosterEnabled
      : lineItems.some((item) => item.attendeeIndex !== undefined));
  return perPersonPrice({
    lineItems,
    roster: rosterEnabled,
    attendeeNames: currentAttendeeNames && currentAttendeeNames.length > 0
      ? currentAttendeeNames
      : Array.isArray(record.attendeeNames) ? record.attendeeNames.filter((name): name is string => typeof name === "string") : undefined,
    attendeeCount: currentAttendeeNames && currentAttendeeNames.length > 0
      ? currentAttendeeNames.length
      : typeof record.attendeeCount === "number" ? record.attendeeCount : undefined,
  });
}

/** Plain-text lines for an email: the notice, then each differing or registration-level price. */
export function perPersonPriceText(price: PerPersonPrice) {
  return [
    price.notice,
    ...price.attendeeLines.map((line) => `${line.attendeeLabel}: ${formatPerPersonAmount(line.amountCents)} per person`),
    ...price.registrationLines.map((line) => registrationLineText(price, line)),
  ].join("\n");
}

/** One line for an email token: the notice, then each differing or registration-level price, never a sum. */
export function perPersonPriceInline(price: PerPersonPrice) {
  const parts = [
    ...price.attendeeLines.map((line) => `${line.attendeeLabel}: ${formatPerPersonAmount(line.amountCents)}`),
    ...price.registrationLines.map((line) => registrationLineText(price, line)),
  ];
  return parts.length === 0 ? price.notice : `${price.notice} ${parts.join("; ")}.`;
}
