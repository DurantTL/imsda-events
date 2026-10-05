/**
 * The PDF of a finalized invoice version (#168).
 *
 * Built from the version's immutable snapshot and the few fixed facts passed in (never from live data), so the
 * same input is the same bytes: no random ids, no clock (the creation and modification dates are the
 * finalization time), the standard Helvetica fonts, no object streams. The repository still stores the first
 * rendering and serves those bytes for every later send and download, so a resend can never differ; this
 * determinism is what lets a test, or an auditor, regenerate the document and compare hashes.
 *
 * pdf-lib is pure JavaScript (no native code and no headless browser). Text outside the standard fonts'
 * Latin character set is replaced with "?" rather than failing a send.
 *
 * Layout version 4 (#780) follows the conference's sample invoice: the editable header block, Bill To with the
 * church's address, the invoice number, date and event, an Item / Description / Qty / Rate / Amount table grouped
 * under the club type, and Total, Payments/Credits and Balance Due at the foot. No confirmation code and no promo
 * code is ever printed.
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { InvoiceSnapshot } from "@/modules/invoices/domain";
import type { InvoiceHeader, InvoiceLayout } from "@/modules/invoices/invoice-layout";

export type InvoicePdfInput = {
  /** The editable header block (#780), already resolved: the platform organization name stands in when the setting is empty. */
  header: InvoiceHeader;
  number: string;
  /** The version's finalization time: the issue date, and the document's creation date. */
  issuedAt: Date;
  /** The event's own time zone, so the issue date reads as it did to staff. */
  timezone: string;
  /** The number of the version this one replaces, for a revision. */
  supersedesNumber: string | null;
  /** The billing contact as it was when the version was finalized. */
  contact: { name: string; email: string; roleLabel: string } | null;
  organizationName: string;
  /** The billed church's address lines (street, then "City, ST 12345"); missing parts are already left out. */
  billToAddressLines: string[];
  groupTitle: string;
  snapshot: InvoiceSnapshot;
  /** The line-item table and the footer totals (#780). */
  layout: InvoiceLayout;
  paymentInstructions: string;
};

const PAGE = { width: 612, height: 792 } as const;
const MARGIN = 54;
const TEXT = rgb(0.1, 0.12, 0.14);
const MUTED = rgb(0.38, 0.42, 0.45);
const RULE = rgb(0.8, 0.84, 0.86);

export function formatPdfMoney(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function formatIssueDate(date: Date, timezone: string) {
  const options = { year: "numeric", month: "long", day: "numeric" } as const;
  try {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: timezone }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(date);
  }
}

class Writer {
  pages: PDFPage[] = [];
  page!: PDFPage;
  y = 0;
  private readonly allowed: Set<number>;

  constructor(private readonly doc: PDFDocument, readonly regular: PDFFont, readonly bold: PDFFont) {
    this.allowed = new Set(regular.getCharacterSet());
    this.newPage();
  }

  newPage() {
    this.page = this.doc.addPage([PAGE.width, PAGE.height]);
    this.pages.push(this.page);
    this.y = PAGE.height - MARGIN;
  }

  /** Replaces anything the standard font cannot draw, and collapses line breaks and tabs. */
  clean(text: string) {
    return [...text.replace(/[\r\n\t]+/g, " ")].map((character) => (this.allowed.has(character.codePointAt(0)!) ? character : "?")).join("");
  }

  ensure(height: number) {
    if (this.y - height < MARGIN + 24) this.newPage();
  }

