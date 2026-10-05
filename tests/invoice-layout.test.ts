import { describe, expect, it } from "vitest";

/**
 * #780: the church invoice's line-item table as data (grouping under the club type, one row per distinct rate, the
 * late-rate row, negative discount rows, manual lines), the footer totals with payments, the bill-to address and the
 * header block with its fallback. Synthetic data only.
 */
import { reconcileEvent, type GroupSource, type PersonSource, type RegistrationSource } from "@/modules/attendance-reconciliation/domain";
import { INVOICE_PDF_GENERATOR_VERSION, netPaidCents } from "@/modules/invoices/delivery-domain";
import { buildInvoiceFigures } from "@/modules/invoices/domain";
import { DEFAULT_CLUB_TYPE_HEADING, MANUAL_LINES_HEADING, billToAddressLines, buildInvoiceLayout, resolveInvoiceHeader, rowsForLine } from "@/modules/invoices/invoice-layout";
import type { ManualInvoiceLine } from "@/modules/invoices/manual-lines";

const person = (id: string, checkedIn: boolean, chargeCents = 2500, lateRate = false): PersonSource => ({
  attendeeId: id, name: `Person ${id}`, checkedIn, correction: null, addedAfterSubmission: false, substituted: false, chargeCents, lateRate, adjustmentCents: 0,
});
const registration = (id: string, club: string, people: PersonSource[], extras: Partial<RegistrationSource> = {}): RegistrationSource => ({
  registrationId: id, confirmationCode: `CODE-${id}`, status: "CONFIRMED", label: club, clubId: `club-${club}`, locationId: null, locationName: null,
  estimatedCents: people.reduce((total, entry) => total + entry.chargeCents, 0), people, registrationCharges: [], credits: [], promo: null, review: null, registrationAdjustmentCents: 0, hasPriceLines: true,
  ...extras,
});

function snapshotFor(registrations: RegistrationSource[]) {
  const source: GroupSource = { key: "church:church-1", title: "Church One", partyKind: "ORGANIZATION", partyId: "church-1", partyName: "Church One", clubId: null, registrations };
  const result = reconcileEvent([source], "PER_CHURCH");
  return buildInvoiceFigures({
    event: { id: "event-1", name: "Spring Camporee 2027" },
    groupKey: result.groups[0]!.key,
    groupTitle: result.groups[0]!.title,
    invoiceGrouping: "PER_CHURCH",
    party: { kind: "ORGANIZATION", id: "church-1", name: "Church One" },
    clubId: null,
    reconciliation: { versionId: "recon-1", versionNumber: 1, ruleVersion: result.ruleVersion },
    group: result.groups[0]!,
  }).snapshot;
}

const rowsOf = (layout: ReturnType<typeof buildInvoiceLayout>) => layout.groups.flatMap((group) => group.rows);
const sumRows = (layout: ReturnType<typeof buildInvoiceLayout>) => rowsOf(layout).reduce((total, row) => total + row.amountCents, 0);

