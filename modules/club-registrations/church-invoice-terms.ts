import type { RegistrationFormDefinition, RegistrationFormField } from "@/modules/forms/definition";
import { resolveResponsibleOrganization } from "@/modules/forms/definition";
import { formatPerPersonAmount, type PerPersonPrice } from "@/modules/club-registrations/per-person-price";

/**
 * The wording a church-invoiced (DEFERRED_ORGANIZATION_INVOICE) registration
 * leads with (#743): the per-person rate and its terms, built only from the
 * form's configured fee and its late-pricing date, never hardcoded. Pure, so
 * the form, the review step and the tests share one rule.
 *
 * Only a plain per-person fee is described here: exactly one fee field with
 * a `priceCents`. Anything more varied (choice prices, several conditional
 * fees) returns null and the form keeps showing its per-person notice.
 */

export const CHURCH_INVOICE_TIMING = "Your church will be invoiced after the event, based on confirmed attendance.";
export const NO_PAYMENT_ONLINE = "No payment due online";

export type ChurchInvoiceRateTier = {
  amountCents: number;
  /** The last day this rate applies (ISO date), or null when it has no deadline. */
  throughDate: string | null;
};

export type ChurchInvoiceTerms = {
  tiers: ChurchInvoiceRateTier[];
  /** The fee field's label: its price line is the rate above, so it is not listed again. */
  feeLabel: string;
  /** "$9 per attendee through April 10; $14 afterward." or "$9 per attendee." */
  rateSentence: string;
  /** The lead sentence for the form: the rate, then that no payment is collected here. */
  leadSentence: string;
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-04-10" -> "April 10" (with the year when it is not `referenceYear`). */
export function formatInvoiceDate(iso: string, referenceYear?: number) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return iso;
  const year = Number(match[1]);
  const text = `${MONTHS[Number(match[2]) - 1]} ${Number(match[3])}`;
  return referenceYear !== undefined && year !== referenceYear ? `${text}, ${year}` : text;
}

/** The ISO date one day before `iso`, in UTC so no timezone can move it. */
function dayBefore(iso: string) {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

function isPriced(field: RegistrationFormField) {
  return (field.priceCents !== undefined && field.priceCents > 0)
    || Object.keys(field.choicePricesCents ?? {}).length > 0
    || Object.keys(field.latePricing?.choicePricesCents ?? {}).length > 0
    || (field.latePricing?.priceCents !== undefined && field.latePricing.priceCents > 0);
}

/**
 * The one fee the sentence can honestly describe: the only priced field in the
 * whole form, a plain per-attendee amount (not a choice price, a checkbox or a
 * quantity), charged to every attendee (attendee scope, or a form with no
 * roster) with no condition that could skip it. Otherwise null.
 */
function soleFeeField(definition: RegistrationFormDefinition): RegistrationFormField | null {
  const priced = definition.sections.flatMap((section) => section.fields).filter(isPriced);
  if (priced.length !== 1) return null;
  const fee = priced[0];
  if (fee.type !== "CALCULATED" || !fee.priceCents || fee.choicePricesCents || fee.latePricing?.choicePricesCents) return null;
  if (fee.conditional || fee.optionalWhen) return null;
  if (definition.attendeeRoster?.enabled && fee.scope !== "ATTENDEE") return null;
  return fee;
}

export function churchInvoiceTerms(
  definition: RegistrationFormDefinition,
  options: { pricingDate: string; attendeeLabel?: string },
): ChurchInvoiceTerms | null {
  const fee = soleFeeField(definition);
  if (!fee) return null;
  const regular = fee.priceCents as number;
  const late = fee.latePricing && fee.latePricing.priceCents !== undefined && fee.latePricing.priceCents !== regular
    ? { amountCents: fee.latePricing.priceCents, startsOn: fee.latePricing.startsOn }
    : null;
  const label = (options.attendeeLabel ?? definition.attendeeRoster?.attendeeLabel ?? "attendee").trim().toLocaleLowerCase();
  const referenceYear = Number(options.pricingDate.slice(0, 4)) || undefined;
  let tiers: ChurchInvoiceRateTier[];
  if (!late) {
    tiers = [{ amountCents: regular, throughDate: null }];
  } else if (options.pricingDate >= late.startsOn) {
    // The deadline has passed: only the rate in force is described.
    tiers = [{ amountCents: late.amountCents, throughDate: null }];
  } else {
    tiers = [
      { amountCents: regular, throughDate: dayBefore(late.startsOn) },
      { amountCents: late.amountCents, throughDate: null },
    ];
  }
  const rateSentence = tiers.length === 1
    ? `${formatPerPersonAmount(tiers[0].amountCents)} per ${label}.`
    : `${formatPerPersonAmount(tiers[0].amountCents)} per ${label} through ${formatInvoiceDate(tiers[0].throughDate as string, referenceYear)}; ${formatPerPersonAmount(tiers[1].amountCents)} afterward.`;
  return {
    tiers,
    feeLabel: fee.label,
    rateSentence,
    leadSentence: `${rateSentence} No payment is collected with this form — your church will be invoiced after the event based on confirmed attendance.`,
  };
}

/**
 * The organization the invoice goes to: the same reading the staff invoice
 * uses (`resolveResponsibleOrganization`), so a "Not listed" church shows the
 * name typed beside it. Null when nothing resolves.
 */
export function invoiceRecipientName(
  _definition: RegistrationFormDefinition,
  responses: Record<string, unknown>,
): string | null {
  return resolveResponsibleOrganization(responses);
}

/**
 * True only when what the form is pricing right now is exactly the rate the
 * sentence states, so the sentence can never contradict the amounts. With a
 * roster every attendee must owe that one rate; without one the fee's own
 * price line must be that rate.
 */
export function termsMatchPrice(terms: ChurchInvoiceTerms, price: PerPersonPrice) {
  const active = terms.tiers[0].amountCents;
  if (price.roster) return price.uniformAmountCents === active;
  return price.registrationLines.some((line) => line.label === terms.feeLabel && line.amountCents === active);
}

/** The price lines still worth listing: the fee line is dropped only when the sentence covers it exactly. */
export function linesNotCoveredByTerms(terms: ChurchInvoiceTerms, price: PerPersonPrice) {
  const active = terms.tiers[0].amountCents;
  return price.registrationLines.filter((line) => !(line.label === terms.feeLabel && line.amountCents === active));
}
