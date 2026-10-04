/**
 * Billing responsibility for deferred-invoice events (#165, slice 1). Pure rules, free of
 * database access, so the finance screen, its CSV export, the resolver and the tests all agree.
 *
 * Who is financially responsible is decided by an explicit rule or by staff, never inferred:
 *  - a club registration -> the club's sponsoring church (`parentOrganizationId`); a club with no
 *    church is UNRESOLVED, never guessed;
 *  - a group registration (#650) -> its billing person;
 *  - anything else -> UNRESOLVED until staff link it to an organization. A free-text answer (a
 *    church name typed on a form) is shown as a hint only and is never linked automatically.
 * A staff decision (STAFF_LINKED / STAFF_OVERRIDE) always outranks a rule and survives
 * re-resolution. This slice computes a grouping preview only; it never finalizes an amount
 * (#166/#167).
 */

import { churchOwedCents, isChurchBilledStatus, type ClubRegistrationStatus } from "@/modules/club-registrations/church-owed";

export type BillingResponsibleKind = "ORGANIZATION" | "PERSON" | "UNRESOLVED";

export type BillingResponsibilitySource =
  | "CLUB_SPONSORING_CHURCH"
  | "GROUP_BILLING_PERSON"
  | "UNRESOLVED_CLUB_HAS_NO_CHURCH"
  | "UNRESOLVED_NO_ORGANIZATION_LINKED"
  | "STAFF_LINKED"
  | "STAFF_OVERRIDE";

export type InvoiceGroupingMode = "PER_CHURCH" | "PER_CLUB";

export const INVOICE_GROUPINGS: readonly InvoiceGroupingMode[] = ["PER_CHURCH", "PER_CLUB"];

/** Organization types staff may name as the responsible party (churches, schools, clubs, ministries). */
export const RESPONSIBLE_ORGANIZATION_TYPES = [
  "CHURCH",
  "SCHOOL",
  "EARLY_CHILDHOOD",
  "CLUB",
  "CAMP",
  "CONFERENCE",
  "ASSOCIATION",
] as const;

/** Registrations in these statuses are in scope; a draft was never submitted. */
export const BILLING_RESPONSIBILITY_STATUSES = ["SUBMITTED", "CONFIRMED", "WAITLISTED", "CANCELLED"] as const;

export type Resolution = {
  kind: BillingResponsibleKind;
  organizationId: string | null;
  personId: string | null;
  source: BillingResponsibilitySource;
};

export function isStaffDecision(source: BillingResponsibilitySource) {
  return source === "STAFF_LINKED" || source === "STAFF_OVERRIDE";
}

export type ResolutionFacts = {
  /** Present when the registration is a club registration. */
  club: { organizationId: string; parentOrganizationId: string | null } | null;
  /** Present when the registration is a group registration (#650). */
  groupBillingPersonId: string | null;
};

/** The rule-derived responsible party. Never looks at free text, email, or the submitter. */
export function resolveByRule(facts: ResolutionFacts): Resolution {
  if (facts.club) {
    return facts.club.parentOrganizationId
      ? { kind: "ORGANIZATION", organizationId: facts.club.parentOrganizationId, personId: null, source: "CLUB_SPONSORING_CHURCH" }
      : { kind: "UNRESOLVED", organizationId: null, personId: null, source: "UNRESOLVED_CLUB_HAS_NO_CHURCH" };
  }
  if (facts.groupBillingPersonId) {
    return { kind: "PERSON", organizationId: null, personId: facts.groupBillingPersonId, source: "GROUP_BILLING_PERSON" };
  }
  return { kind: "UNRESOLVED", organizationId: null, personId: null, source: "UNRESOLVED_NO_ORGANIZATION_LINKED" };
}

export type StoredResolution = Resolution;

export type ResolutionOutcome =
  | { action: "CREATE"; next: Resolution }
  | { action: "UPDATE"; next: Resolution }
  | { action: "KEEP_STAFF_DECISION" }
  | { action: "UNCHANGED" };

function sameResolution(left: Resolution, right: Resolution) {
  return left.kind === right.kind
    && left.organizationId === right.organizationId
    && left.personId === right.personId
    && left.source === right.source;
}

/**
 * What the resolver does for one registration. Idempotent: applying `next` and planning again
 * gives UNCHANGED, and a staff decision is never replaced.
 */
export function planResolution(existing: StoredResolution | null, rule: Resolution): ResolutionOutcome {
  if (!existing) return { action: "CREATE", next: rule };
  if (isStaffDecision(existing.source)) return { action: "KEEP_STAFF_DECISION" };
  if (sameResolution(existing, rule)) return { action: "UNCHANGED" };
  return { action: "UPDATE", next: rule };
}

