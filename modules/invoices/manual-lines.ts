/**
 * Manual invoice lines (#780): custom lines staff add to a DRAFT before finalizing (patch orders and the like).
 * Pure rules, free of database access. A line is item, description, quantity and rate; it lives on
 * `InvoiceVersion.manualLines`, is included in the version's total and amounts fingerprint, and freezes with the
 * version. The snapshot's own totals stay the reconciliation's; the version's `amountDueCents` is the snapshot's
 * total plus these lines.
 */

import { createHash } from "node:crypto";
import { stableStringify } from "@/modules/attendance-reconciliation/domain";
import type { InvoiceFigures } from "@/modules/invoices/domain";

export const MANUAL_LINES_MAX = 50;
export const MANUAL_ITEM_MAX = 60;
export const MANUAL_DESCRIPTION_MAX = 200;
export const MANUAL_QUANTITY_MAX = 9999;
/** One manual line cannot plausibly exceed this rate; it catches a typed extra zero. */
export const MANUAL_RATE_MAX_CENTS = 10_000_000;

export type ManualInvoiceLine = {
  id: string;
  item: string;
  description: string;
  quantity: number;
  rateCents: number;
  amountCents: number;
};

export type ManualLineInput = { item: string; description?: string | null; quantity: number; rateCents: number };

/** Validates a staff-entered manual line. Quantity is a whole number from 1; the rate is whole cents, not zero, and may be negative (a credit). */
export function normalizeManualLine(input: ManualLineInput, id: string): { ok: true; line: ManualInvoiceLine } | { ok: false; message: string } {
  const item = (input.item ?? "").replace(/\s+/g, " ").trim();
  const description = (input.description ?? "").replace(/\s+/g, " ").trim();
  if (item.length === 0) return { ok: false, message: "Give the line an item name." };
  if (item.length > MANUAL_ITEM_MAX) return { ok: false, message: `Keep the item to ${MANUAL_ITEM_MAX} characters or fewer.` };
  if (description.length > MANUAL_DESCRIPTION_MAX) return { ok: false, message: `Keep the description to ${MANUAL_DESCRIPTION_MAX} characters or fewer.` };
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > MANUAL_QUANTITY_MAX) {
    return { ok: false, message: `Quantity must be a whole number from 1 to ${MANUAL_QUANTITY_MAX}.` };
  }
  if (!Number.isInteger(input.rateCents) || Math.abs(input.rateCents) > MANUAL_RATE_MAX_CENTS || input.rateCents === 0) {
    return { ok: false, message: "Enter a rate in dollars and cents, other than zero." };
  }
  return { ok: true, line: { id, item, description, quantity: input.quantity, rateCents: input.rateCents, amountCents: input.quantity * input.rateCents } };
}

export function manualLinesTotal(lines: readonly ManualInvoiceLine[]) {
  return lines.reduce((total, line) => total + line.amountCents, 0);
}

/** Reads the stored JSON back into lines, dropping anything malformed rather than failing a screen. */
export function parseManualLines(value: unknown): ManualInvoiceLine[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ManualInvoiceLine[] => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.item !== "string" || typeof row.description !== "string") return [];
    if (!Number.isInteger(row.quantity) || !Number.isInteger(row.rateCents) || !Number.isInteger(row.amountCents)) return [];
    return [{ id: row.id, item: row.item, description: row.description, quantity: row.quantity as number, rateCents: row.rateCents as number, amountCents: row.amountCents as number }];
  });
}

/**
 * The amounts fingerprint of a version: the reconciliation figures' fingerprint, plus the manual lines when there are
 * any. With none it is the base fingerprint unchanged, so every invoice made before manual lines existed keeps its
 * fingerprint, and a revision that adds or changes a manual line differs from the version it replaces, which is what
 * makes it need the Finalize invoices permission.
 */
export function fingerprintWithManualLines(baseFingerprint: string, lines: readonly ManualInvoiceLine[]) {
  if (lines.length === 0) return baseFingerprint;
  const projection = lines.map((line) => ({ item: line.item, description: line.description, quantity: line.quantity, rateCents: line.rateCents }));
  return createHash("sha256").update(`${baseFingerprint}|manual|${stableStringify(projection)}`).digest("hex");
}

/** The figures with the version's manual lines folded into the total and the fingerprint. */
export function withManualLines(figures: InvoiceFigures, lines: readonly ManualInvoiceLine[]): InvoiceFigures {
  return { ...figures, amountDueCents: figures.amountDueCents + manualLinesTotal(lines), amountsFingerprint: fingerprintWithManualLines(figures.amountsFingerprint, lines) };
}
