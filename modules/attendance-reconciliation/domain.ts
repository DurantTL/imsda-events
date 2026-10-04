/**
 * Reviewed attendance and billable-unit reconciliation for deferred-invoice events (#166). Pure
 * rules, free of database access, so the finance screen, its CSV, the repository and the tests
 * all agree.
 *
 * Caleb's decision (Oct 4, 2026) is the policy: a church is billed only for the people who were
 * actually checked in. Registered people who never came are no-shows and are not billed. Staff can
 * correct the check-in record either way (with a reason, audited), and the corrections are shown
 * separately. The #409 amounts (the per-person rate, which already carries the late price when the
 * registration was priced late, and the meal-sponsorship credit) are applied to the people who
 * attended, not to everyone registered. The amounts shown before the event stay estimates.
 *
 * Source facts stay distinct: the registered roster, the check-in evidence, the staff corrections,
 * and the recorded price lines. This codebase has no concept of an excluded or complimentary
 * person or role in billing (a free person is simply a $0 price line), so none is invented here.
 *
 * Nothing in this file finalizes, numbers or sends an invoice (#167, #168).
 */

import { CHURCH_BILLED_STATUSES, type ClubRegistrationStatus } from "@/modules/club-registrations/church-owed";

/** Bump when the rules below change, so a version made under the old rules is never mistaken for a current one. */
export const RECONCILIATION_RULE_VERSION = "attended-v1";

export type CorrectionKind = "MARK_ATTENDED" | "MARK_NOT_ATTENDED" | "CLEAR";

export const CORRECTION_KINDS: readonly CorrectionKind[] = ["MARK_ATTENDED", "MARK_NOT_ATTENDED", "CLEAR"];

export const IN_SCOPE_STATUSES: readonly ClubRegistrationStatus[] = CHURCH_BILLED_STATUSES;

/** An attendee created this long after the registration was submitted counts as added after submission. */
export const LATE_ADDITION_GRACE_MS = 60_000;

export function correctionLabel(kind: CorrectionKind) {
  if (kind === "MARK_ATTENDED") return "Marked attended by staff";
  if (kind === "MARK_NOT_ATTENDED") return "Marked not attended by staff";
  return "Correction withdrawn";
}

// ---------------------------------------------------------------------------------------------
// Source facts
// ---------------------------------------------------------------------------------------------

export type ActiveCorrection = {
  id: string;
  kind: "MARK_ATTENDED" | "MARK_NOT_ATTENDED";
  reason: string;
  actorName: string | null;
  createdAt: string;
};

export type PersonSource = {
  attendeeId: string;
  name: string;
  /** Checked in and not undone: the check-in evidence. */
  checkedIn: boolean;
  /** The active staff correction, if any (a withdrawn one is not a correction). */
  correction: ActiveCorrection | null;
  /** Added to the registration after it was submitted. Informational. */
  addedAfterSubmission: boolean;
  /** Replaced by another person after submission. Informational. */
  substituted: boolean;
  /** The person's own recorded price lines, in cents (the late price is already in it). */
  chargeCents: number;
  /** True when one of those lines is a late-registration price. Informational. */
  lateRate: boolean;
  /** Staff adjustments (scholarship, discount) recorded for this person alone. */
  adjustmentCents: number;
};

export type CreditSource = {
  key: string;
  label: string;
  /** The form's credit per unit (negative cents) and the units the registrant entered; null when unknown. */
  centsPerUnit: number | null;
  rawUnits: number | null;
  capAtHeadcount: boolean;
  /** The credit as recorded in the estimate (negative cents). */
  recordedCents: number;
};

