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
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { InvoiceLine, InvoiceSnapshot } from "@/modules/invoices/domain";

export type InvoicePdfInput = {
  /** The conference's name for the header (the platform organization name). */
  headerName: string;
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
  groupTitle: string;
  snapshot: InvoiceSnapshot;
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
          let cut = rest.length - 1;
          while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > width) cut -= 1;
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

function lineExtras(line: InvoiceLine) {
  const extras: Array<{ label: string; cents: number }> = [];
  for (const charge of line.chargesNotTiedToPerson) {
    extras.push({ label: `${charge.kind === "CREDIT_AS_RECORDED" ? "Credit as recorded" : "Charge"}: ${charge.label}`, cents: charge.amountCents });
  }
  for (const credit of line.credits) {
    extras.push({ label: `Credit: ${credit.label}${credit.units !== null ? ` (${credit.units})` : ""}`, cents: credit.amountCents });
  }
  if (line.promo) extras.push({ label: `Promo code ${line.promo.code}`, cents: line.promo.amountCents });
  if (line.adjustmentCents !== 0) extras.push({ label: "Staff adjustments", cents: line.adjustmentCents });
  return extras;
}

/** Renders the invoice. The same input always yields the same bytes. */
export async function renderInvoicePdf(input: InvoicePdfInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setTitle(`Invoice ${input.number}`);
  doc.setSubject(`Invoice for ${input.organizationName}`);
  doc.setAuthor(input.headerName);
  doc.setCreator("IMSDA Events");
  doc.setProducer("IMSDA Events");
  doc.setCreationDate(input.issuedAt);
  doc.setModificationDate(input.issuedAt);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const w = new Writer(doc, regular, bold);
  const { snapshot } = input;

  // Header
  w.text(input.headerName, { size: 16, font: bold, width: 330, lead: 20 });
  const afterHeader = w.y;
  w.y = PAGE.height - MARGIN;
  w.right("INVOICE", { size: 20, font: bold });
  w.right(input.number, { size: 11, font: bold, y: PAGE.height - MARGIN - 26 });
  w.y = Math.min(afterHeader, PAGE.height - MARGIN - 44);
  w.rule(8);

  // Meta
  const labelX = MARGIN;
  const valueX = MARGIN + 92;
  const meta = (label: string, value: string, options: { bold?: boolean } = {}) => {
    const lines = w.wrap(value, options.bold ? bold : regular, 10, PAGE.width - MARGIN - valueX);
    w.ensure(lines.length * 14);
    w.page.drawText(w.clean(label), { x: labelX, y: w.y - 10, size: 10, font: regular, color: MUTED });
    for (const line of lines) {
      w.page.drawText(line, { x: valueX, y: w.y - 10, size: 10, font: options.bold ? bold : regular, color: TEXT });
      w.y -= 14;
    }
  };
  meta("Invoice number", input.number, { bold: true });
  meta("Issue date", formatIssueDate(input.issuedAt, input.timezone));
  meta("Event", snapshot.event.name);
  meta("Billed to", input.organizationName, { bold: true });
  if (input.groupTitle && input.groupTitle !== input.organizationName) meta("Account", input.groupTitle);
  if (input.contact) {
    meta("Attention", `${input.contact.name}${input.contact.roleLabel ? `, ${input.contact.roleLabel}` : ""}`);
    meta("Billing contact email", input.contact.email);
  }
  if (input.supersedesNumber) meta("Supersedes", input.supersedesNumber);
  w.gap(6);
  w.rule(4);

  // Lines
  const amountEdge = PAGE.width - MARGIN;
  const billableEdge = amountEdge - 96;
  const registeredEdge = billableEdge - 72;
  const tableHeader = () => {
    w.ensure(22);
    w.page.drawText("Registration", { x: MARGIN, y: w.y - 9, size: 9, font: bold, color: MUTED });
    w.right("Registered", { size: 9, font: bold, color: MUTED, rightEdge: registeredEdge, y: w.y });
    w.right("Billable", { size: 9, font: bold, color: MUTED, rightEdge: billableEdge, y: w.y });
    w.right("Amount", { size: 9, font: bold, color: MUTED, rightEdge: amountEdge, y: w.y });
    w.y -= 16;
  };
  tableHeader();
  if (snapshot.lines.length === 0) w.text("No registrations are on this invoice.", { color: MUTED });
  for (const line of snapshot.lines) {
    const labelLines = w.wrap(line.label, bold, 10, registeredEdge - 70 - MARGIN);
    w.ensure(labelLines.length * 14 + 16);
    const top = w.y;
    for (const labelLine of labelLines) {
      w.page.drawText(labelLine, { x: MARGIN, y: w.y - 10, size: 10, font: bold, color: TEXT });
      w.y -= 14;
    }
    w.right(String(line.counts.registered), { rightEdge: registeredEdge, y: top });
    w.right(String(line.counts.billable), { rightEdge: billableEdge, y: top });
    w.right(formatPdfMoney(line.amountCents), { rightEdge: amountEdge, y: top, font: bold });
    w.text(`Confirmation ${line.confirmationCode}`, { size: 8, color: MUTED, x: MARGIN + 8, lead: 11 });
    for (const extra of lineExtras(line)) {
      const extraTop = w.y;
      w.text(extra.label, { size: 9, x: MARGIN + 8, width: billableEdge - MARGIN - 70, lead: 13 });
      w.right(formatPdfMoney(extra.cents), { size: 9, rightEdge: amountEdge, y: extraTop });
    }
    w.gap(4);
    w.rule(2);
  }

  // Total
  w.ensure(60);
  w.gap(4);
  const totalTop = w.y;
  w.page.drawText("Total due", { x: MARGIN, y: totalTop - 12, size: 12, font: bold, color: TEXT });
  w.right(formatPdfMoney(snapshot.totals.amountDueCents), { size: 12, font: bold, rightEdge: amountEdge, y: totalTop - 2 });
  w.y = totalTop - 20;
  w.text(`${snapshot.totals.billable} billable of ${snapshot.totals.registered} registered`, { size: 9, color: MUTED });
  if (snapshot.totals.amountDueCents === 0) w.text("Nothing is owed on this invoice.", { size: 9, color: MUTED });

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
