import { CsvImportError } from "@/modules/imports/csv-parser";
import type { Wr26BundleFile } from "@/modules/imports/wr26-bundle";

// Candidate tab names per WR26 bundle sheet. wr26-bundle's own sheetKey()
// normalization (lowercase, strip non-alphanumerics) means any of these
// spellings resolve to the same canonical sheet once fetched.
const TAB_CANDIDATES: Record<string, string[]> = {
  registrations: ["Registrations"],
  attendees: ["Attendees"],
  seminars: ["Seminars"],
  seminarpreferences: ["SeminarPreferences", "Seminar Preferences"],
  waitlist: ["Waitlist"],
  promocodes: ["PromoCodes", "Promo Codes"],
  refunds: ["Refunds"],
  checkins: ["CheckIns", "Check Ins", "Check-Ins"],
  transferlog: ["TransferLog", "Transfer Log"],
};

const REQUIRED_SHEET_KEYS = ["registrations", "attendees"] as const;

const GOOGLE_SHEET_URL_PATTERN = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/;

export function extractGoogleSheetId(url: string) {
  return url.trim().match(GOOGLE_SHEET_URL_PATTERN)?.[1] ?? null;
}

function looksLikeCsv(text: string) {
  const trimmed = text.trimStart().toLowerCase();
  return trimmed.length > 0 && !trimmed.startsWith("<!doctype") && !trimmed.startsWith("<html");
}

async function fetchTab(spreadsheetId: string, tabName: string) {
  const endpoint = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tabName)}`;
  let response: Response;
  try {
    response = await fetch(endpoint, { redirect: "follow" });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const text = await response.text();
  return looksLikeCsv(text) ? text : null;
}

// Reads one shared-view Google Sheet (each WR26 sheet as its own tab) and
// returns it in the same shape the manual multi-CSV WR26 bundle upload uses,
// so both paths share one parser, preview, and commit flow. This is a
// one-time, read-only pull for migrating legacy WR26 registrations into
// IMSDA Events — it never writes back to the sheet.
export async function fetchWr26BundleFromGoogleSheet(url: string): Promise<Wr26BundleFile[]> {
  const spreadsheetId = extractGoogleSheetId(url);
  if (!spreadsheetId) {
    throw new CsvImportError(
      "INVALID_CSV",
      "That doesn't look like a Google Sheets link. Copy the full URL from the address bar.",
    );
  }
  const files: Wr26BundleFile[] = [];
  for (const [key, candidates] of Object.entries(TAB_CANDIDATES)) {
    for (const candidate of candidates) {
      const text = await fetchTab(spreadsheetId, candidate);
      if (text) {
        files.push({ name: `${key}.csv`, text });
        break;
      }
    }
  }
  const foundKeys = new Set(files.map((file) => file.name.replace(/\.csv$/i, "")));
  const missingRequired = REQUIRED_SHEET_KEYS.filter((key) => !foundKeys.has(key));
  if (missingRequired.length > 0) {
    throw new CsvImportError(
      "MISSING_COLUMNS",
      'This Google Sheet needs tabs named "Registrations" and "Attendees", and must be shared as "Anyone with the link can view".',
    );
  }
  return files;
}
