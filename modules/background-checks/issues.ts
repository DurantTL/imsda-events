/**
 * The background-check list's "issues" column (#544, Caleb's decision).
 *
 * The column records a person's overall standing, not only driving:
 * - `BGC`: the background check.
 * - `Training`: the child-protection training videos.
 * - `Non-Driver`: the person may serve but may not drive.
 * - Blank: good standing.
 *
 * Parsed once here and shared by the roster status (`clubComplianceState`),
 * event flags (`backgroundCheckState`), and driver clearance
 * (`modules/driver-verification`). Pure and client-safe: no imports at all,
 * so nothing here can pull `node:` into a browser bundle (#550). The text
 * itself is staff only (#427); what a club may see is a summary state, or
 * an expiry date, never these items.
 *
 * Parsing rules:
 * - Items are separated by commas; empty items are ignored.
 * - Each item is `Non-Driver`, `BGC` or `Training`, in any case and with any
 *   spacing (`non driver`, `NON-DRIVER` and `Non_Driver` are all Non-Driver),
 *   optionally followed by a date in parentheses, `(MM/DD/YY)` or
 *   `(MM/DD/YYYY)`, spaces allowed inside. A two-digit year is 20YY.
 * - An undated `BGC` or `Training` is expired. A dated one lasts through its
 *   date, as a Sterling check does, and is expired the day after.
 * - `Non-Driver` blocks only driving; a date beside it changes nothing.
 * - Any other item, or a date that is not a real calendar date, is
 *   unrecognised. It never changes the overall status, but a driver with
 *   unrecognised text needs staff review.
 */

export type IssueKind = "NON_DRIVER" | "BGC" | "TRAINING";

export type IssueItem = {
  kind: IssueKind;
  /** Calendar date "YYYY-MM-DD", or null when the item carries none. */
  date: string | null;
};

export type ParsedIssues = {
  items: IssueItem[];
  /** Items that matched nothing above, as written (trimmed). */
  unrecognised: string[];
};

const ITEM_PATTERN = /^(non[\s_-]*driver|bgc|training)\s*(?:\(\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{4}|\d{2})\s*\))?$/i;

function calendarDate(month: number, day: number, year: number) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

export function parseIssues(text: string | null | undefined): ParsedIssues {
  const items: IssueItem[] = [];
  const unrecognised: string[] = [];
  for (const raw of (text ?? "").split(",")) {
    const segment = raw.trim();
    if (!segment) continue;
    const match = ITEM_PATTERN.exec(segment);
    if (!match) {
      unrecognised.push(segment);
      continue;
    }
    const name = match[1]!.toLowerCase();
    const kind: IssueKind = name.startsWith("non") ? "NON_DRIVER" : name === "bgc" ? "BGC" : "TRAINING";
    if (match[2] === undefined) {
      items.push({ kind, date: null });
      continue;
    }
    const yearText = match[4]!;
    const year = yearText.length === 2 ? 2000 + Number(yearText) : Number(yearText);
    const date = calendarDate(Number(match[2]), Number(match[3]), year);
    if (date) items.push({ kind, date });
    else unrecognised.push(segment);
  }
  return { items, unrecognised };
}

export type IssuesAssessment = {
  nonDriver: boolean;
  /** `BGC` / `Training` items that are undated or already past their date on `today`, once each. */
  expired: Array<"BGC" | "TRAINING">;
  /** The soonest `BGC` / `Training` date still ahead (today counts), or null. */
  soonest: string | null;
  unrecognised: string[];
};

/** Reads the issues text as of `today` (a calendar date, "YYYY-MM-DD"). */
export function assessIssues(text: string | null | undefined, today: string): IssuesAssessment {
  const { items, unrecognised } = parseIssues(text);
  const expired: Array<"BGC" | "TRAINING"> = [];
  let nonDriver = false;
  let soonest: string | null = null;
  for (const item of items) {
    if (item.kind === "NON_DRIVER") {
      nonDriver = true;
    } else if (item.date === null || item.date < today) {
      if (!expired.includes(item.kind)) expired.push(item.kind);
    } else if (soonest === null || item.date < soonest) {
      soonest = item.date;
    }
  }
  return { nonDriver, expired, soonest, unrecognised };
}

/** "2026-10-04" as "10/04/2026", without a time zone shift. */
export function formatIssueDate(date: string) {
  const [year, month, day] = date.split("-");
  return `${month}/${day}/${year}`;
}

/** Whole days from one calendar date to another. */
export function daysUntil(fromDate: string, toDate: string) {
  return Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000);
}