export type RegistrationSource = {
  registrationId: string;
  confirmationCode: string;
  status: ClubRegistrationStatus;
  label: string;
  clubId: string | null;
  locationId: string | null;
  locationName: string | null;
  /** The #409 estimate: the priced total of the registered roster. */
  estimatedCents: number;
  people: PersonSource[];
  /** Positive registration-level price lines (a flat or late fee for the whole registration). */
  registrationChargeCents: number;
  credits: CreditSource[];
  /** Staff adjustments that are not for one person. */
  registrationAdjustmentCents: number;
  /** False when the registration has no recorded price lines (staff-entered): the estimate is prorated instead. */
  hasPriceLines: boolean;
};

export type GroupSource = {
  key: string;
  title: string;
  partyKind: "ORGANIZATION" | "PERSON" | "UNRESOLVED";
  partyId: string | null;
  partyName: string;
  clubId: string | null;
  registrations: RegistrationSource[];
};

// ---------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------

export type PersonState = "CHECKED_IN" | "NO_SHOW" | "ADDED_BY_STAFF" | "REMOVED_BY_STAFF";

export function personStateLabel(state: PersonState) {
  switch (state) {
    case "CHECKED_IN": return "Checked in";
    case "NO_SHOW": return "No-show";
    case "ADDED_BY_STAFF": return "Corrected: attended";
    default: return "Corrected: not attended";
  }
}

export type PersonResult = {
  attendeeId: string;
  name: string;
  state: PersonState;
  checkedIn: boolean;
  billable: boolean;
  chargeCents: number;
  correction: ActiveCorrection | null;
  addedAfterSubmission: boolean;
  substituted: boolean;
  lateRate: boolean;
};

export type Counts = {
  registered: number;
  checkedIn: number;
  /** Registered but never checked in, before any correction. */
  noShow: number;
  addedByStaff: number;
  removedByStaff: number;
  /** checkedIn + addedByStaff - removedByStaff. */
  billable: number;
};

export type AmountBasis = "PER_PERSON_LINES" | "PRORATED_ESTIMATE" | "NO_ONE_ATTENDED";

export type RegistrationResult = {
  registrationId: string;
  confirmationCode: string;
  label: string;
  clubId: string | null;
  locationId: string | null;
  locationName: string | null;
  status: ClubRegistrationStatus;
  counts: Counts;
  estimatedCents: number;
  billableCents: number;
  basis: AmountBasis;
  components: {
    personChargesCents: number;
    registrationChargeCents: number;
    creditCents: number;
    adjustmentCents: number;
  };
  credits: Array<{ label: string; units: number | null; appliedCents: number }>;
  people: PersonResult[];
};

export type GroupResult = {
  key: string;
  title: string;
  partyKind: GroupSource["partyKind"];
  partyId: string | null;
  partyName: string;
  clubId: string | null;
  counts: Counts;
  estimatedCents: number;
  billableCents: number;
  registrations: RegistrationResult[];
};

export type ReconciliationTotals = Counts & { estimatedCents: number; billableCents: number };

export type ReconciliationResult = {
  ruleVersion: string;
  invoiceGrouping: "PER_CHURCH" | "PER_CLUB";
  groups: GroupResult[];
  totals: ReconciliationTotals;
};

export function emptyCounts(): Counts {
  return { registered: 0, checkedIn: 0, noShow: 0, addedByStaff: 0, removedByStaff: 0, billable: 0 };
}

export function addCounts(left: Counts, right: Counts): Counts {
  return {
    registered: left.registered + right.registered,
    checkedIn: left.checkedIn + right.checkedIn,
    noShow: left.noShow + right.noShow,
    addedByStaff: left.addedByStaff + right.addedByStaff,
    removedByStaff: left.removedByStaff + right.removedByStaff,
    billable: left.billable + right.billable,
  };
}

/** Whether a person counts as attended: the staff correction if there is one, otherwise the check-in record. */
export function isAttended(person: Pick<PersonSource, "checkedIn" | "correction">) {
  return person.correction ? person.correction.kind === "MARK_ATTENDED" : person.checkedIn;
}