/** The source a staff choice is recorded as: a link when the rules found no party, otherwise an override. */
export function staffSourceFor(rule: Resolution): "STAFF_LINKED" | "STAFF_OVERRIDE" {
  return rule.kind === "UNRESOLVED" ? "STAFF_LINKED" : "STAFF_OVERRIDE";
}

export function unresolvedReasonLabel(source: BillingResponsibilitySource) {
  if (source === "UNRESOLVED_CLUB_HAS_NO_CHURCH") return "The club has no sponsoring church on file";
  if (source === "UNRESOLVED_NO_ORGANIZATION_LINKED") return "Not linked to an organization yet";
  return "Unresolved";
}

export function sourceLabel(source: BillingResponsibilitySource) {
  switch (source) {
    case "CLUB_SPONSORING_CHURCH": return "Club's sponsoring church";
    case "GROUP_BILLING_PERSON": return "Group's billing contact";
    case "STAFF_LINKED": return "Linked by staff";
    case "STAFF_OVERRIDE": return "Overridden by staff";
    default: return unresolvedReasonLabel(source);
  }
}

// ---------------------------------------------------------------------------------------------
// Billing contact readiness
// ---------------------------------------------------------------------------------------------

export type BillingContactView = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  roleLabel: string;
  effectiveFrom: string;
  verifiedAt: string | null;
};

export type ContactReadiness = "READY" | "NO_CONTACT" | "NOT_VERIFIED" | "UNRESOLVED";

export const READINESS_LABELS: Record<ContactReadiness, string> = {
  READY: "Ready",
  NO_CONTACT: "No billing contact",
  NOT_VERIFIED: "Contact not verified",
  UNRESOLVED: "Unresolved",
};

/** An organization is Ready only with an active, verified billing contact. */
export function organizationReadiness(contact: Pick<BillingContactView, "verifiedAt"> | null): ContactReadiness {
  if (!contact) return "NO_CONTACT";
  return contact.verifiedAt ? "READY" : "NOT_VERIFIED";
}

/** A group's billing person is their own contact: Ready when they left an email, otherwise no contact. */
export function personReadiness(email: string | null): ContactReadiness {
  return email ? "READY" : "NO_CONTACT";
}

// ---------------------------------------------------------------------------------------------
// Grouping preview
// ---------------------------------------------------------------------------------------------

export type ResponsibleParty =
  | { kind: "ORGANIZATION"; id: string; name: string }
  | { kind: "PERSON"; id: string; name: string; email: string | null }
  | { kind: "UNRESOLVED" };

export type BillingLine = {
  registrationId: string;
  confirmationCode: string;
  status: ClubRegistrationStatus;
  attendeeCount: number;
  /** The registration's estimated total in cents (the pricing engine's figure, #409). */
  totalAmountCents: number;
  locationName: string | null;
  /** The club this registration belongs to; null for individual and group registrations. */
  clubId: string | null;
  clubName: string | null;
  /** Registrant name for a registration with no club, shown as the line label. */
  registrantName: string;
  party: ResponsibleParty;
  source: BillingResponsibilitySource;
  /** Staff's reason for an override or link. */
  reason: string | null;
  /** False while the resolver has not recorded this registration yet (it is shown as a proposal). */
  recorded: boolean;
  /** A free-text organization answer, shown as a hint for staff only; never linked automatically. */
  hint: string | null;
};

export type BillingGroup = {
  key: string;
  party: ResponsibleParty;
  /** The label a grouped invoice would carry: the church, the person, or the club under per-club grouping. */
  title: string;
  clubId: string | null;
  readiness: ContactReadiness;
  contact: BillingContactView | null;
  lines: Array<BillingLine & { owedCents: number; isBilled: boolean }>;
  billedCount: number;
  owedCents: number;
};

export function lineLabel(line: Pick<BillingLine, "clubName" | "registrantName">) {
  return line.clubName ?? line.registrantName;
}

function partyKey(party: ResponsibleParty) {
  return party.kind === "UNRESOLVED" ? "unresolved" : `${party.kind.toLowerCase()}:${party.id}`;
}

/**
 * Groups registrations into the invoice groups the event's setting would produce.
 *  - PER_CHURCH (default): everything billed to one responsible party shares a group, each
 *    registration (club) its own line, so several clubs of one church share a church group.
 *  - PER_CLUB: each club registration stands alone; non-club registrations still share by party.
 * Unresolved registrations are always one list, never an invoice group. Amounts are the existing
 * #409 owed amounts: active registrations only, $0 for waitlisted and cancelled ones.
 */
