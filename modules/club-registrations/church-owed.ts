/**
 * What a church owes for a club registration on a church-billed
 * (DEFERRED_ORGANIZATION_INVOICE) event (#409). Pure, so the staff finance
 * screen, its CSV export, and the director pages all agree on one rule.
 *
 * The amount is the pricing engine's estimate (`Registration.totalAmount`):
 * the church is billed after the event, never charged online. Only an active
 * registration (submitted or confirmed) is billed; a waitlisted or cancelled
 * club owes nothing while it stays that way.
 */

import { resolveResponsibleOrganization } from "@/modules/forms/definition";

export type ClubRegistrationStatus = "DRAFT" | "SUBMITTED" | "CONFIRMED" | "WAITLISTED" | "CANCELLED";

export const CHURCH_BILLED_STATUSES: readonly ClubRegistrationStatus[] = ["SUBMITTED", "CONFIRMED"];

export const NO_CHURCH_ON_FILE = "No sponsoring church on file";

export function isChurchBilledStatus(status: ClubRegistrationStatus) {
  return CHURCH_BILLED_STATUSES.includes(status);
}

/** The estimated amount the church owes: the priced total while active, otherwise $0. */
export function churchOwedCents(status: ClubRegistrationStatus, pricedTotalCents: number) {
  return isChurchBilledStatus(status) ? Math.max(pricedTotalCents, 0) : 0;
}

/** Why an inactive registration owes nothing, in words a director or finance reader can act on. */
export function notBilledLabel(status: ClubRegistrationStatus) {
  if (status === "WAITLISTED") return "No amount owed while waitlisted";
  if (status === "CANCELLED") return "Cancelled — nothing owed";
  return "Not submitted — nothing owed";
}

/**
 * A church-sponsored promo code line (#545), structurally the same as
 * `ChurchSponsoredPromoLine` in the promo-codes module (which imports this
 * file, so the shape is repeated here to avoid an import cycle). Callers pass
 * lines already filtered to billed ones and ordered.
 */
export type SponsoredCsvLine = {
  lineId?: string;
  churchId: string;
  churchName: string;
  promoCode: string;
  confirmationCode: string;
  status: ClubRegistrationStatus;
  amountCents: number;
};

export const SPONSORED_PROMO_NOTE = "Church-sponsored promo code; billed to the church after the event, not paid online";

export type ChurchAmountOwedRow = {
  /**
   * "INDIVIDUAL" for a registration on a church-billed event that has no club registration (#606: Leadership
   * Weekend, Outdoor School). Its organization is the answer the form names (`resolveResponsibleOrganization`),
   * `organizationName` is the registrant, and `churchId` is a key made from the organization's name. Absent for clubs.
   */
  kind?: "INDIVIDUAL" | "GROUP";
  organizationId: string;
  organizationName: string;
  churchId: string | null;
  churchName: string | null;
  confirmationCode: string;
  status: ClubRegistrationStatus;
  attendeeCount: number;
  /** True only for a submitted or confirmed registration. */
  isBilled: boolean;
  /** Estimated amount owed by the church; $0 unless `isBilled`. */
  amountOwedCents: number;
  /** The event location the club registered at (#413); absent when the event has none. */
  locationName?: string | null;
  /** The team's name (#809), only on an event that lets a club register several; each team is its own billed row. */
  teamName?: string;
  /**
   * A "Group" registration (#650) has no club or church; its contact is the billing party. Present only on
   * `kind: "GROUP"` rows, where `organizationName` is the contact's name and `churchId` is `GROUP_KEY`.
   */
  billingContact?: { name: string; email: string | null };
};

export type ChurchSubtotal = {
  churchKey: string;
  churchName: string;
  clubCount: number;
  amountOwedCents: number;
};

/** A registration that is not a club's, with what the church-owed report needs from it (#606). */
export type IndividualOwedSource = {
  id: string;
  confirmationCode: string;
  status: ClubRegistrationStatus;
  totalAmountCents: number;
  attendeeCount: number;
  registrantName: string;
  /** The registration-level answers, read only for the responsible organization. */
  responses: Record<string, unknown>;
  locationName?: string | null;
};

/** One report key per organization, whatever the capitalization or spacing the registrant typed. */
export function organizationKey(name: string) {
  return `named:${name.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US")}`;
}

