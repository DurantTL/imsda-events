import { createHash } from "node:crypto";
import { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { describe, expect, it } from "vitest";

/**
 * #168: the invoice PDF is made from the finalized snapshot only and is deterministic, so the same version always
 * yields the same bytes. Text is read back out of the PDF's content streams. Synthetic data only.
 */
import { reconcileEvent, type GroupSource, type PersonSource, type RegistrationSource } from "@/modules/attendance-reconciliation/domain";
import { buildInvoiceFigures } from "@/modules/invoices/domain";
import { buildInvoiceLayout, resolveInvoiceHeader } from "@/modules/invoices/invoice-layout";
import { renderInvoicePdf, type InvoicePdfInput } from "@/modules/invoices/invoice-pdf";

const person = (id: string, checkedIn: boolean): PersonSource => ({
  attendeeId: id, name: `Person ${id}`, checkedIn, correction: null, addedAfterSubmission: false, substituted: false, chargeCents: 2500, lateRate: false, adjustmentCents: 0,
});
const registration = (id: string, club: string, people: PersonSource[], extras: Partial<RegistrationSource> = {}): RegistrationSource => ({
  registrationId: id, confirmationCode: `C-${id}`, status: "CONFIRMED", label: club, clubId: `club-${club}`, locationId: null, locationName: null,
  estimatedCents: people.length * 2500, people, registrationCharges: [], credits: [], promo: null, review: null, registrationAdjustmentCents: 0, hasPriceLines: true,
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

const header = resolveInvoiceHeader({
  organizationName: "Synthetic Conference",
  invoiceHeaderDepartment: "Synthetic Youth Department",
  invoiceHeaderOrganization: "Synthetic Test Conference",
  invoiceHeaderAddress: "100 Example Road\nSampletown, ZZ 00000",
  invoiceHeaderPhone: "555-0100",
});

const baseInput = (overrides: Partial<InvoicePdfInput> = {}): InvoicePdfInput => {
  const input = baseInputWithoutLayout(overrides);
  const layout = overrides.layout ?? buildInvoiceLayout({ snapshot: input.snapshot, manualLines: [], clubType: "Pathfinders", paymentsCreditsCents: 0 });
  return { ...input, layout };
};

const baseInputWithoutLayout = (overrides: Partial<InvoicePdfInput> = {}): InvoicePdfInput => ({
  header,
  billToAddressLines: ["200 Sample Street", "Exampleville, ZZ 11111"],
  layout: undefined as never,
  number: "SC27-0001",
  issuedAt: new Date("2027-04-12T15:30:00Z"),
  timezone: "America/Chicago",
  supersedesNumber: null,
  contact: { name: "Tess Treasurer", email: "tess@church-one.test", roleLabel: "Treasurer" },
  organizationName: "Church One",
  groupTitle: "Church One",
  snapshot: snapshotFor([
    registration("r1", "Eagles", [person("a", true), person("b", true), person("c", false)], { credits: [{ key: "meals", label: "Meal sponsorship", centsPerUnit: -500, rawUnits: 2, capAtHeadcount: false, recordedCents: -1000 }] }),
    registration("r2", "Hawks", [person("d", true)]),
  ]),
  paymentInstructions: "Please remit by check to the Synthetic Conference.",
  ...overrides,
});

const withSnapshot = (snapshot: ReturnType<typeof snapshotFor>) => baseInput({ snapshot, layout: buildInvoiceLayout({ snapshot, manualLines: [], clubType: "Pathfinders", paymentsCreditsCents: 0 }) });

/** Every shown string in every page's content stream (pdf-lib writes them as hex or literal strings). */
async function pdfText(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const texts: string[] = [];
  const perPage: string[][] = [];
  for (const page of doc.getPages()) {
    const before = texts.length;
    const contents = page.node.Contents();
    const streams = contents ? [contents] : [];
    const array = page.node.get(PDFName.of("Contents"));
    const resolved = array ? doc.context.lookup(array) : undefined;
    const refs = resolved && "asArray" in resolved ? (resolved as unknown as { asArray(): unknown[] }).asArray().map((entry) => doc.context.lookup(entry as never)) : [];
    for (const stream of [...streams, ...refs]) {
      if (!(stream instanceof PDFRawStream)) continue;
      const decoded = Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1");
      for (const match of decoded.matchAll(/<([0-9A-Fa-f]+)>\s*Tj|\(((?:\\.|[^\\)])*)\)\s*Tj/g)) {
        texts.push(match[1] ? Buffer.from(match[1], "hex").toString("latin1") : match[2]!);
      }
    }
    perPage.push(texts.slice(before));
  }
  return { perPage, texts, text: texts.join("\n"), pages: doc.getPageCount(), doc };
}

describe("invoice PDF (#168)", () => {
  it("is deterministic: the same input always yields the same bytes", async () => {
    const first = await renderInvoicePdf(baseInput());
    const second = await renderInvoicePdf(baseInput());
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
    expect(createHash("sha256").update(first).digest("hex")).toBe(createHash("sha256").update(second).digest("hex"));
    expect(Buffer.from(first).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("stamps the issue date as its creation date and carries no clock", async () => {
    const { doc } = await pdfText(await renderInvoicePdf(baseInput()));
    expect(doc.getCreationDate()?.toISOString()).toBe("2027-04-12T15:30:00.000Z");
    expect(doc.getModificationDate()?.toISOString()).toBe("2027-04-12T15:30:00.000Z");
  });

  it("shows the header, number, issue date, event, billed-to church, snapshot contact, lines, total and payment text", async () => {
    const { text } = await pdfText(await renderInvoicePdf(baseInput()));
    for (const expected of [
      "Synthetic Youth Department", "Synthetic Test Conference", "100 Example Road", "Sampletown, ZZ 00000", "555-0100",
      "BILL TO", "Church One", "200 Sample Street", "Exampleville, ZZ 11111", "Attn: Tess Treasurer, Treasurer", "tess@church-one.test",
      "SC27-0001", "April 12, 2027", "Spring Camporee 2027",
      "Item", "Description", "Qty", "Rate", "Amount", "Pathfinders", "Eagles", "Hawks", "Attended", "Total", "Payments/Credits", "Balance Due",
      "Please remit by check to the Synthetic Conference.",
    ]) {
      expect(text).toContain(expected);
    }
    expect(text).toContain("Credit: Meal sponsorship");
    expect(text).not.toContain("Supersedes");
  });

  it("names the invoice it replaces on a revision", async () => {
    const { text } = await pdfText(await renderInvoicePdf(baseInput({ number: "SC27-0001-R1", supersedesNumber: "SC27-0001" })));
    expect(text).toContain("Supersedes");
    expect(text).toContain("SC27-0001-R1");
    expect(text).toContain("SC27-0001");
  });

  it("changes when the snapshot, the contact or the payment text changes, but not on a second render", async () => {
    const original = createHash("sha256").update(await renderInvoicePdf(baseInput())).digest("hex");
    const otherContact = createHash("sha256").update(await renderInvoicePdf(baseInput({ contact: { name: "Other Person", email: "other@church-one.test", roleLabel: "Clerk" } }))).digest("hex");
    const otherText = createHash("sha256").update(await renderInvoicePdf(baseInput({ paymentInstructions: "Pay at the office." }))).digest("hex");
    expect(new Set([original, otherContact, otherText]).size).toBe(3);
  });

  it("replaces characters the standard font cannot draw instead of failing", async () => {
    const { text } = await pdfText(await renderInvoicePdf(baseInput({ organizationName: "Église 福音 Church", groupTitle: "Église 福音 Church" })));
    expect(text).toContain("?");
    expect(text).toContain("glise");
  });

  it("flows a long invoice onto more pages with a footer on each", async () => {
    const many = Array.from({ length: 45 }, (_, index) => registration(`m${index}`, `Club ${index}`, [person(`p${index}`, true)]));
    const { pages, text } = await pdfText(await renderInvoicePdf(withSnapshot(snapshotFor(many))));
    expect(pages).toBeGreaterThan(1);
    expect(text).toContain(`Page 1 of ${pages}`);
    expect(text).toContain(`Page ${pages} of ${pages}`);
  });

  it("never prints a registration's confirmation code (it opens the registration with a contact email)", async () => {
    const input = baseInput();
    const { text } = await pdfText(await renderInvoicePdf(input));
    for (const line of input.snapshot.lines) expect(text).not.toContain(line.confirmationCode);
    expect(text).not.toMatch(/Confirmation/);
  });

  it("prints the club-type heading, the manual lines, the payments and the balance from the layout", async () => {
    const snapshot = baseInput().snapshot;
    const layout = buildInvoiceLayout({
      snapshot,
      manualLines: [{ id: "m1", item: "Patch order", description: "Camporee patches", quantity: 12, rateCents: 450, amountCents: 5400 }],
      clubType: "Pathfinders",
      paymentsCreditsCents: 2000,
    });
    const { text } = await pdfText(await renderInvoicePdf(baseInput({ layout })));
    expect(text).toContain("Patch order");
    expect(text).toContain("Camporee patches");
    expect(text).toContain("$54.00");
    expect(text).toContain("-$20.00");
    expect(text).toContain(`$${((layout.totalCents - 2000) / 100).toFixed(2)}`);
  });

  it("keeps each extra line's label and amount on the same page when the extras run across a page break", async () => {
    const credit = (index: number) => ({ key: `c${index}`, label: `Meal credit ${index}`, centsPerUnit: -100, rawUnits: 1, capAtHeadcount: false, recordedCents: -100 });
    const many = Array.from({ length: 14 }, (_, index) => registration(`x${index}`, `Club ${index}`, [person(`q${index}`, true), person(`z${index}`, true)], { credits: [credit(1), credit(2), credit(3), credit(4)] }));
    const { perPage } = await pdfText(await renderInvoicePdf(withSnapshot(snapshotFor(many))));
    expect(perPage.length).toBeGreaterThan(1);
    for (const page of perPage) {
      // Each credit row prints its rate and its amount, both negative, and a row is never split across pages.
      expect(page.filter((entry) => entry.startsWith("Credit:")).length * 2).toBe(page.filter((entry) => /^-\$\d/.test(entry)).length);
    }
  });

  it("breaks a very long unbroken word without stalling", async () => {
    const started = Date.now();
    const { text } = await pdfText(await renderInvoicePdf(baseInput({ organizationName: "A".repeat(20000), groupTitle: "A".repeat(20000) })));
    expect(text).toContain("AAAA");
    expect(Date.now() - started).toBeLessThan(15000);
  });

  it("prints a promo discount without the (possibly private) promo code", async () => {
    const withPromo = registration("pr", "Eagles", [person("a", true), person("b", true)], { promo: { code: "SECRETCODE25", type: "FIXED_CENTS", value: 500, maximumDiscountCents: null, recordedCents: 500 } });
    const { text } = await pdfText(await renderInvoicePdf(withSnapshot(snapshotFor([withPromo]))));
    expect(text).toContain("Promo discount");
    expect(text).not.toContain("SECRETCODE25");
  });
});
