import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/** #166: what the screen shows. Synthetic data only. */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("server-only", () => ({}));

import { AttendanceReconciliation } from "@/components/attendance-reconciliation";
import { reconcileEvent, type PersonSource } from "@/modules/attendance-reconciliation/domain";
import type { DeferredAttendanceReconciliationView } from "@/modules/attendance-reconciliation/repository";

const people: PersonSource[] = [
  { attendeeId: "a1", name: "Ann Synthetic", checkedIn: true, correction: null, addedAfterSubmission: false, substituted: false, chargeCents: 2500, lateRate: false, adjustmentCents: 0 },
  { attendeeId: "a2", name: "Bo Synthetic", checkedIn: false, correction: { id: "c1", kind: "MARK_ATTENDED" }, addedAfterSubmission: true, substituted: false, chargeCents: 2500, lateRate: false, adjustmentCents: 0 },
  { attendeeId: "a3", name: "Cy Synthetic", checkedIn: false, correction: null, addedAfterSubmission: false, substituted: false, chargeCents: 2500, lateRate: false, adjustmentCents: 0 },
];
const result = reconcileEvent([{
  key: "g", title: "Church One", partyKind: "ORGANIZATION", partyId: "o1", partyName: "Church One", clubId: null,
  registrations: [{
    registrationId: "r1", confirmationCode: "CAM-1", status: "CONFIRMED", label: "Club Alpha", clubId: "c", locationId: null, locationName: null,
    estimatedCents: 7500, people, registrationCharges: [], credits: [], promo: null, review: null, registrationAdjustmentCents: 0, hasPriceLines: true,
  }],
}], "PER_CHURCH");

const approved = {
  id: "v1", versionNumber: 1, status: "APPROVED" as const, fingerprint: "f", ruleVersion: "attended-v1",
  counts: { registered: 3, checkedIn: 1, noShow: 2, addedByStaff: 0, removedByStaff: 0, billable: 1 },
  estimatedCents: 7500, billableCents: 2500, preparedAt: "2026-10-04T10:00:00.000Z", preparedByName: "Finance Staff",
  approvedAt: "2026-10-04T11:00:00.000Z", approvedByName: "Finance Staff", supersededAt: null,
};

function view(overrides: Partial<DeferredAttendanceReconciliationView> = {}): DeferredAttendanceReconciliationView {
  return {
    isDeferred: true, invoiceGrouping: "PER_CHURCH", shown: { kind: "LIVE" }, result, liveTotals: result.totals, liveFingerprint: "g",
    blockers: [], correctionDetails: { c1: { reason: "Came late, missed the desk", actorName: "Finance Staff", createdAt: "2026-10-04T12:00:00.000Z" } }, acknowledgementDetails: {}, reviewPending: [], approved, approvedFreshness: "FACTS_CHANGED", draft: null, draftFreshness: null, versions: [approved],
    ...overrides,
  };
}

const render = (value: DeferredAttendanceReconciliationView) =>
  renderToStaticMarkup(createElement(AttendanceReconciliation, { eventId: "event-1", locationId: null, view: value }));