export function personState(person: Pick<PersonSource, "checkedIn" | "correction">): PersonState {
  const attended = isAttended(person);
  if (person.checkedIn && attended) return "CHECKED_IN";
  if (!person.checkedIn && !attended) return "NO_SHOW";
  return attended ? "ADDED_BY_STAFF" : "REMOVED_BY_STAFF";
}

function sum(values: readonly number[]) {
  return values.reduce((total, value) => total + value, 0);
}

/**
 * One registration's reconciliation. The amount is the #409 rules applied to the people who
 * attended:
 *  - each attended person's own price lines (the per-person rate, late price included);
 *  - registration-level charges (for example a flat or late fee for the whole registration) are not
 *    per person, so they are kept whole, once, as long as anyone attended, and $0 when nobody did;
 *  - the meal-sponsorship credit is units times the form's credit per unit, capped at the people who
 *    attended (the estimate caps it at the people registered), and never more than the charges;
 *  - staff adjustments (scholarship, discount) for the registration, and those for an attended person.
 * A registration with no recorded price lines (entered by staff) has no per-person figures, so its
 * estimate is prorated by attended over registered, and it is labelled so.
 */
export function reconcileRegistration(source: RegistrationSource): RegistrationResult {
  const people: PersonResult[] = source.people.map((person) => {
    const state = personState(person);
    return {
      attendeeId: person.attendeeId,
      name: person.name,
      state,
      checkedIn: person.checkedIn,
      billable: isAttended(person),
      chargeCents: person.chargeCents,
      correction: person.correction,
      addedAfterSubmission: person.addedAfterSubmission,
      substituted: person.substituted,
      lateRate: person.lateRate,
    };
  });
  const attendedSources = source.people.filter(isAttended);
  const counts: Counts = {
    registered: people.length,
    checkedIn: people.filter((person) => person.checkedIn).length,
    noShow: people.filter((person) => !person.checkedIn).length,
    addedByStaff: people.filter((person) => person.state === "ADDED_BY_STAFF").length,
    removedByStaff: people.filter((person) => person.state === "REMOVED_BY_STAFF").length,
    billable: attendedSources.length,
  };

  let basis: AmountBasis;
  let billableCents = 0;
  const components = { personChargesCents: 0, registrationChargeCents: 0, creditCents: 0, adjustmentCents: 0 };
  const credits: RegistrationResult["credits"] = [];
  if (counts.billable === 0) {
    basis = "NO_ONE_ATTENDED";
  } else if (!source.hasPriceLines) {
    basis = "PRORATED_ESTIMATE";
    billableCents = counts.registered === 0 ? 0 : Math.floor((Math.max(source.estimatedCents, 0) * counts.billable) / counts.registered);
    components.personChargesCents = billableCents;
  } else {
    basis = "PER_PERSON_LINES";
    components.personChargesCents = sum(attendedSources.map((person) => person.chargeCents));
    components.registrationChargeCents = Math.max(source.registrationChargeCents, 0);
    const gross = components.personChargesCents + components.registrationChargeCents;
    let creditTotal = 0;
    for (const credit of source.credits) {
      const known = credit.centsPerUnit !== null && credit.rawUnits !== null;
      const units = known
        ? credit.capAtHeadcount ? Math.min(credit.rawUnits as number, counts.billable) : credit.rawUnits as number
        : null;
      const cents = known ? (units as number) * (credit.centsPerUnit as number) : Math.min(credit.recordedCents, 0);
      creditTotal += cents;
      credits.push({ label: credit.label, units, appliedCents: cents });
    }
    // A credit can bring the charges to $0, never below it.
    components.creditCents = Math.max(creditTotal, -gross);
    components.adjustmentCents = source.registrationAdjustmentCents + sum(attendedSources.map((person) => person.adjustmentCents));
    billableCents = Math.max(0, gross + components.creditCents + components.adjustmentCents);
  }
  return {
    registrationId: source.registrationId,
    confirmationCode: source.confirmationCode,
    label: source.label,
    clubId: source.clubId,
    locationId: source.locationId,
    locationName: source.locationName,
    status: source.status,
    counts,
    estimatedCents: Math.max(source.estimatedCents, 0),
    billableCents,
    basis,
    components,
    credits,
    people,
  };
}

