/**
 * The line-item table of the church invoice PDF (#780), as data, so the layout rules are testable without reading a PDF.
 *
 * Item / Description / Qty / Rate / Amount, grouped under a heading for the event's club type. Attended people are
 * collapsed into one row per distinct rate (qty x rate), a late-rate row stands apart, and each discount (a credit, the
 * promo, a staff adjustment) is its own negative row. Staff's manual lines come last under their own heading. The promo
 * code itself and confirmation codes are never part of the data. Built only from the frozen snapshot, the version's
 * manual lines and the few facts passed in.
 */

import type { InvoiceLine, InvoiceSnapshot } from "@/modules/invoices/domain";
import { manualLinesTotal, type ManualInvoiceLine } from "@/modules/invoices/manual-lines";

/** The header block at the top of the PDF. */
export type InvoiceHeader = {
  department: string | null;
  organizationName: string;
  addressLines: string[];
  phone: string | null;
};

export type InvoiceHeaderSettings = {
  organizationName: string;
  invoiceHeaderDepartment: string | null;
  invoiceHeaderOrganization: string | null;
  invoiceHeaderAddress: string | null;
  invoiceHeaderPhone: string | null;
};

const clean = (value: string | null | undefined) => (value ?? "").replace(/[\t ]+/g, " ").trim();

/** The editable header setting; each blank part is left out, and a blank organization falls back to the platform organization name. */
export function resolveInvoiceHeader(settings: InvoiceHeaderSettings): InvoiceHeader {
  return {
    department: clean(settings.invoiceHeaderDepartment) || null,
    organizationName: clean(settings.invoiceHeaderOrganization) || settings.organizationName,
    addressLines: (settings.invoiceHeaderAddress ?? "").split(/\r?\n/).map(clean).filter(Boolean),
    phone: clean(settings.invoiceHeaderPhone) || null,
  };
}

/** The Bill To address: the street, then "City, ST 12345". Any missing part is omitted, and a line with nothing in it is not printed. */
export function billToAddressLines(organization: { streetAddress: string | null; city: string | null; state: string | null; postalCode: string | null }) {
  const street = clean(organization.streetAddress);
  const city = clean(organization.city);
  const region = [clean(organization.state), clean(organization.postalCode)].filter(Boolean).join(" ");
  const locality = [city, region].filter(Boolean).join(", ");
  return [street, locality].filter(Boolean);
}

export const DEFAULT_CLUB_TYPE_HEADING = "Registrations";
export const MANUAL_LINES_HEADING = "Other charges";

export type LayoutRow = {
  item: string;
  description: string;
  quantity: number;
  rateCents: number;
  amountCents: number;
};

export type LayoutGroup = { heading: string; rows: LayoutRow[] };

export type InvoiceLayout = {
  groups: LayoutGroup[];
  totalCents: number;
  /** Payments less voided payments, from InvoicePayment. */
  paymentsCreditsCents: number;
  /** Never below zero; a payment beyond the total shows as Payments/Credits larger than Total. */
  balanceDueCents: number;
};

/** One row per distinct (rate, late) of the line's attended people, regular rates first (highest first), then late rates. */
function personRows(line: InvoiceLine): LayoutRow[] {
  const buckets = new Map<string, { rateCents: number; late: boolean; quantity: number }>();
  for (const person of line.people) {
    if (!person.billable || person.amountCents === null) continue;
    const late = person.lateRate === true;
    const key = `${late ? "late" : "regular"}:${person.amountCents}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.quantity += 1;
    else buckets.set(key, { rateCents: person.amountCents, late, quantity: 1 });
  }
  return [...buckets.values()]
    .sort((a, b) => Number(a.late) - Number(b.late) || b.rateCents - a.rateCents)
    .map((bucket) => ({
      item: line.label,
      description: bucket.late ? "Attended, late registration rate" : "Attended",
      quantity: bucket.quantity,
      rateCents: bucket.rateCents,
      amountCents: bucket.quantity * bucket.rateCents,
    }));
}

/** The rows of one registration. They always add up to the registration's `amountCents`. */
export function rowsForLine(line: InvoiceLine): LayoutRow[] {
  if (line.counts.billable === 0 && line.amountCents === 0) return [];
  const rows: LayoutRow[] = [];
  if (line.basis === "PER_PERSON_LINES") {
    rows.push(...personRows(line));
    for (const charge of line.chargesNotTiedToPerson) {
      if (charge.kind === "CHARGE") rows.push({ item: line.label, description: charge.label, quantity: 1, rateCents: charge.amountCents, amountCents: charge.amountCents });
    }
    // Every credit appears once, here. (A credit recorded as it was is also listed among the unattached charges; it is not repeated.)
    for (const credit of line.credits) {
      const perUnit = credit.units !== null && credit.units > 0 && credit.amountCents % credit.units === 0;
      rows.push({
        item: line.label,
        description: `Credit: ${credit.label}`,
        quantity: perUnit ? (credit.units as number) : 1,
        rateCents: perUnit ? credit.amountCents / (credit.units as number) : credit.amountCents,
        amountCents: credit.amountCents,
      });
    }
    // The code itself is never printed: a promo code may be private.
    if (line.promo) rows.push({ item: line.label, description: "Promo discount", quantity: 1, rateCents: line.promo.amountCents, amountCents: line.promo.amountCents });
    if (line.adjustmentCents !== 0) rows.push({ item: line.label, description: "Staff adjustments", quantity: 1, rateCents: line.adjustmentCents, amountCents: line.adjustmentCents });
  } else {
    // A prorated estimate: one row for the share of the registration that attended.
    rows.push({
      item: line.label,
      description: `Prorated: ${line.counts.billable} of ${line.counts.registered} attended`,
      quantity: 1,
      rateCents: line.components.personChargesCents,
      amountCents: line.components.personChargesCents,
    });
  }
  // A credit can bring a registration to $0 but never below it, so the rows can run past the amount: show the difference.
  const shown = rows.reduce((total, row) => total + row.amountCents, 0);
  if (shown !== line.amountCents) {
    const difference = line.amountCents - shown;
    rows.push({ item: line.label, description: "Credit limit adjustment", quantity: 1, rateCents: difference, amountCents: difference });
  }
  return rows;
}

export function buildInvoiceLayout(input: {
  snapshot: InvoiceSnapshot;
  manualLines: readonly ManualInvoiceLine[];
  /** The event's club-type heading (for example "Pathfinders"); blank prints "Registrations". */
  clubType: string | null;
  paymentsCreditsCents: number;
}): InvoiceLayout {
  const groups: LayoutGroup[] = [];
  const registrationRows = input.snapshot.lines.flatMap(rowsForLine);
  if (registrationRows.length > 0) groups.push({ heading: input.clubType?.trim() || DEFAULT_CLUB_TYPE_HEADING, rows: registrationRows });
  if (input.manualLines.length > 0) {
    groups.push({
      heading: MANUAL_LINES_HEADING,
      rows: input.manualLines.map((line) => ({ item: line.item, description: line.description, quantity: line.quantity, rateCents: line.rateCents, amountCents: line.amountCents })),
    });
  }
  const totalCents = input.snapshot.totals.amountDueCents + manualLinesTotal(input.manualLines);
  return {
    groups,
    totalCents,
    paymentsCreditsCents: input.paymentsCreditsCents,
    balanceDueCents: Math.max(totalCents - input.paymentsCreditsCents, 0),
  };
}
