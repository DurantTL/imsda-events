/**
 * Deferred-organization invoices (#167, ADR 0008). Pure rules, free of database access, so the
 * repository, the finance screens and the tests agree.
 *
 * An invoice is built from the event's APPROVED attendance reconciliation (#166) and the RECORDED
 * billing responsibility and grouping (#165), one invoice per invoice group. A draft is a snapshot
 * of those facts plus the billing contact at that moment; finalizing it (a deliberate act of a named
 * person holding the Finalize invoices permission) assigns its number once and freezes it. Later
 * corrections are revisions of the same invoice, never rewrites. Nothing here sends anything (#168).
 */

import { createHash } from "node:crypto";
import {
  stableStringify,
  type AmountBasis,
  type Counts,
  type GroupResult,
  type RegistrationResult,
} from "@/modules/attendance-reconciliation/domain";

export type InvoiceVersionStatus = "DRAFT" | "FINALIZED" | "SUPERSEDED" | "DISCARDED";
export type InvoiceVersionBasis = "RECONCILIATION" | "CONTACT_ONLY_COPY";
export type InvoiceReceivableStatus = "OPEN" | "SUPERSEDED";

export const INVOICE_SNAPSHOT_SCHEMA = 1;

export function versionStatusLabel(status: InvoiceVersionStatus) {
  if (status === "DRAFT") return "Draft";
  if (status === "FINALIZED") return "Finalized";
  if (status === "DISCARDED") return "Discarded";
  return "Superseded";
}

// ---------------------------------------------------------------------------------------------
// Numbers: <EVENTCODE><YY>-<NNNN>, revisions -R1, -R2
// ---------------------------------------------------------------------------------------------

export const INVOICE_CODE_PATTERN = /^[A-Z]{2,6}$/;

/**
 * The invoice code of an event that has none set: the initials of the words of its name that start
 * with a letter, uppercase, at most four ("Spring Camporee 2027" is SC). A name with fewer than two
 * such words uses the first letters of the name instead, and a name with no letters at all uses EV.
 * Staff can set an explicit code before the first invoice is finalized.
 */