export function summarizeRegistrations(registrations: readonly RegistrationResult[]): ReconciliationTotals {
  return {
    ...registrations.reduce((total, registration) => addCounts(total, registration.counts), emptyCounts()),
    estimatedCents: sum(registrations.map((registration) => registration.estimatedCents)),
    billableCents: sum(registrations.map((registration) => registration.billableCents)),
  };
}

function groupResult(group: GroupSource, registrations: RegistrationResult[]): GroupResult {
  const totals = summarizeRegistrations(registrations);
  const { estimatedCents, billableCents, ...counts } = totals;
  return {
    key: group.key,
    title: group.title,
    partyKind: group.partyKind,
    partyId: group.partyId,
    partyName: group.partyName,
    clubId: group.clubId,
    counts,
    estimatedCents,
    billableCents,
    registrations,
  };
}

/** Reconciles every registration of every invoice group; group order and registration order are kept. */
export function reconcileEvent(groups: readonly GroupSource[], invoiceGrouping: ReconciliationResult["invoiceGrouping"]): ReconciliationResult {
  const results = groups
    .map((group) => groupResult(group, group.registrations.map(reconcileRegistration)))
    .filter((group) => group.registrations.length > 0);
  return {
    ruleVersion: RECONCILIATION_RULE_VERSION,
    invoiceGrouping,
    groups: results,
    totals: summarizeRegistrations(results.flatMap((group) => group.registrations)),
  };
}

/** The location filter (#413) for a view: only the registrations at that site, with group and event figures recomputed. */
export function filterResultByLocation(result: ReconciliationResult, locationId: string | null): ReconciliationResult {
  if (!locationId) return result;
  const groups = result.groups
    .map((group) => {
      const registrations = group.registrations.filter((registration) => registration.locationId === locationId);
      const totals = summarizeRegistrations(registrations);
      const { estimatedCents, billableCents, ...counts } = totals;
      return { ...group, counts, estimatedCents, billableCents, registrations };
    })
    .filter((group) => group.registrations.length > 0);
  return { ...result, groups, totals: summarizeRegistrations(groups.flatMap((group) => group.registrations)) };
}

// ---------------------------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------------------------

/** Keys that describe when or by whom, not what the facts are: left out of the fingerprint. */
const FINGERPRINT_IGNORED_KEYS = new Set(["actorName", "createdAt"]);

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([key, entry]) => !FINGERPRINT_IGNORED_KEYS.has(key) && entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The text a fingerprint hashes: every source fact and the rule version, nothing about time or actors. */
export function fingerprintInput(result: ReconciliationResult) {
  return stableStringify(result);
}

// ---------------------------------------------------------------------------------------------
// Responsibility gate (#165)
// ---------------------------------------------------------------------------------------------

export type ResponsibilityLine = {
  registrationId: string;
  confirmationCode: string;
  label: string;
  status: ClubRegistrationStatus;
  recorded: boolean;
  outdated: boolean;
  unresolved: boolean;
};

export type ResponsibilityBlocker = {
  registrationId: string;
  confirmationCode: string;
  label: string;
  reason: "UNRECORDED" | "OUTDATED" | "UNRESOLVED";
};

export function blockerReasonLabel(reason: ResponsibilityBlocker["reason"]) {
  if (reason === "UNRECORDED") return "Responsible party not recorded yet";
  if (reason === "OUTDATED") return "Recorded responsible party is out of date";
  return "No responsible organization yet";
}

/**
 * Registrations that block preparing or approving: invoices use the RECORDED responsible party
 * (#165), so any billed registration that is unrecorded, out of date or unresolved must be settled
 * first. Registrations that owe nothing (waitlisted, cancelled) never block.
 */