describe("AttendanceReconciliation screen", () => {
  it("shows registered, checked in, no-show, adjusted and billable side by side with estimated and billable amounts", () => {
    const markup = render(view());
    for (const heading of ["Registered", "Checked in", "No-show", "Adjusted by staff", "Billable", "Estimated (registered)", "Billable amount"]) {
      expect(markup).toContain(heading);
    }
    expect(markup).toContain("$75.00");
    expect(markup).toContain("$50.00");
    expect(markup).toContain("Church One");
  });

  it("drills down to the people with their status and the correction reason", () => {
    const markup = render(view());
    expect(markup).toContain("Ann Synthetic");
    expect(markup).toContain("Checked in");
    expect(markup).toContain("Cy Synthetic");
    expect(markup).toContain("No-show");
    expect(markup).toContain("Corrected: attended");
    expect(markup).toContain("Reason: Came late, missed the desk");
    expect(markup).toContain("added after submission");
  });

  it("flags that facts changed since approval, and offers correction and prepare controls", () => {
    const markup = render(view());
    expect(markup).toContain("Facts changed since approval");
    expect(markup).toContain("This approved version is unchanged");
    expect(markup).toContain("Prepare reconciliation");
    expect(markup).toContain("Correct…");
  });

  it("lists why it is blocked, with a link to Billing responsibility, and disables preparing", () => {
    const markup = render(view({ blockers: [{ registrationId: "r1", confirmationCode: "CAM-1", label: "Club Alpha", reason: "UNRESOLVED" }] }));
    expect(markup).toContain("Billing responsibility is not ready");
    expect(markup).toContain("/finance/billing-responsibility?event=event-1");
    expect(markup).toContain("No responsible organization yet");
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>Prepare reconciliation/);
  });

  it("shows a saved version read-only: no correction buttons", () => {
    const markup = render(view({ shown: { kind: "VERSION", version: approved } }));
    expect(markup).toContain("saved snapshot of version 1");
    expect(markup).not.toContain("Correct…");
  });

  it("offers Approve only for a draft that matches the facts now", () => {
    const draft = { ...approved, id: "v2", versionNumber: 2, status: "DRAFT" as const, approvedAt: null, approvedByName: null };
    expect(render(view({ draft, draftFreshness: "CURRENT" }))).toContain("Approve version 2");
    const stale = render(view({ draft, draftFreshness: "FACTS_CHANGED" }));
    expect(stale).not.toContain("Approve version 2");
    expect(stale).toContain("can no longer be approved");
  });

  it("shows a promo code and charges not tied to a person as their own lines", () => {
    const source = {
      registrationId: "r2", confirmationCode: "CAM-2", status: "CONFIRMED" as const, label: "Club Beta", clubId: "c2", locationId: null, locationName: null,
      estimatedCents: 15000, people: people.map((entry) => ({ ...entry, checkedIn: true, correction: null })),
      registrationCharges: [{ label: "Flat registration fee", cents: 2000 }], credits: [],
      promo: { code: "SAVE20", type: "FIXED_CENTS" as const, value: 2000, maximumDiscountCents: null, recordedCents: 2000 },
      review: null, registrationAdjustmentCents: 0, hasPriceLines: true,
    };
    const promoResult = reconcileEvent([{ key: "g", title: "Church One", partyKind: "ORGANIZATION", partyId: "o1", partyName: "Church One", clubId: null, registrations: [source] }], "PER_CHURCH");
    const markup = render(view({ result: promoResult }));
    expect(markup).toContain("Charges not tied to a person");
    expect(markup).toContain("Flat registration fee: $20.00");
    expect(markup).toContain("promo code SAVE20 -$20.00");
  });

  it("shows a roster review, offers the acknowledgement with the no-medical-details help text, and disables approval", () => {
    const source = {
      registrationId: "r3", confirmationCode: "CAM-3", status: "CONFIRMED" as const, label: "Club Gamma", clubId: "c3", locationId: null, locationName: null,
      estimatedCents: 7500, people, registrationCharges: [], credits: [], promo: null,
      review: { reasons: ["TRANSFER_AFTER_PRICING" as const], acknowledged: false, acknowledgementId: null }, registrationAdjustmentCents: 0, hasPriceLines: true,
    };
    const reviewResult = reconcileEvent([{ key: "g", title: "Church One", partyKind: "ORGANIZATION", partyId: "o1", partyName: "Church One", clubId: null, registrations: [source] }], "PER_CHURCH");
    const draft = { ...approved, id: "v2", versionNumber: 2, status: "DRAFT" as const, approvedAt: null, approvedByName: null };
    const markup = render(view({
      result: reviewResult,
      reviewPending: [{ registrationId: "r3", confirmationCode: "CAM-3", label: "Club Gamma" }],
      draft, draftFreshness: "CURRENT",
    }));
    expect(markup).toContain("Needs review: roster changed after pricing");
    expect(markup).toContain("Acknowledge…");
    expect(markup).toContain("Prorated from the estimate");
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>Approve version 2/);
  });

  it("the correction form tells staff not to include health or medical details", async () => {
    const { REASON_HELP } = await import("@/components/attendance-reconciliation-controls");
    expect(REASON_HELP).toBe("Don't include health or medical details. A short reason like 'did not attend' or 'missed at check-in' is enough.");
  });

  it("says nothing is sent from here", () => {
    expect(render(view())).toContain("Nothing is");
  });
});
