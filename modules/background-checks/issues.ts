/**
 * The background-check list's "issues" column (#544, Caleb's decision).
 *
 * The column records a person's overall standing, not only driving:
 * - `BGC`: the background check.
 * - `Training`: the child-protection training videos.
 * - `Non-Driver`: the person may serve but may not drive.
 * - Blank: good standing.
 *
 * Parsed once here so staff can see readable reasons (`describeIssues`)
 * beside the text. The compliance mark (y / ! / n) stays the primary status,
 * exactly as #527 reads it; nothing here changes it. Pure and client-safe:
 * no imports at all, so nothing here can pull `node:` into a browser bundle
 * (#550). The text and the reasons are for system administrators only
 * (#427); a club never sees them.
 *
 * Parsing rules:
 * - Items are separated by commas; empty items are ignored.
 * - Each item is `Non-Driver`, `BGC` or `Training`, in any case and with any
 *   spacing (`non driver`, `NON-DRIVER` and `Non_Driver` are all Non-Driver),
 *   optionally followed by a date in parentheses, `(MM/DD/YY)` or
 *   `(MM/DD/YYYY)`, spaces allowed inside. A two-digit year is 20YY.
 * - An undated `BGC` or `Training` is expired. A dated one lasts through its
 *   date, as a Sterling check does, and is expired the day after.
 * - `Non-Driver` may serve but not drive; a date beside it changes nothing.
 * - Any other item, or a date that is not a real calendar date, is
 *   unrecognised. It is shown as written and never changes the overall status.
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

/**
 * The parsed items as readable reasons for staff, in the order written, as of
 * `today`: "Marked Non-Driver", "Background check expired", "Background check
 * expiring (10/04/2026)", "Child-protection training not completed", and so
 * on. Unrecognised items are left to the text shown beside them.
 */
export function describeIssues(text: string | null | undefined, today: string): string[] {
  return parseIssues(text).items.map((item) => {
    if (item.kind === "NON_DRIVER") return "Marked Non-Driver";
    const subject = item.kind === "BGC" ? "Background check" : "Child-protection training";
    if (item.date === null) return item.kind === "BGC" ? `${subject} expired` : `${subject} not completed`;
    return item.date < today ? `${subject} expired (${formatIssueDate(item.date)})` : `${subject} expiring (${formatIssueDate(item.date)})`;
  });
}

/** "2026-10-04" as "10/04/2026", without a time zone shift. */
export function formatIssueDate(date: string) {
  const [year, month, day] = date.split("-");
  return `${month}/${day}/${year}`;
}
