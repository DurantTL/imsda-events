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
  kind?: "INDIVIDUAL";
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

export function sortChurchAmountsOwed(rows: ChurchAmountOwedRow[]) {
  return [...rows].sort((left, right) => {
    // Billed clubs first, then waitlisted and cancelled ones.
    if (left.isBilled !== right.isBilled) return left.isBilled ? -1 : 1;
    // Clubs with no church on file sort after every named church.
    if ((left.churchName === null) !== (right.churchName === null)) return left.churchName === null ? 1 : -1;
    return (left.churchName ?? "").localeCompare(right.churchName ?? "")
      || left.organizationName.localeCompare(right.organizationName);
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
  const churches = [...subtotals.values()].sort((left, right) => {
    if ((left.churchKey === "none") !== (right.churchKey === "none")) return left.churchKey === "none" ? 1 : -1;
    return left.churchName.localeCompare(right.churchName);
  });
  return {
    billedClubCount: billed.length,
    churchCount: churches.filter((church) => church.churchKey !== "none").length,
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
  const table: Array<Array<string | number>> = [[
    hasIndividuals ? "Church or organization" : "Church",
    hasIndividuals ? "Club or registrant" : "Club",
    "Confirmation code",
    "Status",
    "Billed to church",
    "Attendees",
    "Estimated amount owed",
    "Church estimated total",
    "Note",
  ]];
  const sortedRows = sortChurchAmountsOwed(rows);
  for (const row of sortedRows) {
    table.push([
      row.churchName ?? NO_CHURCH_ON_FILE,
      row.organizationName,
      row.confirmationCode,
      row.status,
      row.isBilled ? "Yes" : "No",
      row.attendeeCount,
      money(row.amountOwedCents),
      row.isBilled ? money(subtotalByChurch.get(row.churchId ?? "none") ?? 0) : "",
      row.isBilled
        ? "Billed to the church after the event, not paid online"
        : notBilledLabel(row.status),
    ]);
  }
  for (const line of sponsoredLines) {
    table.push([
      line.churchName,
      `Promo code ${line.promoCode}`,
      line.confirmationCode,
      line.status,
      "Yes",
      "",
      money(line.amountCents),
      money(subtotalByChurch.get(line.churchId) ?? 0),
      SPONSORED_PROMO_NOTE,
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
