/**
 * The public conference calendar (#107). Everything here is pure: the
 * repository hands in published events and entries, and these functions lay
 * them out by calendar date in the conference's time zone.
 */

export const CONFERENCE_TIME_ZONE = "America/Chicago";

export type CalendarItemStatus = "SCHEDULED" | "POSTPONED" | "CANCELLED";

export type CalendarItem = {
  /** Unique across both kinds, e.g. `event-abc` or `entry-xyz`. */
  key: string;
  kind: "EVENT" | "ENTRY";
  title: string;
  description: string;
  /** Inclusive calendar dates, YYYY-MM-DD. */
  startsOn: string;
  endsOn: string;
  timeLabel: string;
  location: string;
  category: string;
  /** Where the item links: an event page on this site, or an entry's own link. */
  href: string | null;
  status: CalendarItemStatus;
  /** Only for events: whether registration is open right now. */
  registrationOpen: boolean;
};

export type CalendarMonth = { year: number; month: number };

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export function isCalendarDate(value: string) {
  if (!datePattern.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function calendarDateIn(date: Date, timeZone = CONFERENCE_TIME_ZONE) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function toDate(calendarDate: string) {
  const [year, month, day] = calendarDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function fromDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

export function addDays(calendarDate: string, days: number) {
  const date = toDate(calendarDate);
  date.setUTCDate(date.getUTCDate() + days);
  return fromDate(date);
}

export function monthKey({ year, month }: CalendarMonth) {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** `?month=2026-12`, falling back to the month containing `today`. */
export function parseMonthParam(value: string | undefined, today: string): CalendarMonth {
  const match = value?.match(/^(\d{4})-(\d{2})$/);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (year >= 2000 && year <= 2100 && month >= 1 && month <= 12) return { year, month };
  }
  const [year, month] = today.split("-").map(Number);
  return { year, month };
}

export function shiftMonth({ year, month }: CalendarMonth, delta: number): CalendarMonth {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

export function firstOfMonth(month: CalendarMonth) {
  return `${monthKey(month)}-01`;
}

export function lastOfMonth(month: CalendarMonth) {
  return addDays(firstOfMonth(shiftMonth(month, 1)), -1);
}

/** Whole weeks, Sunday first, covering the month. Days outside it are included to fill the grid. */
export function monthGrid(month: CalendarMonth) {
  const first = firstOfMonth(month);
  const last = lastOfMonth(month);
  let cursor = addDays(first, -toDate(first).getUTCDay());
  const end = addDays(last, 6 - toDate(last).getUTCDay());
  const weeks: string[][] = [];
  while (cursor <= end) {
    const week: string[] = [];
    for (let day = 0; day < 7; day += 1) {
      week.push(cursor);
      cursor = addDays(cursor, 1);
    }
    weeks.push(week);
  }
  return weeks;
}

export function sortCalendarItems(items: CalendarItem[]) {
  return [...items].sort((a, b) =>
    a.startsOn.localeCompare(b.startsOn) || a.endsOn.localeCompare(b.endsOn) || a.title.localeCompare(b.title));
}

export function itemsOnDate(items: CalendarItem[], date: string) {
  return items.filter((item) => item.startsOn <= date && item.endsOn >= date);
}

export function itemsOverlapping(items: CalendarItem[], from: string, to: string) {
  return sortCalendarItems(items.filter((item) => item.startsOn <= to && item.endsOn >= from));
}

export function calendarCategories(items: CalendarItem[]) {
  return [...new Set(items.map((item) => item.category.trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

export function filterByCategory(items: CalendarItem[], category: string | undefined) {
  if (!category) return items;
  const wanted = category.toLowerCase();
  return items.filter((item) => item.category.toLowerCase() === wanted);
}

const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function monthLabel({ year, month }: CalendarMonth) {
  return `${monthNames[month - 1]} ${year}`;
}

/** "December 5, 2026", "December 5–7, 2026", "Dec 30, 2026 – Jan 2, 2027". */
export function formatDateRange(startsOn: string, endsOn: string) {
  const [startYear, startMonth, startDay] = startsOn.split("-").map(Number);
  const [endYear, endMonth, endDay] = endsOn.split("-").map(Number);
  if (startsOn === endsOn) return `${monthNames[startMonth - 1]} ${startDay}, ${startYear}`;
  if (startYear === endYear && startMonth === endMonth) {
    return `${monthNames[startMonth - 1]} ${startDay}–${endDay}, ${startYear}`;
  }
  if (startYear === endYear) {
    return `${monthNames[startMonth - 1]} ${startDay} – ${monthNames[endMonth - 1]} ${endDay}, ${startYear}`;
  }
  return `${monthNames[startMonth - 1].slice(0, 3)} ${startDay}, ${startYear} – ${monthNames[endMonth - 1].slice(0, 3)} ${endDay}, ${endYear}`;
}

/** A one-day event's hours in its own time zone ("9:00 AM – 5:00 PM CST"); multi-day events show dates only. */
export function eventTimeLabel(startsAt: Date, endsAt: Date, timeZone: string) {
  if (calendarDateIn(startsAt, timeZone) !== calendarDateIn(endsAt, timeZone)) return "";
  const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
  const zone = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
    .formatToParts(startsAt).find((part) => part.type === "timeZoneName")?.value ?? "";
  return `${time.format(startsAt)} – ${time.format(endsAt)}${zone ? ` ${zone}` : ""}`;
}

export const calendarStatusLabels: Record<CalendarItemStatus, string> = {
  SCHEDULED: "Scheduled",
  POSTPONED: "Postponed",
  CANCELLED: "Cancelled",
};

function escapeIcsText(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/([,;])/g, "\\$1");
}

/** RFC 5545 folds content lines longer than 75 octets. */
function foldIcsLine(line: string) {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let size = 0;
  for (const character of line) {
    const width = encoder.encode(character).length;
    if (size + width > (parts.length === 0 ? 75 : 74)) {
      parts.push(current);
      current = "";
      size = 0;
    }
    current += character;
    size += width;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

function icsStamp(date: Date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** A subscribable iCalendar feed of all-day items. */
export function buildCalendarIcs(items: CalendarItem[], options: { baseUrl: string; now: Date }) {
  const base = options.baseUrl.replace(/\/$/, "");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//IMSDA//Events calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:IMSDA conference calendar",
    `X-WR-TIMEZONE:${CONFERENCE_TIME_ZONE}`,
  ];
  for (const item of sortCalendarItems(items)) {
    const url = item.href ? (item.href.startsWith("/") ? `${base}${item.href}` : item.href) : null;
    const details = [item.timeLabel, item.description].filter(Boolean).join("\n\n");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${item.key}@imsda-events`,
      `DTSTAMP:${icsStamp(options.now)}`,
      `DTSTART;VALUE=DATE:${item.startsOn.replace(/-/g, "")}`,
      `DTEND;VALUE=DATE:${addDays(item.endsOn, 1).replace(/-/g, "")}`,
      `SUMMARY:${escapeIcsText(item.status === "POSTPONED" ? `Postponed: ${item.title}` : item.title)}`,
      `STATUS:${item.status === "CANCELLED" ? "CANCELLED" : item.status === "POSTPONED" ? "TENTATIVE" : "CONFIRMED"}`,
    );
    if (item.location) lines.push(`LOCATION:${escapeIcsText(item.location)}`);
    if (details) lines.push(`DESCRIPTION:${escapeIcsText(details)}`);
    if (item.category) lines.push(`CATEGORIES:${escapeIcsText(item.category)}`);
    if (url) lines.push(`URL:${url}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(foldIcsLine).join("\r\n")}\r\n`;
}
