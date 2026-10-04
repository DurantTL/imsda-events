import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/** #167: what the Invoices screens show and offer. Synthetic data only. */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("server-only", () => ({}));

import { InvoiceDetailView } from "@/components/invoice-detail";
import { Invoices } from "@/components/invoices";
import type { InvoiceSnapshot } from "@/modules/invoices/domain";
import type { InvoiceDetail, InvoiceListRow, InvoiceVersionSummary, InvoicesView } from "@/modules/invoices/repository";

const contact = { name: "Tina Treasurer", email: "tina@contact.test", roleLabel: "Treasurer", verified: true };

function version(overrides: Partial<InvoiceVersionSummary> = {}): InvoiceVersionSummary {
  return {
    id: "v1", invoiceId: "i1", revision: 0, status: "FINALIZED", basis: "RECONCILIATION", supersedesVersionId: null, reconciliationVersionId: "recon-1", reconciliationVersionNumber: 2,
    number: "SC27-0001", groupTitle: "Church One", organizationName: "Church One", contact, registeredCount: 5, billableCount: 4, amountDueCents: 10000, amountsFingerprint: "fp",
    revisionReason: null, createdAt: "2026-10-04T10:00:00.000Z", createdByName: "Fran Finance", regenerationCount: 0, finalizedAt: "2026-10-04T12:00:00.000Z", finalizedByName: "Tess Treasurer",
    supersededAt: null, supersededByVersionId: null, receivable: { amountCents: 10000, status: "OPEN" },
    ...overrides,
  };
}

function row(overrides: Partial<InvoiceListRow> = {}): InvoiceListRow {
  const current = overrides.current ?? version();
  return {
    invoiceId: "i1", groupKey: "organization:church-1", groupTitle: "Church One", organizationName: "Church One", baseNumber: "SC27-0001", current, finalized: current.status === "FINALIZED" ? current : null,
    hasOpenRevision: false, versionCount: 1, contactChanged: false, amountsOutOfDate: false, currentContact: contact,
    ...overrides,
  };
}

function view(overrides: Partial<Extract<InvoicesView, { isDeferred: true }>> = {}): InvoicesView {
  return {
    isDeferred: true, eventName: "Spring Camporee 2027", invoiceGrouping: "PER_CHURCH",
    code: { effective: "SC", explicit: null, locked: false, year: 2027 },
    approved: { id: "recon-1", versionNumber: 2, billableCents: 12500, approvedAt: "2026-10-04T09:00:00.000Z", freshness: "CURRENT" },
    blockers: [], invoices: [row()], groupsWithoutInvoice: [], finalizers: ["Tess Treasurer"], totals: { draftCount: 0, finalizedCount: 1, finalizedCents: 10000 },
    ...overrides,
  };
}

const renderList = (value: InvoicesView, canFinalize = false) => renderToStaticMarkup(createElement(Invoices, { eventId: "event-1", view: value, canFinalize }));

describe("Invoices list", () => {
  it("lists each group with its status, number, total and contact", () => {
    const markup = renderList(view({
      invoices: [
        row(),
        row({ invoiceId: "i2", groupKey: "organization:church-2", groupTitle: "Church Two", organizationName: "Church Two", baseNumber: null, current: version({ id: "v9", invoiceId: "i2", status: "DRAFT", number: null, amountDueCents: 0, contact: null, finalizedAt: null, finalizedByName: null, receivable: null, groupTitle: "Church Two", organizationName: "Church Two" }), finalized: null, currentContact: null }),
      ],
      totals: { draftCount: 1, finalizedCount: 1, finalizedCents: 10000 },
    }));
    expect(markup).toContain("Church One");
    expect(markup).toContain("Finalized");
    expect(markup).toContain("SC27-0001");
    expect(markup).toContain("$100.00");
    expect(markup).toContain("Tina Treasurer");
    expect(markup).toContain("Draft");
    expect(markup).toContain("Number assigned when finalized");
    expect(markup).toContain("No billing contact");
    expect(markup).toContain("/finance/invoices/i1?event=event-1");
  });

  it("says that nothing is sent and who can finalize, and never offers to send", () => {
    const markup = renderList(view());
    expect(markup).toContain("Nothing is sent from here");
    expect(markup).toContain("Who can finalize: system administrators, and Tess Treasurer");
    expect(markup).toContain("finalizing needs that permission");
    expect(markup).not.toMatch(/Send invoice|Email/);
    expect(renderList(view(), true)).toContain("You can finalize invoices.");
  });

  it("flags a changed contact and amounts that no longer match, offering the revision", () => {
    const markup = renderList(view({ invoices: [row({ contactChanged: true, amountsOutOfDate: true })] }));
    expect(markup).toContain("Contact changed since finalization.");
    expect(markup).toContain("No longer matches the approved reconciliation.");
  });

  it("disables drafting with no approved reconciliation, a changed one, or open blockers", () => {
    expect(renderList(view({ approved: null, invoices: [], totals: { draftCount: 0, finalizedCount: 0, finalizedCents: 0 } }))).toContain("No attendance reconciliation has been approved yet");
    const changed = renderList(view({ approved: { id: "r", versionNumber: 2, billableCents: 1, approvedAt: null, freshness: "FACTS_CHANGED" } }));
    expect(changed).toContain("Facts changed since approval");
    expect(changed).toMatch(/<button[^>]*disabled[^>]*>Create invoice drafts/);
    const blocked = renderList(view({ blockers: [{ registrationId: "r1", confirmationCode: "C-1", label: "Club Alpha", reason: "UNRESOLVED" }] }));
    expect(blocked).toContain("Billing responsibility is not ready");
    expect(blocked).toMatch(/<button[^>]*disabled[^>]*>Create invoice drafts/);
    expect(renderList(view())).not.toMatch(/<button[^>]*disabled[^>]*>Create invoice drafts/);
  });

  it("shows the invoice code with its lock", () => {
    expect(renderList(view())).toContain("SC27-0001");
    expect(renderList(view({ code: { effective: "SC", explicit: "SC", locked: true, year: 2027 } }))).toContain("the code is locked");
  });

  it("is a notice for an event not billed to organizations", () => {
    expect(renderList({ isDeferred: false })).toContain("This event is not billed to organizations");
  });
});

