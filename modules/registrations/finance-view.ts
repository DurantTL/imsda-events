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
  /** A "Group" registration (#650): billed to its contact after the event, not to a church. */
  isGroup?: boolean;
  payments: ReadonlyArray<{ refundedCents: number }>;
};

export const financeFilters = [
  { value: "ALL", label: "All financial records" },
  { value: "ACTIVE", label: "Active registrations" },
  { value: "BALANCE", label: "Balance due" },
  { value: "PAID", label: "Paid in full" },
  { value: "CHURCH_BILLED", label: "Billed to churches" },
  { value: "GROUP_BILLED", label: "Billed to group contacts" },
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
    case "CHURCH_BILLED": return churchBilled && !registration.isGroup && activeFinancialStatuses.has(registration.status);
    case "GROUP_BILLED": return churchBilled && Boolean(registration.isGroup) && activeFinancialStatuses.has(registration.status);
    case "REFUNDED": return registration.payments.some((payment) => payment.refundedCents > 0);
    case "WAITLISTED": return registration.status === "WAITLISTED";
    case "CANCELLED": return registration.status === "CANCELLED";
    default: return false;
  }
}

export const churchBillingFinalNote =
  "Final billing follows event reconciliation; the church is invoiced after the event.";

export const groupBillingFinalNote =
  "Final billing follows event reconciliation; the group contact is invoiced after the event.";

export type FinanceDetailFact = { label: string; value: "total" | "received" | "balance" | "payments" };

/**
 * Wording for the registration detail grid (#648). A church-billed total is an
 * estimate owed by the church after the event, so it is never labelled
 * "Total" next to a "Balance" that reads as nothing owed. Attendee-payment
 * facts appear only when payments were actually recorded. Presentation only:
 * stored amounts and calculations are untouched.
 */
export function financeDetailFacts(
  registration: Pick<FinanceViewRegistration, "isDeferredOrganizationBilling" | "isGroup" | "paidCents"> & {
    payments: ReadonlyArray<unknown>;
  },
): FinanceDetailFact[] {
  if (!registration.isDeferredOrganizationBilling) {
    return [
      { label: "Total", value: "total" },
      { label: "Net received", value: "received" },
      { label: "Balance", value: "balance" },
      { label: "Payments", value: "payments" },
    ];
  }
  const facts: FinanceDetailFact[] = [{ label: registration.isGroup ? "Estimated amount (billed to the group contact)" : "Estimated church amount", value: "total" }];
  if (registration.payments.length > 0 || registration.paidCents !== 0) {
    facts.push(
      { label: "Attendee payments recorded (net)", value: "received" },
      { label: "Payments recorded", value: "payments" },
    );
  }
  return facts;
}

/** Adjustment-panel wording; church-billed registrations adjust the estimate, not a balance. */
export function adjustmentWording(churchBilled: boolean, group = false) {
  if (churchBilled && group) {
    return {
      title: "Adjust estimated amount",
      button: "Adjust estimated amount",
      lowers: "lowers the estimated amount",
      lower: "Lower the estimated amount",
      raise: "Raise the estimated amount",
      error: "Unable to adjust the estimated amount.",
    };
  }
  return churchBilled
    ? {
        title: "Adjust estimated church amount",
        button: "Adjust estimated church amount",
        lowers: "lowers the estimated church amount",
        lower: "Lower the estimated church amount",
        raise: "Raise the estimated church amount",
        error: "Unable to adjust the estimated church amount.",
      }
    : {
        title: "Adjust amount owed",
        button: "Adjust amount owed",
        lowers: "lowers the amount owed",
        lower: "Lower the amount owed",
        raise: "Raise the amount owed",
        error: "Unable to adjust the amount owed.",
      };
}
