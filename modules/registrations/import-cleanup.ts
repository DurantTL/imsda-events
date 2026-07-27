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
  /** Payments that succeeded, less refunds that succeeded — the same net the
   * rest of the application treats as money actually received. */
  netPaidCents: number;
  totalCents: number;
  /**
   * Whether the registration has any RegistrationOperation or
   * RegistrationPaymentChoiceOperation row. Both tables carry a BEFORE UPDATE
   * OR DELETE trigger that raises unconditionally, and both foreign keys are
   * ON DELETE RESTRICT, so such a registration cannot be deleted at all — an
   * attempt aborts the whole transaction and takes the other duplicates with
   * it. These are withheld rather than worked around: the invariant is
   * deliberate, and transfer and amendment history is meant to outlive the
   * row it describes.
   */
  hasImmutableHistory: boolean;
};

export type CleanupWithholdReason = "RECEIVED_MONEY" | "IMMUTABLE_HISTORY";

export type WithheldCandidate = CleanupCandidate & { reason: CleanupWithholdReason };

export type CleanupPlan = {
  kept: CleanupCandidate[];
  deleting: CleanupCandidate[];
  withheld: WithheldCandidate[];
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
  const withheld: WithheldCandidate[] = [];
  for (const candidate of candidates) {
    // Immutable history is checked first and cannot be overridden. --also-delete
    // is a judgement call about money; it is not a way to defeat a database
    // invariant, and trying would only abort the transaction.
    if (candidate.hasImmutableHistory) {
      withheld.push({ ...candidate, reason: "IMMUTABLE_HISTORY" });
      continue;
    }
    const paid = candidate.netPaidCents > 0;
    if (!paid || alsoDelete.has(candidate.confirmationCode)) deleting.push(candidate);
    else withheld.push({ ...candidate, reason: "RECEIVED_MONEY" });
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
