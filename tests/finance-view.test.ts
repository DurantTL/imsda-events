import { describe, expect, it } from "vitest";
import {
  adjustmentWording,
  attendeeBalanceCents,
  churchBillingFinalNote,
  financeDetailFacts,
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
    // An unknown filter lists nothing, as the finance screen always did.
    expect(rows.filter((row) => matchesFinanceFilter(row, "junk"))).toEqual([]);
  });
});

describe("church-billed finance detail wording (#648)", () => {
  it("keeps attendee-pay registrations on the standard labels", () => {
    const facts = financeDetailFacts({ isDeferredOrganizationBilling: false, paidCents: 0, payments: [] });
    expect(facts.map((fact) => fact.label)).toEqual(["Total", "Net received", "Balance", "Payments"]);
    expect(adjustmentWording(false).title).toBe("Adjust amount owed");
    expect(adjustmentWording(false).lowers).toBe("lowers the amount owed");
  });

  it("shows only the estimate when a church-billed registration has no payments", () => {
    const facts = financeDetailFacts({ isDeferredOrganizationBilling: true, paidCents: 0, payments: [] });
    expect(facts).toEqual([{ label: "Estimated church amount", value: "total" }]);
    expect(churchBillingFinalNote).toBe("Final billing follows event reconciliation; the church is invoiced after the event.");
  });

  it("labels recorded attendee payments, still without a balance", () => {
    const facts = financeDetailFacts({ isDeferredOrganizationBilling: true, paidCents: 2_000, payments: [{}] });
    expect(facts.map((fact) => fact.value)).toEqual(["total", "received", "payments"]);
    expect(facts.map((fact) => fact.label)).toEqual([
      "Estimated church amount",
      "Attendee payments recorded (net)",
      "Payments recorded",
    ]);
  });

  it("words the adjustment panel around the estimated church amount", () => {
    const wording = adjustmentWording(true);
    expect(wording.title).toBe("Adjust estimated church amount");
    expect(wording.button).toBe("Adjust estimated church amount");
    expect(Object.values(wording).join(" ")).not.toMatch(/balance|paid|amount owed/i);
  });
});