export function responsibilityBlockers(lines: readonly ResponsibilityLine[]): ResponsibilityBlocker[] {
  const blockers: ResponsibilityBlocker[] = [];
  for (const line of lines) {
    if (!IN_SCOPE_STATUSES.includes(line.status)) continue;
    const reason = line.unresolved ? "UNRESOLVED" : !line.recorded ? "UNRECORDED" : line.outdated ? "OUTDATED" : null;
    if (reason) blockers.push({ registrationId: line.registrationId, confirmationCode: line.confirmationCode, label: line.label, reason });
  }
  return blockers;
}

// ---------------------------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------------------------

export type CorrectionPlanError = "NO_CHANGE" | "NOTHING_TO_CLEAR";

/**
 * Whether a correction would change anything. A correction that leaves the person's status as it is
 * is refused, so every correction on the record means something and shows in the reconciliation.
 */
export function planCorrection(
  person: Pick<PersonSource, "checkedIn" | "correction">,
  kind: CorrectionKind,
): { ok: true } | { ok: false; error: CorrectionPlanError } {
  if (kind === "CLEAR") return person.correction ? { ok: true } : { ok: false, error: "NOTHING_TO_CLEAR" };
  const attended = isAttended(person);
  if (kind === "MARK_ATTENDED" && attended) return { ok: false, error: "NO_CHANGE" };
  if (kind === "MARK_NOT_ATTENDED" && !attended) return { ok: false, error: "NO_CHANGE" };
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------------------------

export type VersionStatus = "DRAFT" | "APPROVED" | "SUPERSEDED";

/**
 * How a stored version compares with the facts now. An approved version never changes; this only
 * says whether it still matches.
 */
export function versionFreshness(version: { status: VersionStatus; fingerprint: string }, currentFingerprint: string | null) {
  if (version.status === "SUPERSEDED") return "SUPERSEDED" as const;
  if (currentFingerprint === null) return "UNKNOWN" as const;
  return version.fingerprint === currentFingerprint ? "CURRENT" as const : "FACTS_CHANGED" as const;
}

export function basisLabel(basis: AmountBasis) {
  if (basis === "PRORATED_ESTIMATE") return "Prorated from the estimate (no price lines on file)";
  if (basis === "NO_ONE_ATTENDED") return "Nobody attended";
  return "Attended people's recorded prices";
}

// ---------------------------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------------------------

/**
 * One row per registration with its invoice group and the counts side by side. No attendee names:
 * the people drilldown stays on the screen. Values go through the shared formula-safe CSV writer.
 */
export function reconciliationCsvRows(
  result: ReconciliationResult,
  meta: { versionLabel: string; factsChanged: boolean | null },
) {
  const money = (cents: number) => (cents / 100).toFixed(2);
  const table: Array<Array<string | number>> = [[
    "Invoice group",
    "Responsible party",
    "Grouping",
    "Club or registrant",
    "Confirmation code",
    "Location",
    "Registered",
    "Checked in",
    "No-show",
    "Added by staff",
    "Removed by staff",
    "Billable",
    "Estimated (registered)",
    "Billable amount",
    "Group billable amount",
    "How the amount was worked out",
    "Version",
    "Facts changed since approval",
  ]];
  for (const group of result.groups) {
    for (const registration of group.registrations) {
      table.push([
        group.title,
        group.partyName,
        result.invoiceGrouping === "PER_CLUB" ? "One invoice per club" : "One invoice per church",
        registration.label,
        registration.confirmationCode,
        registration.locationName ?? "",
        registration.counts.registered,
        registration.counts.checkedIn,
        registration.counts.noShow,
        registration.counts.addedByStaff,
        registration.counts.removedByStaff,
        registration.counts.billable,
        money(registration.estimatedCents),
        money(registration.billableCents),
        money(group.billableCents),
        basisLabel(registration.basis),
        meta.versionLabel,
        meta.factsChanged === null ? "" : meta.factsChanged ? "Yes" : "No",
      ]);
    }
  }
  return table;
}
