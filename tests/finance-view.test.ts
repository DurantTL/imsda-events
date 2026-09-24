import { describe, expect, it } from "vitest";
import {
  attendeeBalanceCents,
  matchesFinanceFilter,
  summarizeFinanceTotals,
  type FinanceViewRegistration,
} from "@/modules/registrations/finance-view";

function registration(overrides: Partial<FinanceViewRegistration> = {}): FinanceViewRegistration {
  return {
    status: "SUBMITTED",
    totalAmountCents: 5_000,
    paidCents: 0,
    balanceCents: 5_000,
    isDeferredOrganizationBilling: false,
    payments: [],
    ...overrides,
  };
}

const attendeePay = registration();
const attendeePaid = registration({ paidCents: 5_000, balanceCents: 0 });
const churchBilled = registration({ totalAmountCents: 6_300, balanceCents: 6_300, isDeferredOrganizationBilling: true });
const churchWaitlisted = registration({ status: "WAITLISTED", totalAmountCents: 900, balanceCents: 900, isDeferredOrganizationBilling: true });

describe("finance workspace figures (#409)", () => {
  it("keeps church-billed totals out of outstanding and counts them as billed to churches", () => {
    expect(summarizeFinanceTotals([attendeePay, attendeePaid, churchBilled, churchWaitlisted])).toEqual({
      billed: 10_000,
      churchBilled: 6_300,
      received: 5_000,
      outstanding: 5_000,
      refunded: 0,
    });
    expect(attendeeBalanceCents(churchBilled)).toBe(0);
    expect(attendeeBalanceCents(attendeePay)).toBe(5_000);
  });

  it("never lists a church-billed registration under balance due or paid in full", () => {
    const rows = [attendeePay, attendeePaid, churchBilled, churchWaitlisted];
    expect(rows.filter((row) => matchesFinanceFilter(row, "BALANCE"))).toEqual([attendeePay]);
    expect(rows.filter((row) => matchesFinanceFilter(row, "PAID"))).toEqual([attendeePaid]);
    expect(rows.filter((row) => matchesFinanceFilter(row, "CHURCH_BILLED"))).toEqual([churchBilled]);
    expect(rows.filter((row) => matchesFinanceFilter(row, "ALL"))).toHaveLength(4);
  });
});
