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

export type ChurchAmountOwedRow = {
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
};

export type ChurchSubtotal = {
  churchKey: string;
  churchName: string;
  clubCount: number;
  amountOwedCents: number;
};

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

/** CSV rows: one per club with its church and that church's subtotal, so the file sorts and filters cleanly. */
export function churchAmountsOwedCsvRows(rows: ChurchAmountOwedRow[]) {
  const summary = summarizeChurchAmountsOwed(rows);
  const subtotalByChurch = new Map(summary.churches.map((church) => [church.churchKey, church.amountOwedCents]));
  const money = (cents: number) => (cents / 100).toFixed(2);
  const table: Array<Array<string | number>> = [[
    "Church",
    "Club",
    "Confirmation code",
    "Status",
    "Billed to church",
    "Attendees",
    "Estimated amount owed",
    "Church estimated total",
    "Note",
  ]];
  for (const row of sortChurchAmountsOwed(rows)) {
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
  return table;
}
