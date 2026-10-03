import type { RegistrationFormDefinition, RegistrationFormField } from "@/modules/forms/definition";
import { formatPerPersonAmount } from "@/modules/club-registrations/per-person-price";

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

function feeFields(definition: RegistrationFormDefinition): RegistrationFormField[] {
  const fields = definition.sections.flatMap((section) => section.fields);
  return fields.filter((field) => (
    field.type === "CALCULATED"
    && field.priceCents !== undefined
    && field.priceCents > 0
    && !field.choicePricesCents
    && !field.latePricing?.choicePricesCents
  ));
}

export function churchInvoiceTerms(
  definition: RegistrationFormDefinition,
  options: { pricingDate: string; attendeeLabel?: string },
): ChurchInvoiceTerms | null {
  const fields = feeFields(definition);
  if (fields.length !== 1) return null;
  const fee = fields[0];
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
 * The church the invoice goes to, from the registrant's own answer to the
 * form's churches-directory question; null when there is none or it is blank.
 */
export function invoiceRecipientName(
  definition: RegistrationFormDefinition,
  responses: Record<string, unknown>,
): string | null {
  const field = definition.sections
    .flatMap((section) => section.fields)
    .find((candidate) => candidate.optionSource === "CHURCHES_DIRECTORY");
  const answer = field ? responses[field.key] : undefined;
  return typeof answer === "string" && answer.trim() !== "" ? answer.trim() : null;
}