/**
 * Report rows for the registrations of a church-billed event that has no club registrations (#606),
 * grouped by the organization the form names: the church for Leadership Weekend (a "Not listed" church
 * uses the text typed beside it), the school for Outdoor School. Same statuses and amounts as club rows.
 */
export function individualOwedRows(sources: readonly IndividualOwedSource[]): ChurchAmountOwedRow[] {
  return sources.map((source) => {
    const organization = resolveResponsibleOrganization(source.responses);
    return {
      kind: "INDIVIDUAL" as const,
      organizationId: source.id,
      organizationName: source.registrantName,
      churchId: organization ? organizationKey(organization) : null,
      churchName: organization,
      confirmationCode: source.confirmationCode,
      status: source.status,
      attendeeCount: source.attendeeCount,
      isBilled: isChurchBilledStatus(source.status),
      amountOwedCents: churchOwedCents(source.status, source.totalAmountCents),
      ...(source.locationName ? { locationName: source.locationName } : {}),
    };
  });
}

/** The report key for every "Group" registration (#650): they share one bucket, billed to their own contacts, not to a church. */
export const GROUP_KEY = "groups";

export const GROUP_BUCKET_LABEL = "Groups (billed to their contact)";

/** A "Group" registration, with what the owed report needs from it (#650). */
export type GroupOwedSource = {
  confirmationCode: string;
  registrationId: string;
  status: ClubRegistrationStatus;
  totalAmountCents: number;
  attendeeCount: number;
  contactName: string;
  contactEmail: string | null;
  locationName?: string | null;
};

/**
 * Report rows for "Group" registrations (#650). Same statuses and amounts as club rows, but the billing party
 * is the registration's contact, recorded beside the row, and the row never names a club or a church.
 */
export function groupOwedRows(sources: readonly GroupOwedSource[]): ChurchAmountOwedRow[] {
  return sources.map((source) => ({
    kind: "GROUP" as const,
    organizationId: source.registrationId,
    organizationName: source.contactName,
    churchId: GROUP_KEY,
    churchName: GROUP_BUCKET_LABEL,
    confirmationCode: source.confirmationCode,
    status: source.status,
    attendeeCount: source.attendeeCount,
    isBilled: isChurchBilledStatus(source.status),
    amountOwedCents: churchOwedCents(source.status, source.totalAmountCents),
    billingContact: { name: source.contactName, email: source.contactEmail },
    ...(source.locationName ? { locationName: source.locationName } : {}),
  }));
}

export function sortChurchAmountsOwed(rows: ChurchAmountOwedRow[]) {
  return [...rows].sort((left, right) => {
    // Billed clubs first, then waitlisted and cancelled ones.
    if (left.isBilled !== right.isBilled) return left.isBilled ? -1 : 1;
    // Clubs with no church on file sort after every named church, and groups (#650) after those.
    const rank = (row: ChurchAmountOwedRow) => (row.churchId === GROUP_KEY ? 2 : row.churchName === null ? 1 : 0);
    if (rank(left) !== rank(right)) return rank(left) - rank(right);
    return (left.churchName ?? "").localeCompare(right.churchName ?? "")
      || left.organizationName.localeCompare(right.organizationName)
      || (left.teamName ?? "").localeCompare(right.teamName ?? "");
  });
}

/** Headline figures and a per-church subtotal, counting billed clubs only. */
export function summarizeChurchAmountsOwed(rows: ChurchAmountOwedRow[]) {
  const billed = rows.filter((row) => row.isBilled);
  const subtotals = new Map<string, ChurchSubtotal>();
  for (const row of billed) {
    const churchKey = row.churchId ?? "none";
    const current = subtotals.get(churchKey) ?? {
      churchKey,
      churchName: row.churchName ?? NO_CHURCH_ON_FILE,
      clubCount: 0,
      amountOwedCents: 0,
    };
    current.clubCount += 1;
    current.amountOwedCents += row.amountOwedCents;
    subtotals.set(churchKey, current);
  }
  // Groups (#650) are listed last, after clubs with no church on file: they are billed to a contact, not a church.
  const bucketRank = (key: string) => (key === GROUP_KEY ? 2 : key === "none" ? 1 : 0);
  const churches = [...subtotals.values()].sort((left, right) => {
    if (bucketRank(left.churchKey) !== bucketRank(right.churchKey)) return bucketRank(left.churchKey) - bucketRank(right.churchKey);
    return left.churchName.localeCompare(right.churchName);
  });
  return {
    billedClubCount: billed.length,
    churchCount: churches.filter((church) => church.churchKey !== "none" && church.churchKey !== GROUP_KEY).length,
    notBilledCount: rows.length - billed.length,
    totalOwedCents: billed.reduce((sum, row) => sum + row.amountOwedCents, 0),
    churches,
  };
}

