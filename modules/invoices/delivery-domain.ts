/**
 * Invoice delivery, accounts receivable and payments (#168). Pure rules, free of database access, so the
 * repositories, the screens and the tests agree.
 *
 * Nothing here sends anything by itself: an invoice goes out only when conference staff send it (Caleb,
 * Oct 4, 2026), always with the exact recipients and the version shown first.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { stableStringify } from "@/modules/attendance-reconciliation/domain";

// ---------------------------------------------------------------------------------------------
// Payment instruction (a finance setting, not a hard-coded fact)
// ---------------------------------------------------------------------------------------------

/** What the PDF says when finance staff have not set the event's payment instruction. */
export const DEFAULT_PAYMENT_INSTRUCTIONS = "Please remit by check to the Iowa-Missouri Conference.";
export const PAYMENT_INSTRUCTIONS_MAX = 600;

export function effectivePaymentInstructions(setting: string | null | undefined) {
  const trimmed = setting?.trim();
  return trimmed ? trimmed : DEFAULT_PAYMENT_INSTRUCTIONS;
}

/** A staff-entered instruction: plain text, at most PAYMENT_INSTRUCTIONS_MAX characters. Blank clears it (the default applies). */
export function normalizePaymentInstructions(input: string | null | undefined) {
  const text = (input ?? "").replace(/\r\n?/g, "\n").trim();
  if (text.length === 0) return { ok: true as const, value: null };
  if (text.length > PAYMENT_INSTRUCTIONS_MAX) return { ok: false as const, message: `Keep the payment instruction to ${PAYMENT_INSTRUCTIONS_MAX} characters or fewer.` };
  return { ok: true as const, value: text };
}

/** Bump when the PDF layout changes, so old documents say which layout made them. */
export const INVOICE_PDF_GENERATOR_VERSION = 4;

export function invoicePdfFilename(number: string) {
  return `Invoice-${number.replace(/[^A-Za-z0-9-]/g, "_")}.pdf`;
}

// ---------------------------------------------------------------------------------------------
// Money, dates and field limits for AR and payments
// ---------------------------------------------------------------------------------------------

export const REFERENCE_MAX = 80;
export const CHECK_NUMBER_MAX = 40;
export const PAYMENT_NOTE_MAX = 500;
export const ENTRY_REASON_MAX = 300;
export const SUBJECT_MAX = 200;
export const BODY_MAX = 5000;
/** The largest file an invoice email may carry (providers cap a message near 40 MB; a PDF of an invoice is a few KB). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** One check cannot plausibly exceed this; it catches a typed extra zero or a pasted number. */
export const MAX_PAYMENT_CENTS = 100_000_000;

/** "1,250.50", "$1250.5" or "1250" to cents, or null when it is not a plain amount with at most two decimals. */
export function parseMoneyToCents(input: string) {
  const cleaned = input.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [dollars, fraction = ""] = cleaned.split(".");
  const cents = Number(dollars) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}