export function deriveInvoiceCode(eventName: string) {
  const plain = eventName.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/['’]/g, "");
  const words = plain.split(/[^A-Za-z0-9]+/).filter((word) => /^[A-Za-z]/.test(word));
  const initials = words.map((word) => word[0]!.toUpperCase()).join("").slice(0, 4);
  if (initials.length >= 2) return initials;
  const letters = plain.replace(/[^A-Za-z]/g, "").toUpperCase();
  return letters.length >= 2 ? letters.slice(0, 3) : "EV";
}

/** A staff-entered code: letters only, two to six, uppercased. Returns null when it is not valid. */
export function normalizeInvoiceCode(input: string) {
  const code = input.trim().toUpperCase();
  return INVOICE_CODE_PATTERN.test(code) ? code : null;
}

/** The year printed in the number: the year the event starts, in the event's own time zone. */
export function eventInvoiceYear(startsAt: Date, timezone: string) {
  try {
    const year = Number(new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric" }).format(startsAt));
    if (Number.isInteger(year)) return year;
  } catch {
    // An unknown time zone falls back to UTC below.
  }
  return startsAt.getUTCFullYear();
}

export function formatBaseNumber(code: string, year: number, sequence: number) {
  return `${code}${String(year % 100).padStart(2, "0")}-${String(sequence).padStart(4, "0")}`;
}

/** SC27-0001 for the original, SC27-0001-R1 for its first revision. */
export function formatVersionNumber(baseNumber: string, revision: number) {
  return revision === 0 ? baseNumber : `${baseNumber}-R${revision}`;
}

// ---------------------------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------------------------

/** The billing contact when the draft was made. For a group billed to a person it is that person. */
export type InvoiceContact = {
  name: string;
  email: string;
  roleLabel: string;
  verified: boolean;
};

export type InvoiceLinePerson = {
  attendeeId: string;
  name: string;
  /** Attended (checked in, or marked attended by staff), so billed. */
  billable: boolean;
  /** The person's own price lines when billed per person; null when not billed or when the registration was prorated. */
  amountCents: number | null;
  /** True when the person's own price was the late-registration rate (#780). Absent on a snapshot made before it. */
  lateRate?: boolean;
};

/** One registration (a club, or a person's registration) on the invoice. */
export type InvoiceLine = {
  registrationId: string;
  confirmationCode: string;
  label: string;
  clubId: string | null;
  counts: Counts;
  basis: AmountBasis;
  people: InvoiceLinePerson[];
  /** Charges for the whole registration (a flat or late fee) and credits recorded as they were; not tied to a person. */
  chargesNotTiedToPerson: Array<{ label: string; amountCents: number; kind: "CHARGE" | "CREDIT_AS_RECORDED" }>;
  /** Credits such as meal sponsorship (zero or negative cents). */
  credits: Array<{ label: string; units: number | null; amountCents: number }>;
  promo: { code: string; amountCents: number } | null;
  adjustmentCents: number;
  components: RegistrationResult["components"];
  /** What this registration adds to the invoice. */
  amountCents: number;
};

export type InvoiceSnapshot = {
  schema: typeof INVOICE_SNAPSHOT_SCHEMA;
  event: { id: string; name: string };
  groupKey: string;
  groupTitle: string;
  invoiceGrouping: "PER_CHURCH" | "PER_CLUB";
  party: { kind: "ORGANIZATION" | "PERSON"; id: string | null; name: string };
  clubId: string | null;
  reconciliation: { versionId: string; versionNumber: number; ruleVersion: string };
  lines: InvoiceLine[];
  totals: { registered: number; checkedIn: number; noShow: number; billable: number; amountDueCents: number };
};

export type InvoiceFigures = {
  snapshot: InvoiceSnapshot;
  groupTitle: string;
  organizationName: string;
  registeredCount: number;
  billableCount: number;
  amountDueCents: number;
  amountsFingerprint: string;
};

export function invoiceLineFor(registration: RegistrationResult): InvoiceLine {
  const perPerson = registration.basis === "PER_PERSON_LINES";
  return {
    registrationId: registration.registrationId,
    confirmationCode: registration.confirmationCode,
    label: registration.label,
    clubId: registration.clubId,
    counts: registration.counts,
    basis: registration.basis,
    people: registration.people.map((person) => ({
      attendeeId: person.attendeeId,
      name: person.name,
      billable: person.billable,
      amountCents: person.billable && perPerson ? person.chargeCents : null,
      lateRate: person.lateRate,
    })),
    chargesNotTiedToPerson: registration.unattached.map((entry) => ({ label: entry.label, amountCents: entry.amountCents, kind: entry.kind })),
    credits: registration.credits.map((credit) => ({ label: credit.label, units: credit.units, amountCents: credit.appliedCents })),
    promo: registration.promo ? { code: registration.promo.code, amountCents: registration.promo.appliedCents } : null,
    adjustmentCents: registration.components.adjustmentCents,
    components: registration.components,
    amountCents: registration.billableCents,
  };
}

/**
 * Every figure that decides what is owed, and nothing else (no names, labels, contacts or ids of
 * versions): the lines' amounts, credits, promo, charges and total. Two versions with the same
 * fingerprint bill the same amounts, so a revision that matches the version it replaces changed no
 * billable amount (ADR 0008 section 4).
 */
export function amountsProjection(lines: readonly InvoiceLine[], amountDueCents: number) {
  return {
    amountDueCents,
    lines: lines.map((line) => ({
      registrationId: line.registrationId,
      amountCents: line.amountCents,
      basis: line.basis,
      billable: line.counts.billable,
      components: line.components,
      people: line.people.filter((person) => person.billable).map((person) => ({ attendeeId: person.attendeeId, amountCents: person.amountCents })),
      charges: line.chargesNotTiedToPerson.map((entry) => ({ label: entry.label, amountCents: entry.amountCents })),
      credits: line.credits.map((credit) => ({ label: credit.label, amountCents: credit.amountCents })),
      promo: line.promo,
    })),
  };
}

export function amountsFingerprintOf(lines: readonly InvoiceLine[], amountDueCents: number) {
  return createHash("sha256").update(stableStringify(amountsProjection(lines, amountDueCents))).digest("hex");
}

/**
 * The invoice figures for one invoice group of an approved reconciliation. `group` is null when the
 * approved reconciliation no longer has this group (its registrations are gone): the figures are
 * then zero lines and a $0 total, so a revision can bring a finalized invoice to $0.
 */
export function buildInvoiceFigures(input: {
  event: { id: string; name: string };
  groupKey: string;
  groupTitle: string;
  invoiceGrouping: "PER_CHURCH" | "PER_CLUB";
  party: InvoiceSnapshot["party"];
  clubId: string | null;
  reconciliation: InvoiceSnapshot["reconciliation"];
  group: GroupResult | null;
}): InvoiceFigures {
  const lines = (input.group?.registrations ?? []).map(invoiceLineFor);
  const amountDueCents = lines.reduce((total, line) => total + line.amountCents, 0);
  const totals = lines.reduce(
    (sum, line) => ({
      registered: sum.registered + line.counts.registered,
      checkedIn: sum.checkedIn + line.counts.checkedIn,
      noShow: sum.noShow + line.counts.noShow,
      billable: sum.billable + line.counts.billable,
    }),
    { registered: 0, checkedIn: 0, noShow: 0, billable: 0 },
  );
  const snapshot: InvoiceSnapshot = {
    schema: INVOICE_SNAPSHOT_SCHEMA,
    event: input.event,
    groupKey: input.groupKey,
    groupTitle: input.groupTitle,
    invoiceGrouping: input.invoiceGrouping,
    party: input.party,
    clubId: input.clubId,
    reconciliation: input.reconciliation,
    lines,
    totals: { ...totals, amountDueCents },
  };
  return {
    snapshot,
    groupTitle: input.groupTitle,
    organizationName: input.party.name,
    registeredCount: totals.registered,
    billableCount: totals.billable,
    amountDueCents,
    amountsFingerprint: amountsFingerprintOf(lines, amountDueCents),
  };
}

// ---------------------------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------------------------

/** A billing contact as the screens and rows carry it: `name`/`email`, or a version's `contactName`/`contactEmail`. */
export type ContactLike = { name?: string | null; email?: string | null; contactName?: string | null; contactEmail?: string | null };

const normalizeContact = (contact: ContactLike | null | undefined) => {
  const name = contact?.name ?? contact?.contactName;
  const email = contact?.email ?? contact?.contactEmail;
  return name && email ? `${name.trim().toLowerCase()}|${email.trim().toLowerCase()}` : null;
};

/** Whether two billing contacts are the same person at the same address (case and spacing aside). A missing contact matches only another missing one. */
export function contactsMatch(left: ContactLike | null | undefined, right: ContactLike | null | undefined) {
  return normalizeContact(left) === normalizeContact(right);
}

// ---------------------------------------------------------------------------------------------
// Who may finalize, and when
// ---------------------------------------------------------------------------------------------

/**
 * A version needs the Finalize invoices permission unless it only changes the contact: an original
 * invoice always does, and a revision does when any billable amount differs from the finalized
 * version it replaces (ADR 0008 section 4, Caleb Oct 4, 2026). Compared by the amounts fingerprint,
 * never by a flag the caller sets.
 */
export function finalizationNeedsPermission(draft: { revision: number; amountsFingerprint: string }, prior: { amountsFingerprint: string } | null) {
  return draft.revision === 0 || prior === null || prior.amountsFingerprint !== draft.amountsFingerprint;
}

/** What the revision changed relative to the version it replaces, in words for staff. */
export function revisionChangeSummary(draft: { amountsFingerprint: string; amountDueCents: number; contactName: string | null; contactEmail: string | null }, prior: { amountsFingerprint: string; amountDueCents: number; contactName: string | null; contactEmail: string | null }) {
  const amounts = prior.amountsFingerprint !== draft.amountsFingerprint;
  const contact = !contactsMatch(prior, draft);
  return { amountsChanged: amounts, contactChanged: contact, previousAmountCents: prior.amountDueCents, amountCents: draft.amountDueCents };
}

export const REVISION_REASON_MAX = 500;
