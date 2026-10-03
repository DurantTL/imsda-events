import { parseCalendarDate } from "@/modules/club-rosters/domain";

/** The guidance shown under a date question (#743). Dates are stored as YYYY-MM-DD. */
export const TYPED_DATE_GUIDANCE = "Type the date as M/D/YYYY, or use the calendar button.";

/**
 * Reads a date a person typed or pasted as M/D/YYYY (or already as
 * YYYY-MM-DD) into the stored ISO form, or null when it is not a real
 * calendar date. Years need all four digits, so "4/10/26" is never guessed.
 */
export function parseTypedDate(text: string): string | null {
  const trimmed = text.trim();
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  let year: number;
  let month: number;
  let day: number;
  if (us) {
    month = Number(us[1]);
    day = Number(us[2]);
    year = Number(us[3]);
  } else if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else {
    return null;
  }
  const value = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return parseCalendarDate(value) ? value : null;
}

/** "2026-04-10" -> "4/10/2026"; anything else comes back empty. */
export function formatTypedDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return match ? `${Number(match[2])}/${Number(match[3])}/${match[1]}` : "";
}