/** A calendar date typed as YYYY-MM-DD, as a UTC midnight Date, or null when it is not a real date. */
export function parseDateOnly(input: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) return null;
  const date = new Date(`${input}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== input ? null : date;
}

export function formatDateOnly(date: Date | string) {
  return (typeof date === "string" ? new Date(date) : date).toISOString().slice(0, 10);
}

const dateField = z.string().trim().refine((value) => parseDateOnly(value) !== null, "Enter the date as YYYY-MM-DD.");
const optionalText = (max: number, label: string) =>
  z.string().trim().max(max, `Keep the ${label} to ${max} characters or fewer.`).nullable().optional().transform((value) => (value ? value : null));
const reasonField = z.string().trim().min(1, "Say why.").max(ENTRY_REASON_MAX, `Keep the reason to ${ENTRY_REASON_MAX} characters or fewer.`);
const requestKey = z.string().trim().min(16, "The request is missing its key. Reload the page.").max(100);

export const postToArSchema = z.object({
  versionId: z.string().trim().min(1).max(64),
  postedOn: dateField,
  reference: optionalText(REFERENCE_MAX, "reference"),
});

export const correctArSchema = postToArSchema.extend({ reason: reasonField });

export const recordPaymentSchema = z.object({
  invoiceId: z.string().trim().min(1).max(64),
  /** Dollars as typed ("1,250.50"); parsed to cents on the server. */
  amount: z.string().trim().min(1, "Enter the amount received.").max(20),
  checkNumber: optionalText(CHECK_NUMBER_MAX, "check number"),
  receivedOn: dateField,
  note: optionalText(PAYMENT_NOTE_MAX, "note"),
  requestKey,
});

export const voidPaymentSchema = z.object({
  paymentId: z.string().trim().min(1).max(64),
  reason: reasonField,
  requestKey,
});

// ---------------------------------------------------------------------------------------------
// Outstanding
// ---------------------------------------------------------------------------------------------

export type PaymentEntryLike = { id: string; kind: "PAYMENT" | "REVERSAL"; amountCents: number; reversesPaymentId: string | null };

/** Money received and not voided: every PAYMENT less every REVERSAL, across all of an invoice's versions. */
export function netPaidCents(entries: readonly PaymentEntryLike[]) {
  return entries.reduce((total, entry) => total + (entry.kind === "PAYMENT" ? entry.amountCents : -entry.amountCents), 0);
}

/** The ids of payments that a later REVERSAL voided. */
export function voidedPaymentIds(entries: readonly PaymentEntryLike[]) {
  return new Set(entries.flatMap((entry) => (entry.kind === "REVERSAL" && entry.reversesPaymentId ? [entry.reversesPaymentId] : [])));
}

/**
 * What is still owed on an invoice: the amount of its OPEN receivable (the live finalized version's total) less
 * every payment on the invoice, whichever version it was recorded against. A revision carries what was paid
 * forward this way: outstanding is always the new total less all payments on the invoice, so paying a $100 invoice
 * $60 and then revising it to $90 leaves $30 owed. Never below zero; paid beyond the total is `overpaidCents`
 * and is flagged for staff, never silently dropped.
 */
export function outstandingFigures(amountDueCents: number, entries: readonly PaymentEntryLike[]) {
  const paidCents = netPaidCents(entries);
  return {
    amountDueCents,
    paidCents,
    outstandingCents: Math.max(amountDueCents - paidCents, 0),
    overpaidCents: Math.max(paidCents - amountDueCents, 0),
  };
}

export type SettlementStatus = "NOTHING_DUE" | "UNPAID" | "PARTIALLY_PAID" | "PAID" | "OVERPAID";

export function settlementStatus(figures: { amountDueCents: number; paidCents: number; outstandingCents: number; overpaidCents: number }): SettlementStatus {
  if (figures.overpaidCents > 0) return "OVERPAID";
  if (figures.amountDueCents === 0) return "NOTHING_DUE";
  if (figures.paidCents <= 0) return "UNPAID";
  return figures.outstandingCents === 0 ? "PAID" : "PARTIALLY_PAID";
}

export function settlementLabel(status: SettlementStatus) {
  switch (status) {
    case "NOTHING_DUE":
      return "Nothing due";
    case "UNPAID":
      return "Unpaid";
    case "PARTIALLY_PAID":
      return "Partly paid";
    case "PAID":
      return "Paid";
    case "OVERPAID":
      return "Overpaid";
  }
}

// ---------------------------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------------------------

export type RecipientCandidate = {
  /** "billing", or "director:<attendeeAccountId>". The page sends back the keys that stay ticked, never an address. */
  key: string;
  kind: "BILLING_CONTACT" | "CLUB_DIRECTOR";
  name: string;
  email: string;
  /** Where the address came from, for staff: the contact's role, or the clubs the director leads on this invoice. */
  detail: string;
  attendeeAccountId: string | null;
  clubIds: string[];
  /** Billing contact only: the contact has not verified their address. */
  unverified: boolean;
  /** An earlier invoice email to this address bounced, was suppressed or drew a complaint (staff may still send). */
  priorProblem: string | null;
};

const emailSchema = z.email().max(254);

export function isDeliverableEmail(value: string | null | undefined) {
  return typeof value === "string" && emailSchema.safeParse(value.trim()).success;
}

/**
 * The people an invoice would go to: the church's current active billing contact (never the form submitter), then the
 * active director of each club on the invoice. An address appears once (a director who is also the billing
 * contact is a single recipient); an address that is not a deliverable email is left out (the billing contact is
 * then reported missing, and the screen says so).
 */
export function buildRecipientCandidates(input: {
  billingContact: { name: string; email: string; roleLabel: string; verified: boolean } | null;
  directors: ReadonlyArray<{ attendeeAccountId: string; name: string; email: string; clubId: string; clubName: string }>;
  problems?: ReadonlyMap<string, string>;
}): RecipientCandidate[] {
  const candidates: RecipientCandidate[] = [];
  const seen = new Set<string>();
  const problemFor = (email: string) => input.problems?.get(email.trim().toLowerCase()) ?? null;
  const contact = input.billingContact;
  if (contact && isDeliverableEmail(contact.email)) {
    const email = contact.email.trim().toLowerCase();
    seen.add(email);
    candidates.push({
      key: "billing",
      kind: "BILLING_CONTACT",
      name: contact.name,
      email,
      detail: contact.roleLabel ? `Billing contact, ${contact.roleLabel}` : "Billing contact",
      attendeeAccountId: null,
      clubIds: [],
      unverified: !contact.verified,
      priorProblem: problemFor(email),
    });
  }
  const byAccount = new Map<string, { name: string; email: string; clubs: Array<{ id: string; name: string }> }>();
  for (const director of input.directors) {
    if (!isDeliverableEmail(director.email)) continue;
    const entry = byAccount.get(director.attendeeAccountId) ?? { name: director.name, email: director.email.trim().toLowerCase(), clubs: [] };
    if (!entry.clubs.some((club) => club.id === director.clubId)) entry.clubs.push({ id: director.clubId, name: director.clubName });
    byAccount.set(director.attendeeAccountId, entry);
  }
  for (const [accountId, entry] of [...byAccount.entries()].sort(([, left], [, right]) => left.name.localeCompare(right.name) || left.email.localeCompare(right.email))) {
    if (seen.has(entry.email)) continue;
    seen.add(entry.email);
    candidates.push({
      key: `director:${accountId}`,
      kind: "CLUB_DIRECTOR",
      name: entry.name,
      email: entry.email,
      detail: `Director, ${entry.clubs.map((club) => club.name).sort().join(", ")}`,
      attendeeAccountId: accountId,
      clubIds: entry.clubs.map((club) => club.id).sort(),
      unverified: false,
      priorProblem: problemFor(entry.email),
    });
  }
  return candidates;
}

/** A hash of the recipient list the staff member was shown, so a send is refused if it changed before they sent. */
export function recipientsFingerprint(candidates: readonly RecipientCandidate[]) {
  return createHash("sha256")
    .update(stableStringify(candidates.map((candidate) => ({ key: candidate.key, email: candidate.email, kind: candidate.kind }))))
    .digest("hex");
}

export type RecipientSelectionIssue = "NONE_SELECTED" | "UNKNOWN_RECIPIENT";

/**
 * The candidates staff left ticked. At least one is required, and every key must be one of the candidates the
 * server computed: a key it does not know (a stale page, or a made-up one) is refused rather than ignored.
 */
export function selectRecipients(candidates: readonly RecipientCandidate[], selectedKeys: readonly string[]):
  | { ok: true; selected: RecipientCandidate[] }
  | { ok: false; issue: RecipientSelectionIssue } {
  const keys = [...new Set(selectedKeys)];
  const known = new Set(candidates.map((candidate) => candidate.key));
  if (keys.some((key) => !known.has(key))) return { ok: false, issue: "UNKNOWN_RECIPIENT" };
  const selected = candidates.filter((candidate) => keys.includes(candidate.key));
  if (selected.length === 0) return { ok: false, issue: "NONE_SELECTED" };
  return { ok: true, selected };
}

// ---------------------------------------------------------------------------------------------
// The message
// ---------------------------------------------------------------------------------------------

/**
 * Free text goes into a body that delivery scans for `{{...}}` sentinels. Breaking up the braces means nothing a
 * person types can ever look like one.
 */
export function neutralizePlaceholders(value: string) {
  return value.replaceAll("{{", "{ {").replaceAll("}}", "} }");
}

export function defaultInvoiceSubject(input: { number: string; organizationName: string; eventName: string }) {
  return `Invoice ${input.number} for ${input.organizationName}: ${input.eventName}`.slice(0, SUBJECT_MAX);
}

export function defaultInvoiceBody(input: {
  number: string;
  organizationName: string;
  eventName: string;
  amountLabel: string;
  filename: string;
  paymentInstructions: string;
  senderName: string;
  supersedesNumber: string | null;
}) {
  return [
    "Hello,",
    "",
    `Attached is invoice ${input.number} for ${input.organizationName} from ${input.eventName}, for ${input.amountLabel}.`,
    ...(input.supersedesNumber ? ["", `This invoice replaces ${input.supersedesNumber}.`] : []),
    "",
    input.paymentInstructions,
    "",
    "If you have questions about this invoice, reply to this email.",
    "",
    input.senderName,
  ].join("\n");
}

export const sendMessageSchema = z.object({
  subject: z.string().trim().min(1, "Enter a subject.").max(SUBJECT_MAX, `Keep the subject to ${SUBJECT_MAX} characters or fewer.`).refine((value) => !/[\r\n]/.test(value), "The subject must be one line."),
  body: z.string().trim().min(1, "Write the message.").max(BODY_MAX, `Keep the message to ${BODY_MAX} characters or fewer.`),
});

// ---------------------------------------------------------------------------------------------
// Delivery status in words
// ---------------------------------------------------------------------------------------------

export type RecipientDeliveryStatus = "SUPPRESSED" | "CANCELLED" | "QUEUED" | "CAPTURED" | "SENT" | "DELIVERED" | "BOUNCED" | "COMPLAINED" | "FAILED";

/** One word for staff from the outbox row and the provider's later report; a bounce or complaint wins over "sent". */
export function recipientDeliveryStatus(message: { status: string; providerDeliveryStatus: string | null }): RecipientDeliveryStatus {
  const provider = message.providerDeliveryStatus;
  if (provider === "BOUNCED") return "BOUNCED";
  if (provider === "COMPLAINED") return "COMPLAINED";
  if (provider === "SUPPRESSED" || message.status === "SUPPRESSED") return "SUPPRESSED";
  if (provider === "DELIVERED") return "DELIVERED";
  if (message.status === "CANCELLED") return "CANCELLED";
  if (provider === "FAILED" || message.status === "FAILED") return "FAILED";
  if (message.status === "SENT") return "SENT";
  if (message.status === "CAPTURED") return "CAPTURED";
  return "QUEUED";
}

export function deliveryStatusLabel(status: RecipientDeliveryStatus) {
  switch (status) {
    case "SUPPRESSED":
      return "Not sent (suppressed)";
    case "CANCELLED":
      return "Cancelled (the invoice was replaced before it went out)";
    case "QUEUED":
      return "Queued";
    case "CAPTURED":
      return "Captured locally (not emailed)";
    case "SENT":
      return "Sent";
    case "DELIVERED":
      return "Delivered";
    case "BOUNCED":
      return "Bounced";
    case "COMPLAINED":
      return "Marked as spam";
    case "FAILED":
      return "Failed";
  }
}

/** A status that means the address did not get the invoice and staff should look at it. */
export function isDeliveryProblem(status: RecipientDeliveryStatus) {
  return status === "BOUNCED" || status === "COMPLAINED" || status === "FAILED" || status === "SUPPRESSED";
}

// ---------------------------------------------------------------------------------------------
// Treasurer CSV
// ---------------------------------------------------------------------------------------------

export type TreasurerCsvInvoice = {
  number: string;
  supersedesNumber: string | null;
  organizationName: string;
  eventName: string;
  totalCents: number;
  postedToArOn: string | null;
  arReference: string | null;
  paidCents: number;
  outstandingCents: number;
  overpaidCents: number;
  lastSentAt: string | null;
};

const dollars = (cents: number) => (cents / 100).toFixed(2);

export const TREASURER_CSV_HEADER = [
  "Invoice number",
  "Supersedes",
  "Church or billed party",
  "Event",
  "Total",
  "Posted to AR on",
  "AR reference",
  "Paid",
  "Outstanding",
  "Overpaid",
  "Last sent",
];

/** Rows for the treasurer, the live finalized version of each invoice. Hand them to the shared CSV writer, which makes every cell formula-safe. */
export function treasurerCsvRows(invoices: readonly TreasurerCsvInvoice[]): Array<Array<string | number>> {
  return [
    TREASURER_CSV_HEADER,
    ...invoices.map((invoice) => [
      invoice.number,
      invoice.supersedesNumber ?? "",
      invoice.organizationName,
      invoice.eventName,
      dollars(invoice.totalCents),
      invoice.postedToArOn ?? "",
      invoice.arReference ?? "",
      dollars(invoice.paidCents),
      dollars(invoice.outstandingCents),
      dollars(invoice.overpaidCents),
      invoice.lastSentAt ? invoice.lastSentAt.slice(0, 10) : "",
    ]),
  ];
}