/**
 * CSV rows: one per club with its church and that church's subtotal, so the
 * file sorts and filters cleanly. Church-sponsored promo code lines (#545)
 * follow, one per redeemed registration, and count toward the church total.
 */
export function churchAmountsOwedCsvRows(
  rows: ChurchAmountOwedRow[],
  sponsoredLines: readonly SponsoredCsvLine[] = [],
) {
  const summary = summarizeChurchAmountsOwed(rows);
  const subtotalByChurch = new Map(summary.churches.map((church) => [church.churchKey, church.amountOwedCents]));
  for (const line of sponsoredLines) {
    subtotalByChurch.set(line.churchId, (subtotalByChurch.get(line.churchId) ?? 0) + line.amountCents);
  }
  const money = (cents: number) => (cents / 100).toFixed(2);
  // Organization columns (#606) are relabeled only when some row is an individual registration, so a club event exports what it always did.
  const hasIndividuals = rows.some((row) => row.kind === "INDIVIDUAL");
  // "Group" rows (#650) add the billing contact, and relabel the columns that would otherwise say "church".
  const hasGroups = rows.some((row) => row.kind === "GROUP");
  const relabeled = hasIndividuals || hasGroups;
  // A Team column (#809), only when some club registered one, so an event without teams exports the columns it always did.
  const hasTeams = rows.some((row) => row.teamName);
  const table: Array<Array<string | number>> = [[
    hasGroups ? "Church, organization or group" : hasIndividuals ? "Church or organization" : "Church",
    relabeled ? "Club or registrant" : "Club",
    ...(hasTeams ? ["Team"] : []),
    "Confirmation code",
    "Status",
    hasGroups ? "Billed after the event" : "Billed to church",
    "Attendees",
    "Estimated amount owed",
    hasGroups ? "Church or group estimated total" : "Church estimated total",
    "Note",
    ...(hasGroups ? ["Billing contact", "Billing contact email"] : []),
  ]];
  const sortedRows = sortChurchAmountsOwed(rows);
  for (const row of sortedRows) {
    table.push([
      row.churchName ?? NO_CHURCH_ON_FILE,
      row.organizationName,
      ...(hasTeams ? [row.teamName ?? ""] : []),
      row.confirmationCode,
      row.status,
      row.isBilled ? "Yes" : "No",
      row.attendeeCount,
      money(row.amountOwedCents),
      // A group is billed on its own, so its cell is its own amount, never a sum across groups.
      row.isBilled ? money(row.kind === "GROUP" ? row.amountOwedCents : subtotalByChurch.get(row.churchId ?? "none") ?? 0) : "",
      row.isBilled
        ? row.kind === "GROUP" ? "Billed to the group's contact after the event, not paid online" : "Billed to the church after the event, not paid online"
        : notBilledLabel(row.status),
      ...(hasGroups ? [row.billingContact?.name ?? "", row.billingContact?.email ?? ""] : []),
    ]);
  }
  for (const line of sponsoredLines) {
    table.push([
      line.churchName,
      `Promo code ${line.promoCode}`,
      ...(hasTeams ? [""] : []),
      line.confirmationCode,
      line.status,
      "Yes",
      "",
      money(line.amountCents),
      money(subtotalByChurch.get(line.churchId) ?? 0),
      SPONSORED_PROMO_NOTE,
      ...(hasGroups ? ["", ""] : []),
    ]);
  }
  // A Location column (#413), only when some club registered at one, so an
  // event without locations exports the columns it always did.
  if (!sortedRows.some((row) => row.locationName)) return table;
  return table.map((row, position) => [
    ...row.slice(0, 2),
    position === 0 ? "Location" : sortedRows[position - 1]?.locationName ?? "",
    ...row.slice(2),
  ]);
}
