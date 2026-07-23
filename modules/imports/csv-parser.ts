import { createHash } from "node:crypto";
import { z } from "zod";

export const importColumns = [
  "source_id",
  "confirmation_code",
  "first_name",
  "last_name",
  "email",
  "phone",
  "attendee_type",
  "status",
  "total_amount",
  "submitted_at",
] as const;

const requiredColumns = ["source_id", "confirmation_code", "first_name", "last_name", "total_amount"] as const;
const statusSchema = z.enum(["DRAFT", "SUBMITTED", "CONFIRMED", "WAITLISTED", "CANCELLED"]);
const attendeeTypeSchema = z.enum(["ATTENDEE", "WORKER", "CHILD"]);

export class CsvImportError extends Error {
  constructor(public readonly code: "INVALID_CSV" | "MISSING_COLUMNS" | "TOO_MANY_ROWS", message: string) {
    super(message);
    this.name = "CsvImportError";
  }
}

export type NormalizedImportData = {
  sourceId: string;
  confirmationCode: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  attendeeType: "ATTENDEE" | "WORKER" | "CHILD";
  status: "DRAFT" | "SUBMITTED" | "CONFIRMED" | "WAITLISTED" | "CANCELLED";
  totalAmountCents: number;
  submittedAt: string | null;
};

export type ParsedImportRow = {
  sourceRow: number;
  raw: Record<string, string>;
  data: NormalizedImportData | null;
  warnings: string[];
  errors: string[];
};

export function createImportSnapshotIdentity(eventId: string, csvText: string) {
  const checksum = createHash("sha256").update(csvText).digest("hex");
  return { checksum, sourceRunKey: `${eventId}:${checksum}` };
}

function normalizeHeader(value: string) {
  return value.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function parseCsvMatrix(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
    } else if (character === '"' && cell.length === 0) {
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell.replace(/\r$/, ""));
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }

  if (quoted) throw new CsvImportError("INVALID_CSV", "The CSV contains an unterminated quoted field.");
  row.push(cell.replace(/\r$/, ""));
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  if (rows.length === 0) throw new CsvImportError("INVALID_CSV", "The CSV is empty.");
  return rows;
}

function parseMoney(value: string) {
  const cleaned = value.trim().replaceAll("$", "").replaceAll(",", "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(cleaned)) return null;
  const cents = Math.round(Number(cleaned) * 100);
  return Number.isSafeInteger(cents) && cents <= 10_000_000 ? cents : null;
}

function normalizeDate(value: string) {
  if (!value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function parseImportCsv(text: string, maxRows = 2_000): { headers: string[]; rows: ParsedImportRow[] } {
  const matrix = parseCsvMatrix(text);
  const headers = matrix[0].map(normalizeHeader);
  const duplicates = headers.filter((header, index) => headers.indexOf(header) !== index);
  if (duplicates.length > 0) throw new CsvImportError("INVALID_CSV", `Duplicate CSV column: ${duplicates[0]}.`);
  const missing = requiredColumns.filter((column) => !headers.includes(column));
  if (missing.length > 0) throw new CsvImportError("MISSING_COLUMNS", `Missing required columns: ${missing.join(", ")}.`);
  if (matrix.length - 1 > maxRows) throw new CsvImportError("TOO_MANY_ROWS", `This file contains more than ${maxRows.toLocaleString()} data rows.`);

  const sourceIds = new Set<string>();
  const confirmationCodes = new Set<string>();
  const rows = matrix.slice(1).map((values, index): ParsedImportRow => {
    const raw = Object.fromEntries(headers.map((header, columnIndex) => [header, values[columnIndex]?.trim() ?? ""]));
    const errors: string[] = [];
    const warnings: string[] = [];
    const sourceId = raw.source_id ?? "";
    const confirmationCode = (raw.confirmation_code ?? "").toUpperCase();
    const firstName = raw.first_name ?? "";
    const lastName = raw.last_name ?? "";
    const email = (raw.email ?? "").toLowerCase();
    const phone = raw.phone ?? "";
    const attendeeTypeResult = attendeeTypeSchema.safeParse((raw.attendee_type || "ATTENDEE").toUpperCase());
    const statusResult = statusSchema.safeParse((raw.status || "SUBMITTED").toUpperCase());
    const totalAmountCents = parseMoney(raw.total_amount ?? "");
    const submittedAt = normalizeDate(raw.submitted_at ?? "");

    if (!sourceId) errors.push("source_id is required.");
    else if (sourceIds.has(sourceId)) errors.push(`Duplicate source_id: ${sourceId}.`);
    else sourceIds.add(sourceId);
    if (!confirmationCode) errors.push("confirmation_code is required.");
    else if (confirmationCodes.has(confirmationCode)) errors.push(`Duplicate confirmation_code: ${confirmationCode}.`);
    else confirmationCodes.add(confirmationCode);
    if (!firstName) errors.push("first_name is required.");
    if (!lastName) errors.push("last_name is required.");
    if (email && !z.email().safeParse(email).success) errors.push("email is not valid.");
    if (!email) warnings.push("No email is available for identity matching.");
    if (!attendeeTypeResult.success) errors.push("attendee_type must be ATTENDEE, WORKER, or CHILD.");
    if (!statusResult.success) errors.push("status is not supported.");
    if (totalAmountCents === null) errors.push("total_amount must be a non-negative amount with no more than two decimals.");
    if (submittedAt === undefined) errors.push("submitted_at is not a valid date.");

    const data = errors.length === 0 && attendeeTypeResult.success && statusResult.success && totalAmountCents !== null && submittedAt !== undefined
      ? {
          sourceId,
          confirmationCode,
          firstName,
          lastName,
          email,
          phone,
          attendeeType: attendeeTypeResult.data,
          status: statusResult.data,
          totalAmountCents,
          submittedAt,
        }
      : null;
    return { sourceRow: index + 2, raw, data, warnings, errors };
  });

  return { headers, rows };
}