describe("invoice layout (#780)", () => {
  it("groups the registration lines under the event's club type, and falls back to Registrations", () => {
    const snapshot = snapshotFor([registration("r1", "Eagles", [person("a", true)])]);
    const named = buildInvoiceLayout({ snapshot, manualLines: [], clubType: "Pathfinders", paymentsCreditsCents: 0 });
    expect(named.groups.map((group) => group.heading)).toEqual(["Pathfinders"]);
    const blank = buildInvoiceLayout({ snapshot, manualLines: [], clubType: "  ", paymentsCreditsCents: 0 });
    expect(blank.groups[0]!.heading).toBe(DEFAULT_CLUB_TYPE_HEADING);
    expect(buildInvoiceLayout({ snapshot, manualLines: [], clubType: null, paymentsCreditsCents: 0 }).groups[0]!.heading).toBe(DEFAULT_CLUB_TYPE_HEADING);
  });

  it("collapses attended people into one row per distinct rate: quantity x rate, and nobody who did not attend", () => {
    const snapshot = snapshotFor([registration("r1", "Eagles", [person("a", true), person("b", true), person("c", true, 3000), person("d", false)])]);
    const rows = rowsForLine(snapshot.lines[0]!);
    expect(rows).toEqual([
      { item: "Eagles", description: "Attended", quantity: 2, rateCents: 2500, amountCents: 5000 },
      { item: "Eagles", description: "Attended", quantity: 1, rateCents: 3000, amountCents: 3000 },
    ].sort((a, b) => b.rateCents - a.rateCents));
  });

  it("shows the late rate on its own row, after the regular rows", () => {
    const snapshot = snapshotFor([registration("r1", "Eagles", [person("a", true), person("b", true, 3500, true), person("c", true, 3500, true)])]);
    const rows = rowsForLine(snapshot.lines[0]!);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ description: "Attended", quantity: 1, rateCents: 2500, amountCents: 2500 });
    expect(rows[1]).toMatchObject({ description: "Attended, late registration rate", quantity: 2, rateCents: 3500, amountCents: 7000 });
  });

  it("puts each discount on its own negative row: credits, the promo discount (never its code) and staff adjustments", () => {
    const snapshot = snapshotFor([
      registration("r1", "Eagles", [person("a", true), person("b", true)], {
        credits: [{ key: "meals", label: "Meal sponsorship", centsPerUnit: -500, rawUnits: 2, capAtHeadcount: false, recordedCents: -1000 }],
        promo: { code: "PRIVATE10", type: "FIXED_CENTS", value: 300, maximumDiscountCents: null, recordedCents: 300 },
        registrationAdjustmentCents: -200,
      }),
    ]);
    const layout = buildInvoiceLayout({ snapshot, manualLines: [], clubType: "Pathfinders", paymentsCreditsCents: 0 });
    const negatives = rowsOf(layout).filter((row) => row.amountCents < 0);
    expect(negatives.map((row) => row.description)).toEqual(["Credit: Meal sponsorship", "Promo discount", "Staff adjustments"]);
    expect(negatives[0]).toMatchObject({ quantity: 2, rateCents: -500, amountCents: -1000 });
    expect(JSON.stringify(layout)).not.toContain("PRIVATE10");
    expect(JSON.stringify(layout)).not.toContain("CODE-r1");
    // The rows always add up to the invoice's total.
    expect(sumRows(layout)).toBe(snapshot.totals.amountDueCents);
  });

  it("lists a registration-level charge as its own row and prints a recorded credit once", () => {
    const snapshot = snapshotFor([
      registration("r1", "Eagles", [person("a", true)], {
        registrationCharges: [{ label: "Flat site fee", cents: 1500 }],
        credits: [{ key: "x", label: "Recorded credit", centsPerUnit: null, rawUnits: null, capAtHeadcount: false, recordedCents: -400 }],
      }),
    ]);
    const layout = buildInvoiceLayout({ snapshot, manualLines: [], clubType: null, paymentsCreditsCents: 0 });
    expect(rowsOf(layout).map((row) => row.description)).toEqual(["Attended", "Flat site fee", "Credit: Recorded credit"]);
    expect(sumRows(layout)).toBe(snapshot.totals.amountDueCents);
  });

  it("keeps the rows adding up to the total when a credit is capped at the charges", () => {
    const snapshot = snapshotFor([
      registration("r1", "Eagles", [person("a", true)], { credits: [{ key: "x", label: "Large credit", centsPerUnit: -10000, rawUnits: 1, capAtHeadcount: false, recordedCents: -10000 }] }),
    ]);
    const layout = buildInvoiceLayout({ snapshot, manualLines: [], clubType: null, paymentsCreditsCents: 0 });
    expect(rowsOf(layout).some((row) => row.description === "Credit limit adjustment")).toBe(true);
    expect(sumRows(layout)).toBe(0);
    expect(layout.totalCents).toBe(0);
  });

  it("shows a prorated registration as one row", () => {
    const snapshot = snapshotFor([registration("r1", "Eagles", [person("a", true), person("b", false)], { hasPriceLines: false, estimatedCents: 5000 })]);
    const rows = rowsForLine(snapshot.lines[0]!);
    expect(rows).toEqual([{ item: "Eagles", description: "Prorated: 1 of 2 attended", quantity: 1, rateCents: 2500, amountCents: 2500 }]);
  });

  it("leaves out a registration where no one attended", () => {
    const snapshot = snapshotFor([registration("r1", "Eagles", [person("a", false)]), registration("r2", "Hawks", [person("b", true)])]);
    expect(rowsOf(buildInvoiceLayout({ snapshot, manualLines: [], clubType: null, paymentsCreditsCents: 0 })).map((row) => row.item)).toEqual(["Hawks"]);
  });

  it("puts manual lines under their own heading and includes them in the total", () => {
    const snapshot = snapshotFor([registration("r1", "Eagles", [person("a", true)])]);
    const manual: ManualInvoiceLine[] = [
      { id: "m1", item: "Patch order", description: "Camporee patch", quantity: 10, rateCents: 450, amountCents: 4500 },
      { id: "m2", item: "Late pin", description: "", quantity: 1, rateCents: -300, amountCents: -300 },
    ];
    const layout = buildInvoiceLayout({ snapshot, manualLines: manual, clubType: "Pathfinders", paymentsCreditsCents: 0 });
    expect(layout.groups.map((group) => group.heading)).toEqual(["Pathfinders", MANUAL_LINES_HEADING]);
    expect(layout.groups[1]!.rows).toEqual([
      { item: "Patch order", description: "Camporee patch", quantity: 10, rateCents: 450, amountCents: 4500 },
      { item: "Late pin", description: "", quantity: 1, rateCents: -300, amountCents: -300 },
    ]);
    expect(layout.totalCents).toBe(2500 + 4500 - 300);
    expect(sumRows(layout)).toBe(layout.totalCents);
  });

  it("a manual-lines-only invoice has just the manual group", () => {
    const snapshot = snapshotFor([registration("r1", "Eagles", [person("a", false)])]);
    const layout = buildInvoiceLayout({ snapshot, manualLines: [{ id: "m", item: "Patches", description: "", quantity: 2, rateCents: 500, amountCents: 1000 }], clubType: "Pathfinders", paymentsCreditsCents: 0 });
    expect(layout.groups.map((group) => group.heading)).toEqual([MANUAL_LINES_HEADING]);
    expect(layout.totalCents).toBe(1000);
  });

  it("footer totals: Total, Payments/Credits and Balance Due, with the balance never below zero", () => {
    const snapshot = snapshotFor([registration("r1", "Eagles", [person("a", true), person("b", true)])]);
    const partial = buildInvoiceLayout({ snapshot, manualLines: [], clubType: null, paymentsCreditsCents: 2000 });
    expect(partial).toMatchObject({ totalCents: 5000, paymentsCreditsCents: 2000, balanceDueCents: 3000 });
    const paid = buildInvoiceLayout({ snapshot, manualLines: [], clubType: null, paymentsCreditsCents: 5000 });
    expect(paid.balanceDueCents).toBe(0);
    const over = buildInvoiceLayout({ snapshot, manualLines: [], clubType: null, paymentsCreditsCents: 6000 });
    expect(over.balanceDueCents).toBe(0);
  });

  it("payments come from InvoicePayment entries net of voided ones", () => {
    const entries = [
      { id: "p1", kind: "PAYMENT" as const, amountCents: 3000, reversesPaymentId: null },
      { id: "p2", kind: "PAYMENT" as const, amountCents: 1000, reversesPaymentId: null },
      { id: "r1", kind: "REVERSAL" as const, amountCents: 1000, reversesPaymentId: "p2" },
    ];
    expect(netPaidCents(entries)).toBe(3000);
    const snapshot = snapshotFor([registration("r1", "Eagles", [person("a", true), person("b", true)])]);
    expect(buildInvoiceLayout({ snapshot, manualLines: [], clubType: null, paymentsCreditsCents: netPaidCents(entries) }).balanceDueCents).toBe(2000);
  });

  it("bumps the generator version for the new layout", () => {
    expect(INVOICE_PDF_GENERATOR_VERSION).toBe(4);
  });
});