const snapshot: InvoiceSnapshot = {
  schema: 1, event: { id: "event-1", name: "Spring Camporee 2027" }, groupKey: "organization:church-1", groupTitle: "Church One", invoiceGrouping: "PER_CHURCH",
  party: { kind: "ORGANIZATION", id: "church-1", name: "Church One" }, clubId: null, reconciliation: { versionId: "recon-1", versionNumber: 2, ruleVersion: "attended-v1" },
  lines: [{
    registrationId: "r1", confirmationCode: "CAM-1", label: "Club Alpha", clubId: "c1", counts: { registered: 3, checkedIn: 2, noShow: 1, addedByStaff: 0, removedByStaff: 0, billable: 2 }, basis: "PER_PERSON_LINES",
    people: [{ attendeeId: "a1", name: "Ann Synthetic", billable: true, amountCents: 2500 }, { attendeeId: "a3", name: "Cy Synthetic", billable: false, amountCents: null }],
    chargesNotTiedToPerson: [{ label: "Late fee", amountCents: 1000, kind: "CHARGE" }], credits: [{ label: "Meal sponsorship", units: 2, amountCents: -1000 }], promo: { code: "SAVE5", amountCents: -500 },
    adjustmentCents: 0, components: { personChargesCents: 5000, registrationChargeCents: 1000, creditCents: -1000, promoCents: -500, adjustmentCents: 0 }, amountCents: 4500,
  }],
  totals: { registered: 3, checkedIn: 2, noShow: 1, billable: 2, amountDueCents: 4500 },
};

function detail(overrides: Partial<InvoiceDetail> = {}): InvoiceDetail {
  const shown = overrides.shown ?? version({ amountDueCents: 4500 });
  return {
    invoice: { id: "i1", groupKey: "organization:church-1", baseNumber: "SC27-0001", invoiceGrouping: "PER_CHURCH", partyKind: "ORGANIZATION" },
    versions: [shown], discarded: [], shown, snapshot, change: null, needsFinalizePermission: false, currentContact: contact, contactChanged: false, amountsOutOfDate: false,
    hasOpenDraft: shown.status === "DRAFT", liveFinalized: shown.status === "FINALIZED" ? shown : null, reconciliationFreshness: "CURRENT", approvedReconciliationVersionId: "recon-1",
    ...overrides,
  };
}

const renderDetail = (value: InvoiceDetail, canFinalize = false) => renderToStaticMarkup(createElement(InvoiceDetailView, { eventId: "event-1", detail: value, canFinalize, viewerName: "Tess Treasurer" }));

