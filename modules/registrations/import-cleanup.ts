/**
 * Decides which registrations a superseded import run left behind.
 *
 * Kept separate from the script that deletes them so the rule can be tested
 * without a database: the cost of getting this wrong is destroyed registration
 * history, and "I ran it and it looked right" is not evidence.
 *
 * The rule is deliberately dull. A confirmation code either matches the
 * canonical pattern or it does not, and money is an absolute veto that only an
 * explicit, code-by-code opt-in can lift.
 */

export type CleanupCandidate = {
  id: string;
  confirmationCode: string;
  accountHolder: string;
  status: string;
  attendeeCount: number;
  totalCents: number;
  netPaidCents: number;
};

export type CleanupPlan = {
  kept: CleanupCandidate[];
  deleting: CleanupCandidate[];
  withheld: CleanupCandidate[];
  keptTotalCents: number;
  deletingTotalCents: number;
  beforeTotalCents: number;
  afterTotalCents: number;
  beforeCount: number;
  afterCount: number;
};

function sumTotals(rows: CleanupCandidate[]) {
  return rows.reduce((total, row) => total + row.totalCents, 0);
}

export function planImportCleanup(
  registrations: CleanupCandidate[],
  keepPattern: RegExp,
  alsoDelete: ReadonlySet<string> = new Set(),
): CleanupPlan {
  const kept: CleanupCandidate[] = [];
  const candidates: CleanupCandidate[] = [];

  for (const registration of registrations) {
    // A fresh regex per test would be cleaner still, but the caller owns the
    // pattern; reset lastIndex so a stray /g flag cannot skip alternate rows.
    keepPattern.lastIndex = 0;
    if (keepPattern.test(registration.confirmationCode)) kept.push(registration);
    else candidates.push(registration);
  }

  const deleting: CleanupCandidate[] = [];
  const withheld: CleanupCandidate[] = [];
  for (const candidate of candidates) {
    const paid = candidate.netPaidCents > 0;
    if (!paid || alsoDelete.has(candidate.confirmationCode)) deleting.push(candidate);
    else withheld.push(candidate);
  }

  const beforeCount = registrations.length;
  return {
    kept,
    deleting,
    withheld,
    keptTotalCents: sumTotals(kept),
    deletingTotalCents: sumTotals(deleting),
    beforeTotalCents: sumTotals(registrations),
    afterTotalCents: sumTotals([...kept, ...withheld]),
    beforeCount,
    afterCount: beforeCount - deleting.length,
  };
}