  wrap(text: string, font: PDFFont, size: number, width: number) {
    const lines: string[] = [];
    for (const paragraph of text.split(/\r?\n/)) {
      const words = this.clean(paragraph).split(" ").filter(Boolean);
      let current = "";
      for (const word of words) {
        const attempt = current ? `${current} ${word}` : word;
        if (font.widthOfTextAtSize(attempt, size) <= width) {
          current = attempt;
          continue;
        }
        if (current) lines.push(current);
        // A single word wider than the line is broken by characters.
        let rest = word;
        while (font.widthOfTextAtSize(rest, size) > width && rest.length > 1) {
          // Binary search for the longest prefix that fits, so a very long unbroken word costs O(n log n), not O(n^2).
          let low = 1;
          let high = rest.length - 1;
          while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (font.widthOfTextAtSize(rest.slice(0, middle), size) <= width) low = middle;
            else high = middle - 1;
          }
          const cut = low;
          lines.push(rest.slice(0, cut));
          rest = rest.slice(cut);
        }
        current = rest;
      }
      lines.push(current);
    }
    return lines;
  }

  text(text: string, options: { x?: number; size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; width?: number; lead?: number } = {}) {
    const size = options.size ?? 10;
    const font = options.font ?? this.regular;
    const x = options.x ?? MARGIN;
    const width = options.width ?? PAGE.width - MARGIN - x;
    const lead = options.lead ?? size + 4;
    for (const line of this.wrap(text, font, size, width)) {
      this.ensure(lead);
      this.page.drawText(line, { x, y: this.y - size, size, font, color: options.color ?? TEXT });
      this.y -= lead;
    }
  }

  /** Right-aligned text on the current baseline row, at the right margin. */
  right(text: string, options: { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; rightEdge?: number; y?: number } = {}) {
    const size = options.size ?? 10;
    const font = options.font ?? this.regular;
    const cleaned = this.clean(text);
    const edge = options.rightEdge ?? PAGE.width - MARGIN;
    this.page.drawText(cleaned, { x: edge - font.widthOfTextAtSize(cleaned, size), y: (options.y ?? this.y) - size, size, font, color: options.color ?? TEXT });
  }

  rule(gap = 6) {
    this.ensure(gap * 2);
    this.y -= gap;
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: PAGE.width - MARGIN, y: this.y }, thickness: 0.6, color: RULE });
    this.y -= gap;
  }

  gap(height: number) {
    this.y -= height;
  }
}