describe("Invoice detail", () => {
  it("shows the snapshot: contact, lines, people, charges not tied to a person, credits, promo and the total", () => {
    const markup = renderDetail(detail());
    expect(markup).toContain("Tina Treasurer");
    expect(markup).toContain("tina@contact.test");
    expect(markup).toContain("Club Alpha");
    expect(markup).toContain("Ann Synthetic");
    expect(markup).toContain("not billed");
    expect(markup).toContain("Late fee: $10.00");
    expect(markup).toContain("Meal sponsorship (2) -$10.00");
    expect(markup).toContain("Promo SAVE5 -$5.00");
    expect(markup).toContain("$45.00");
    expect(markup).toContain("Finalized");
    expect(markup).toContain("Tess Treasurer");
    expect(markup).toContain("reconciliation version 2");
  });

  it("a draft an original: finalize is offered only to someone with the permission, with a named confirmation", () => {
    const draft = version({ status: "DRAFT", number: null, finalizedAt: null, finalizedByName: null, receivable: null, amountDueCents: 4500 });
    const without = renderDetail(detail({ shown: draft, versions: [draft], needsFinalizePermission: true, liveFinalized: null, hasOpenDraft: true }), false);
    expect(without).not.toContain("Finalize invoice</button>");
    expect(without).toContain("needs permission to finalize invoices");
    expect(without).toContain("Regenerate draft");
    const withPermission = renderDetail(detail({ shown: draft, versions: [draft], needsFinalizePermission: true, liveFinalized: null, hasOpenDraft: true }), true);
    expect(withPermission).toContain("Finalize invoice</button>");
    expect(withPermission).toContain("I, Tess Treasurer, approve this invoice for Church One totaling $45.00");
    expect(withPermission).toContain("Nothing is sent to anyone");
  });

  it("a contact-only revision can be finalized by finance staff without the permission; an amount revision cannot", () => {
    const revision = version({ id: "v2", revision: 1, status: "DRAFT", basis: "CONTACT_ONLY_COPY", number: null, supersedesVersionId: "v1", finalizedAt: null, finalizedByName: null, receivable: null, revisionReason: "New treasurer" });
    const contactOnly = renderDetail(detail({ shown: revision, versions: [revision], needsFinalizePermission: false, liveFinalized: version(), hasOpenDraft: true, change: { amountsChanged: false, contactChanged: true, previousAmountCents: 4500, amountCents: 4500, previousNumber: "SC27-0001" } }), false);
    expect(contactOnly).toContain("Finalize invoice</button>");
    expect(contactOnly).toContain("revision 1 of this invoice");
    expect(contactOnly).toContain("no billable amount changes");
    expect(contactOnly).toContain("the billing contact changes");
    const amounts = renderDetail(detail({ shown: revision, versions: [revision], needsFinalizePermission: true, liveFinalized: version(), hasOpenDraft: true, change: { amountsChanged: true, contactChanged: false, previousAmountCents: 4500, amountCents: 7000, previousNumber: "SC27-0001" } }), false);
    expect(amounts).not.toContain("Finalize invoice</button>");
    expect(amounts).toContain("the amount changes from $45.00 to $70.00");
  });

  it("says the contact changed since finalization and offers a revision, keeping the old contact in the snapshot", () => {
    const markup = renderDetail(detail({ contactChanged: true, currentContact: { name: "Sam Successor", email: "sam@contact.test", roleLabel: "Treasurer", verified: true } }));
    expect(markup).toContain("Contact changed since finalization.");
    expect(markup).toContain("Sam Successor");
    expect(markup).toContain("Tina Treasurer");
    expect(markup).toContain("Start a revision");
    expect(markup).toContain("The billing contact only");
  });

  it("shows the version history with the superseded version still readable", () => {
    const older = version({ status: "SUPERSEDED", supersededAt: "2026-10-05T10:00:00.000Z", supersededByVersionId: "v2", receivable: { amountCents: 10000, status: "SUPERSEDED" } });
    const live = version({ id: "v2", revision: 1, number: "SC27-0001-R1", supersedesVersionId: "v1", revisionReason: "New treasurer" });
    const markup = renderDetail(detail({ shown: live, versions: [live, older], liveFinalized: live }));
    expect(markup).toContain("SC27-0001-R1");
    expect(markup).toContain("Superseded");
    expect(markup).toContain("Original");
    expect(markup).toContain("Revision 1");
    expect(markup).toContain("/finance/invoices/i1?event=event-1&amp;version=v1");
  });

  it("shows a discarded draft in the history as a muted row with who and when", () => {
    const markup = renderDetail(detail({ discarded: [{ id: "d1", revision: 0, amountDueCents: 2500, discardedAt: "2026-10-04T13:00:00.000Z", discardedByName: "Fran Finance" }] }));
    expect(markup).toContain("invoice-discarded");
    expect(markup).toContain("Original draft");
    expect(markup).toContain("Discarded");
    expect(markup).toContain("by Fran Finance");
    expect(renderDetail(detail())).not.toContain("invoice-discarded");
  });

  it("a $0 invoice can be finalized and says nothing is owed", () => {
    const zero = version({ status: "DRAFT", number: null, finalizedAt: null, finalizedByName: null, receivable: null, amountDueCents: 0 });
    const markup = renderDetail(detail({ shown: zero, versions: [zero], needsFinalizePermission: true, liveFinalized: null, hasOpenDraft: true }), true);
    expect(markup).toContain("nothing owed");
    expect(markup).toContain("This invoice is for $0");
    expect(markup).toContain("Finalize invoice</button>");
  });

  it("a draft on a reconciliation that is no longer current cannot be finalized from the screen", () => {
    const draft = version({ status: "DRAFT", number: null, finalizedAt: null, finalizedByName: null, receivable: null });
    const markup = renderDetail(detail({ shown: draft, versions: [draft], needsFinalizePermission: true, liveFinalized: null, hasOpenDraft: true, reconciliationFreshness: "FACTS_CHANGED" }), true);
    expect(markup).toContain("This draft cannot be finalized yet.");
    expect(markup).not.toContain("Finalize invoice</button>");
  });
});