export function groupBillingLines(
  lines: readonly BillingLine[],
  grouping: InvoiceGroupingMode,
  contactsByOrganizationId: ReadonlyMap<string, BillingContactView>,
): BillingGroup[] {
  const groups = new Map<string, BillingGroup>();
  for (const line of lines) {
    const perClub = grouping === "PER_CLUB" && line.clubId !== null && line.party.kind !== "UNRESOLVED";
    const key = perClub ? `${partyKey(line.party)}|club:${line.clubId}` : partyKey(line.party);
    let group = groups.get(key);
    if (!group) {
      const contact = line.party.kind === "ORGANIZATION" ? contactsByOrganizationId.get(line.party.id) ?? null : null;
      group = {
        key,
        party: line.party,
        title: perClub ? (line.clubName ?? "Club") : partyName(line.party),
        clubId: perClub ? line.clubId : null,
        readiness: line.party.kind === "ORGANIZATION"
          ? organizationReadiness(contact)
          : line.party.kind === "PERSON" ? personReadiness(line.party.email) : "UNRESOLVED",
        contact,
        lines: [],
        billedCount: 0,
        owedCents: 0,
      };
      groups.set(key, group);
    }
    const owedCents = churchOwedCents(line.status, line.totalAmountCents);
    const isBilled = isChurchBilledStatus(line.status);
    group.lines.push({ ...line, owedCents, isBilled });
    if (isBilled) group.billedCount += 1;
    group.owedCents += owedCents;
  }
  const rank = (group: BillingGroup) => (group.party.kind === "UNRESOLVED" ? 2 : group.party.kind === "PERSON" ? 1 : 0);
  const sorted = [...groups.values()].sort((left, right) =>
    rank(left) - rank(right) || left.title.localeCompare(right.title) || left.key.localeCompare(right.key));
  for (const group of sorted) {
    group.lines.sort((left, right) => lineLabel(left).localeCompare(lineLabel(right)) || left.confirmationCode.localeCompare(right.confirmationCode));
  }
  return sorted;
}

export function partyName(party: ResponsibleParty) {
  return party.kind === "UNRESOLVED" ? "Unresolved" : party.name;
}

export function partyKindLabel(party: ResponsibleParty) {
  return party.kind === "ORGANIZATION" ? "Organization" : party.kind === "PERSON" ? "Person" : "Unresolved";
}

// ---------------------------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------------------------

/**
 * One row per registration line with its group, responsible party, contact readiness and the
 * billing contact's name and email (staff finance export only; the phone is left out).
 */
export function billingResponsibilityCsvRows(groups: readonly BillingGroup[], grouping: InvoiceGroupingMode) {
  const money = (cents: number) => (cents / 100).toFixed(2);
  const table: Array<Array<string | number>> = [[
    "Invoice group",
    "Responsible party",
    "Party type",
    "Grouping",
    "Contact readiness",
    "Billing contact",
    "Billing contact role",
    "Billing contact email",
    "Club or registrant",
    "Confirmation code",
    "Status",
    "Attendees",
    "Estimated (registered)",
    "Group estimated total (registered)",
    "How decided",
    "Hint (free-text answer, not linked)",
  ]];
  for (const group of groups) {
    for (const line of group.lines) {
      table.push([
        group.party.kind === "UNRESOLVED" ? "Unresolved" : group.title,
        partyName(group.party),
        partyKindLabel(group.party),
        grouping === "PER_CLUB" ? "One invoice per club" : "One invoice per church",
        READINESS_LABELS[group.readiness],
        group.contact?.name ?? (group.party.kind === "PERSON" ? group.party.name : ""),
        group.contact?.roleLabel ?? "",
        group.contact?.email ?? (group.party.kind === "PERSON" ? group.party.email ?? "" : ""),
        lineLabel(line),
        line.confirmationCode,
        line.status,
        line.attendeeCount,
        money(line.owedCents),
        group.party.kind === "UNRESOLVED" ? "" : money(group.owedCents),
        sourceLabel(line.source),
        line.hint ?? "",
      ]);
    }
  }
  return table;
}

/** Headline figures for the screen. */
export function summarizeBillingGroups(groups: readonly BillingGroup[]) {
  const resolved = groups.filter((group) => group.party.kind !== "UNRESOLVED");
  const unresolved = groups.find((group) => group.party.kind === "UNRESOLVED");
  return {
    groupCount: resolved.length,
    readyCount: resolved.filter((group) => group.readiness === "READY").length,
    needsContactCount: resolved.filter((group) => group.readiness !== "READY").length,
    unresolvedCount: unresolved?.lines.length ?? 0,
    totalOwedCents: groups.reduce((sum, group) => sum + group.owedCents, 0),
  };
}