describe("invoice header setting (#780)", () => {
  const settings = { organizationName: "Synthetic Platform Name", invoiceHeaderDepartment: null, invoiceHeaderOrganization: null, invoiceHeaderAddress: null, invoiceHeaderPhone: null };

  it("falls back to the platform organization name when the setting is empty", () => {
    expect(resolveInvoiceHeader(settings)).toEqual({ department: null, organizationName: "Synthetic Platform Name", addressLines: [], phone: null });
    expect(resolveInvoiceHeader({ ...settings, invoiceHeaderOrganization: "   ", invoiceHeaderDepartment: "  ", invoiceHeaderAddress: "\n  \n", invoiceHeaderPhone: " " }))
      .toEqual({ department: null, organizationName: "Synthetic Platform Name", addressLines: [], phone: null });
  });

  it("uses the edited block: department, organization, address lines and phone", () => {
    expect(resolveInvoiceHeader({
      ...settings,
      invoiceHeaderDepartment: " Synthetic Youth Department ",
      invoiceHeaderOrganization: "Synthetic Test Conference",
      invoiceHeaderAddress: "100 Example Road\r\n\r\nSampletown, ZZ 00000",
      invoiceHeaderPhone: "555-0100",
    })).toEqual({ department: "Synthetic Youth Department", organizationName: "Synthetic Test Conference", addressLines: ["100 Example Road", "Sampletown, ZZ 00000"], phone: "555-0100" });
  });

  it("keeps the organization name when only some parts are set", () => {
    expect(resolveInvoiceHeader({ ...settings, invoiceHeaderPhone: "555-0100" })).toMatchObject({ organizationName: "Synthetic Platform Name", phone: "555-0100" });
  });
});

describe("bill-to address (#780)", () => {
  it("prints the street and the city, state and postal code", () => {
    expect(billToAddressLines({ streetAddress: "200 Sample Street", city: "Exampleville", state: "ZZ", postalCode: "11111" })).toEqual(["200 Sample Street", "Exampleville, ZZ 11111"]);
  });

  it("omits any line or part that is missing", () => {
    expect(billToAddressLines({ streetAddress: null, city: "Exampleville", state: "ZZ", postalCode: "11111" })).toEqual(["Exampleville, ZZ 11111"]);
    expect(billToAddressLines({ streetAddress: "200 Sample Street", city: null, state: null, postalCode: null })).toEqual(["200 Sample Street"]);
    expect(billToAddressLines({ streetAddress: "200 Sample Street", city: "Exampleville", state: null, postalCode: null })).toEqual(["200 Sample Street", "Exampleville"]);
    expect(billToAddressLines({ streetAddress: "  ", city: null, state: "ZZ", postalCode: null })).toEqual(["ZZ"]);
    expect(billToAddressLines({ streetAddress: null, city: null, state: null, postalCode: null })).toEqual([]);
  });
});