/** Renders the invoice. The same input always yields the same bytes. */
export async function renderInvoicePdf(input: InvoicePdfInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setTitle(`Invoice ${input.number}`);
  doc.setSubject(`Invoice for ${input.organizationName}`);
  doc.setAuthor(input.header.organizationName);
  doc.setCreator("IMSDA Events");
  doc.setProducer("IMSDA Events");
  doc.setCreationDate(input.issuedAt);
  doc.setModificationDate(input.issuedAt);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const w = new Writer(doc, regular, bold);
  const { layout } = input;

  // Header block: the editable sender (department, organization, address, phone) on the left, the title and number on the right.
  const { header } = input;
  if (header.department) w.text(header.department, { size: 11, font: bold, width: 330, lead: 15 });
  w.text(header.organizationName, { size: header.department ? 12 : 16, font: bold, width: 330, lead: header.department ? 16 : 20 });
  for (const addressLine of header.addressLines) w.text(addressLine, { size: 9, color: MUTED, width: 330, lead: 12 });
  if (header.phone) w.text(header.phone, { size: 9, color: MUTED, width: 330, lead: 12 });
  const afterHeader = w.y;
  w.y = PAGE.height - MARGIN;
  w.right("INVOICE", { size: 20, font: bold });
  w.right(input.number, { size: 11, font: bold, y: PAGE.height - MARGIN - 26 });
  w.y = Math.min(afterHeader, PAGE.height - MARGIN - 44);
  w.rule(8);

  // Bill To (the church's name and the address lines it has) beside the invoice meta.
  const metaX = 330;
  const blockTop = w.y;
  w.text("BILL TO", { size: 8, font: bold, color: MUTED, width: 250, lead: 12 });
  w.text(input.organizationName, { size: 11, font: bold, width: 250, lead: 15 });
  for (const addressLine of input.billToAddressLines) w.text(addressLine, { size: 10, width: 250, lead: 13 });
  if (input.groupTitle && input.groupTitle !== input.organizationName) w.text(input.groupTitle, { size: 9, color: MUTED, width: 250, lead: 12 });
  if (input.contact) w.text(`Attn: ${input.contact.name}${input.contact.roleLabel ? `, ${input.contact.roleLabel}` : ""}`, { size: 9, color: MUTED, width: 250, lead: 12 });
  if (input.contact) w.text(input.contact.email, { size: 9, color: MUTED, width: 250, lead: 12 });
  const afterBillTo = w.y;

  w.y = blockTop;
  const meta = (label: string, value: string, options: { bold?: boolean } = {}) => {
    const lines = w.wrap(value, options.bold ? bold : regular, 10, PAGE.width - MARGIN - (metaX + 84));
    w.page.drawText(w.clean(label), { x: metaX, y: w.y - 10, size: 10, font: regular, color: MUTED });
    for (const line of lines) {
      w.page.drawText(line, { x: metaX + 84, y: w.y - 10, size: 10, font: options.bold ? bold : regular, color: TEXT });
      w.y -= 14;
    }
  };
  meta("Invoice no.", input.number, { bold: true });
  meta("Invoice date", formatIssueDate(input.issuedAt, input.timezone));
  meta("Event", input.snapshot.event.name);
  if (input.supersedesNumber) meta("Supersedes", input.supersedesNumber);
  w.y = Math.min(w.y, afterBillTo);
  w.gap(6);
  w.rule(4);

  // The line-item table: Item / Description / Qty / Rate / Amount.
  const amountEdge = PAGE.width - MARGIN;
  const rateEdge = amountEdge - 78;
  const qtyEdge = rateEdge - 72;
  const descriptionX = MARGIN + 122;
  const itemWidth = 114;
  const descriptionWidth = qtyEdge - 34 - descriptionX;
  const tableHeader = () => {
    w.ensure(22);
    w.page.drawText("Item", { x: MARGIN, y: w.y - 9, size: 9, font: bold, color: MUTED });
    w.page.drawText("Description", { x: descriptionX, y: w.y - 9, size: 9, font: bold, color: MUTED });
    w.right("Qty", { size: 9, font: bold, color: MUTED, rightEdge: qtyEdge, y: w.y });
    w.right("Rate", { size: 9, font: bold, color: MUTED, rightEdge: rateEdge, y: w.y });
    w.right("Amount", { size: 9, font: bold, color: MUTED, rightEdge: amountEdge, y: w.y });
    w.y -= 16;
  };
  /** Makes room for a block, repeating the column headings when it starts a new page. */
  const room = (height: number) => {
    if (w.y - height < MARGIN + 24) {
      w.newPage();
      tableHeader();
    }
  };
  tableHeader();
  if (layout.groups.length === 0) w.text("No registrations are on this invoice.", { color: MUTED });
  for (const group of layout.groups) {
    room(40);
    w.text(group.heading, { size: 10, font: bold, lead: 16 });
    for (const row of group.rows) {
      const itemLines = w.wrap(row.item, regular, 10, itemWidth);
      const descriptionLines = w.wrap(row.description, regular, 10, descriptionWidth);
      const rowLines = Math.max(itemLines.length, descriptionLines.length, 1);
      room(rowLines * 13 + 4);
      const top = w.y;
      itemLines.forEach((line, index) => w.page.drawText(line, { x: MARGIN, y: top - 10 - index * 13, size: 10, font: regular, color: TEXT }));
      descriptionLines.forEach((line, index) => w.page.drawText(line, { x: descriptionX, y: top - 10 - index * 13, size: 10, font: regular, color: TEXT }));
      w.right(String(row.quantity), { rightEdge: qtyEdge, y: top });
      w.right(formatPdfMoney(row.rateCents), { rightEdge: rateEdge, y: top });
      w.right(formatPdfMoney(row.amountCents), { rightEdge: amountEdge, y: top });
      w.y -= rowLines * 13 + 4;
    }
    w.rule(2);
  }

  // Footer totals: Total, Payments/Credits, Balance Due.
  w.ensure(96);
  w.gap(6);
  const totalRow = (label: string, cents: number, options: { strong?: boolean } = {}) => {
    const top = w.y;
    const font = options.strong ? bold : regular;
    const size = options.strong ? 12 : 10;
    w.page.drawText(label, { x: rateEdge - 150, y: top - size, size, font, color: TEXT });
    w.right(formatPdfMoney(cents), { size, font, rightEdge: amountEdge, y: top });
    w.y -= options.strong ? 20 : 16;
  };
  totalRow("Total", layout.totalCents);
  totalRow("Payments/Credits", layout.paymentsCreditsCents === 0 ? 0 : -layout.paymentsCreditsCents);
  w.rule(2);
  totalRow("Balance Due", layout.balanceDueCents, { strong: true });
  w.text(`${input.snapshot.totals.billable} billable of ${input.snapshot.totals.registered} registered`, { size: 9, color: MUTED });
  if (layout.totalCents === 0) w.text("Nothing is owed on this invoice.", { size: 9, color: MUTED });

  // Payment
  w.gap(14);
  w.ensure(60);
  w.text("Payment", { size: 11, font: bold });
  w.gap(2);
  w.text(input.paymentInstructions, { size: 10 });
  w.text(`Please include invoice number ${input.number} with your payment.`, { size: 9, color: MUTED });

  // Footers, now the page count is known.
  const total = w.pages.length;
  w.pages.forEach((page, index) => {
    const footer = w.clean(`Invoice ${input.number}  |  Page ${index + 1} of ${total}`);
    page.drawText(footer, { x: MARGIN, y: MARGIN - 8, size: 8, font: regular, color: MUTED });
  });

  return doc.save({ useObjectStreams: false, addDefaultPage: false });
}
