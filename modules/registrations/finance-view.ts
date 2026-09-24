/**
 * Staff finance arithmetic shared by the finance workspace. A church-billed
 * (deferred-organization) registration's total is what its church owes,
 * billed after the event (#409): it is never an attendee balance, so it never
 * counts as outstanding, balance due, or paid in full, and is totalled
 * separately as "billed to churches".
 */

export const activeFinancialStatuses: ReadonlySet<string> = new Set(["SUBMITTED", "CONFIRMED"]);

export type FinanceViewRegistration = {
  status: string;
  totalAmountCents: number;
  paidCents: number;
  balanceCents: number;
  isDeferredOrganizationBilling?: boolean;
  payments: ReadonlyArray<{ refundedCents: number }>;
};

export const financeFilters = [
  { value: "ALL", label: "All financial records" },
  { value: "ACTIVE", label: "Active registrations" },
  { value: "BALANCE", label: "Balance due" },
  { value: "PAID", label: "Paid in full" },
  { value: "CHURCH_BILLED", label: "Billed to churches" },
  { value: "REFUNDED", label: "Has refunds" },
  { value: "WAITLISTED", label: "Waitlisted" },
  { value: "CANCELLED", label: "Cancelled" },
] as const;

/** The balance an attendee or director could owe online: always $0 when a church is billed. */
export function attendeeBalanceCents(
  registration: Pick<FinanceViewRegistration, "balanceCents" | "isDeferredOrganizationBilling">,
) {
  return registration.isDeferredOrganizationBilling ? 0 : registration.balanceCents;
}

export function summarizeFinanceTotals(registrations: readonly FinanceViewRegistration[]) {
  return registrations.reduce((summary, registration) => {
    const active = activeFinancialStatuses.has(registration.status);
    const churchBilled = Boolean(registration.isDeferredOrganizationBilling);
    return {
      billed: summary.billed + (active && !churchBilled ? registration.totalAmountCents : 0),
      churchBilled: summary.churchBilled + (active && churchBilled ? registration.totalAmountCents : 0),
      received: summary.received + registration.paidCents,
      outstanding: summary.outstanding + (active ? attendeeBalanceCents(registration) : 0),
      refunded: summary.refunded + registration.payments.reduce((total, payment) => total + payment.refundedCents, 0),
    };
  }, { billed: 0, churchBilled: 0, received: 0, outstanding: 0, refunded: 0 });
}

export function matchesFinanceFilter(registration: FinanceViewRegistration, filter: string) {
  const churchBilled = Boolean(registration.isDeferredOrganizationBilling);
  switch (filter) {
    case "ALL": return true;
    case "ACTIVE": return activeFinancialStatuses.has(registration.status);
    case "BALANCE": return attendeeBalanceCents(registration) > 0;
    case "PAID": return !churchBilled && registration.balanceCents === 0 && registration.totalAmountCents > 0;
    case "CHURCH_BILLED": return churchBilled && activeFinancialStatuses.has(registration.status);
    case "REFUNDED": return registration.payments.some((payment) => payment.refundedCents > 0);
    case "WAITLISTED": return registration.status === "WAITLISTED";
    case "CANCELLED": return registration.status === "CANCELLED";
    default: return false;
  }
}
