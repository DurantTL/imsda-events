/**
 * Repeating calendar items (#444). The model is a small, RFC 5545 compatible
 * subset: FREQ (DAILY, WEEKLY, MONTHLY, YEARLY), INTERVAL, BYDAY for weekly
 * weekdays, and an end of UNTIL or COUNT, plus EXDATEs (skipped occurrences).
 * Items are all-day, so occurrences are calendar dates (YYYY-MM-DD) in the
 * calendar's own time zone and are computed with plain calendar arithmetic:
 * a daylight-saving change never moves an all-day date. An import from an ICS
 * feed can map its RRULE/EXDATE straight onto the same `parseRepeatRule`.
 */

export const repeatFrequencies = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"] as const;
export type RepeatFrequency = (typeof repeatFrequencies)[number];

/** Weekdays are 0 = Sunday ... 6 = Saturday. */
export type RepeatRule = {
  frequency: RepeatFrequency;
  interval: number;
  /** Weekly only. Empty means the weekday of the first occurrence. */
  weekdays: number[];
  /** Inclusive last date. At most one of `until` and `count`. */
  until: string | null;
  count: number | null;
  /**
   * First day of the week (WKST): 0 = Sunday, 1 = Monday. It decides which
   * weeks an INTERVAL above 1 skips. The page and the editor use Sunday; an
   * RRULE with no WKST means Monday under RFC 5545, as Google exports assume.
   */
  weekStart: 0 | 1;
};

/** Loop steps taken by the generator, so tests can show a far-off window costs a bounded number. */
export const expansionDiagnostics = { steps: 0 };

export const maxRepeatCount = 500;
export const maxRepeatInterval = 99;
const weekdayCodes = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

function toDate(calendarDate: string) {
  const [year, month, day] = calendarDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function shiftDays(calendarDate: string, days: number) {
  const date = toDate(calendarDate);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string) {
  return Math.round((toDate(b).getTime() - toDate(a).getTime()) / 86_400_000);
}

function pad(value: number, width = 2) {
  return String(value).padStart(width, "0");
}

/** Build a date, or null when the day doesn't exist in that month (Feb 30, Feb 29 of a common year). */
function validDate(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

/** The structured rule as an RRULE value, e.g. `FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=6`. */
export function serializeRepeatRule(rule: RepeatRule) {
  const parts = [`FREQ=${rule.frequency}`];
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.frequency === "WEEKLY" && rule.weekdays.length > 0) {
    const days = [...new Set(rule.weekdays)].sort((a, b) => a - b);
    parts.push(`BYDAY=${days.map((day) => weekdayCodes[day]).join(",")}`);
  }
  if (rule.frequency === "WEEKLY") parts.push(`WKST=${rule.weekStart === 0 ? "SU" : "MO"}`);
  if (rule.until) parts.push(`UNTIL=${rule.until.replace(/-/g, "")}`);
  else if (rule.count) parts.push(`COUNT=${rule.count}`);
  return parts.join(";");
}

/** Reads an RRULE value, or null when it uses anything outside the supported subset. */
export function parseRepeatRule(value: string | null | undefined): RepeatRule | null {
  if (!value) return null;
  const rule: RepeatRule = { frequency: "DAILY", interval: 1, weekdays: [], until: null, count: null, weekStart: 1 };
  let frequency: RepeatFrequency | null = null;
  for (const part of value.replace(/^RRULE:/i, "").split(";")) {
    const [rawKey, rawValue = ""] = part.split("=");
    const key = rawKey.toUpperCase();
    const text = rawValue.toUpperCase();
    if (key === "FREQ") {
      if (!(repeatFrequencies as readonly string[]).includes(text)) return null;
      frequency = text as RepeatFrequency;
    } else if (key === "INTERVAL") {
      const interval = Number(text);
      if (!Number.isInteger(interval) || interval < 1 || interval > maxRepeatInterval) return null;
      rule.interval = interval;
    } else if (key === "COUNT") {
      const count = Number(text);
      if (!Number.isInteger(count) || count < 1 || count > maxRepeatCount) return null;
      rule.count = count;
    } else if (key === "UNTIL") {
      const match = text.match(/^(\d{4})(\d{2})(\d{2})(T\d{6}Z?)?$/);
      if (!match || !validDate(Number(match[1]), Number(match[2]), Number(match[3]))) return null;
      rule.until = `${match[1]}-${match[2]}-${match[3]}`;
    } else if (key === "BYDAY") {
      const days = text.split(",").map((code) => (weekdayCodes as readonly string[]).indexOf(code));
      if (days.some((day) => day < 0)) return null;
      rule.weekdays = [...new Set(days)].sort((a, b) => a - b);
    } else if (key === "WKST") {
      if (text !== "SU" && text !== "MO") return null;
      rule.weekStart = text === "SU" ? 0 : 1;
    } else {
      return null;
    }
  }
  if (!frequency) return null;
  if (rule.until && rule.count) return null;
  if (rule.weekdays.length > 0 && frequency !== "WEEKLY") return null;
  return { ...rule, frequency };
}

/**
 * Start dates of the occurrences in the rule, in order. COUNT counts skipped
 * (EXDATE) occurrences too, as RFC 5545 says. Callers stop reading when they
 * pass the dates they need; `until`, `count` and a 200-year horizon end it.
 *
 * With `skipBefore`, DAILY and WEEKLY rules jump arithmetically (COUNT
 * included) to the period containing that date instead of stepping from the
 * first date, so a window far from the start costs a bounded number of steps.
 * Dates before `skipBefore` may still be yielded; callers filter them.
 */
function* generate(firstStart: string, rule: RepeatRule, skipBefore?: string): Generator<string> {
  const [startYear, startMonth, startDay] = firstStart.split("-").map(Number);
  const horizon = `${startYear + 200}-12-31`;
  const within = (date: string) => date <= horizon && (!rule.until || date <= rule.until);
  let emitted = 0;
  const counted = () => {
    emitted += 1;
    return rule.count === null || emitted <= rule.count;
  };
  const jumpDays = skipBefore && skipBefore > firstStart ? daysBetween(firstStart, skipBefore) : 0;

  if (rule.frequency === "DAILY") {
    const skipped = Math.floor(jumpDays / rule.interval);
    emitted = skipped;
    for (let date = shiftDays(firstStart, skipped * rule.interval); within(date); date = shiftDays(date, rule.interval)) {
      expansionDiagnostics.steps += 1;
      if (!counted()) return;
      yield date;
    }
  } else if (rule.frequency === "WEEKLY") {
    const weekdays = [...(rule.weekdays.length > 0 ? rule.weekdays : [toDate(firstStart).getUTCDay()])].sort((x, y) => x - y);
    // Days of the week in WKST order, so a Sunday BYDAY falls at the end of a Monday-start week.
    const order = weekdays.map((day) => (day - rule.weekStart + 7) % 7).sort((x, y) => x - y);
    const firstOffset = (toDate(firstStart).getUTCDay() - rule.weekStart + 7) % 7;
    const firstWeek = shiftDays(firstStart, -firstOffset);
    const inFirstWeek = order.filter((offset) => offset >= firstOffset).length;
    const stride = 7 * rule.interval;
    // Whole periods skipped (the first week holds fewer occurrences than later ones).
    const skippedWeeks = Math.floor(jumpDays / stride);
    const jumped = skippedWeeks > 0 ? skippedWeeks - 1 : 0;
    // Jump to the week before the target so every date overlapping the window is still reached.
    const startWeek = jumped;
    emitted = startWeek === 0 ? 0 : inFirstWeek + (startWeek - 1) * order.length;
    for (let week = shiftDays(firstWeek, startWeek * stride); within(week); week = shiftDays(week, stride)) {
      expansionDiagnostics.steps += 1;
      for (const offset of order) {
        const date = shiftDays(week, offset);
        if (date < firstStart) continue;
        if (!within(date)) return;
        if (!counted()) return;
        yield date;
      }
    }
  } else if (rule.frequency === "MONTHLY") {
    for (let step = 0; ; step += 1) {
      expansionDiagnostics.steps += 1;
      const index = startYear * 12 + (startMonth - 1) + step * rule.interval;
      if (!within(`${pad(Math.floor(index / 12), 4)}-${pad((index % 12) + 1)}-01`)) return;
      // A day that doesn't exist in the month (the 31st in April) is skipped, not moved.
      const date = validDate(Math.floor(index / 12), (index % 12) + 1, startDay);
      if (!date) continue;
      if (!within(date)) return;
      if (!counted()) return;
      yield date;
    }
  } else {
    for (let step = 0; ; step += 1) {
      expansionDiagnostics.steps += 1;
      const year = startYear + step * rule.interval;
      if (!within(`${pad(year, 4)}-01-01`)) return;
      const date = validDate(year, startMonth, startDay); // no February 29 in a common year
      if (!date) continue;
      if (!within(date)) return;
      if (!counted()) return;
      yield date;
    }
  }
}

/**
 * Why a rule can't start on `startsOn`, or null. A weekly rule that names
 * weekdays must include the start date's own weekday, and a repeat can't end
 * before its first date.
 */
export function repeatStartProblem(rule: Pick<RepeatRule, "frequency" | "weekdays" | "until">, startsOn: string) {
  if (rule.until && rule.until < startsOn) return "A repeat can't end before the first date.";
  if (rule.frequency === "WEEKLY" && rule.weekdays.length > 0 && !rule.weekdays.includes(toDate(startsOn).getUTCDay())) {
    return `A weekly repeat must include the start date's weekday (${weekdayLabels[toDate(startsOn).getUTCDay()]}).`;
  }
  return null;
}

export type RepeatOccurrence = { startsOn: string; endsOn: string };

/**
 * Occurrences of an item that overlap `[from, to]` (inclusive calendar dates),
 * minus `exceptions`. Each occurrence lasts as long as the item (a three-day
 * camp repeats as three days). Occurrences begin at the first date the rule
 * matches on or after the start date: staff-made rules always match the start
 * date itself (`repeatStartProblem`), but an imported weekly rule may not.
 * Without a rule the item is its own single occurrence.
 */
export function expandOccurrences(
  item: { startsOn: string; endsOn: string },
  rule: RepeatRule | null,
  exceptions: readonly string[],
  from: string,
  to: string,
): RepeatOccurrence[] {
  if (!rule) {
    return item.startsOn <= to && item.endsOn >= from ? [{ startsOn: item.startsOn, endsOn: item.endsOn }] : [];
  }
  const length = Math.max(0, daysBetween(item.startsOn, item.endsOn));
  const skipped = new Set(exceptions);
  const occurrences: RepeatOccurrence[] = [];
  const reach = shiftDays(from, -length);
  for (const startsOn of generate(item.startsOn, rule, reach)) {
    if (startsOn > to) break;
    const endsOn = shiftDays(startsOn, length);
    if (endsOn < from || skipped.has(startsOn)) continue;
    occurrences.push({ startsOn, endsOn });
  }
  return occurrences;
}

/** The first `limit` occurrences, skipped ones included and flagged, for the editor's skip list. */
export function previewOccurrences(
  item: { startsOn: string },
  rule: RepeatRule,
  exceptions: readonly string[],
  limit = 12,
) {
  const skipped = new Set(exceptions);
  const dates: Array<{ startsOn: string; skipped: boolean }> = [];
  for (const startsOn of generate(item.startsOn, rule)) {
    dates.push({ startsOn, skipped: skipped.has(startsOn) });
    if (dates.length >= limit) break;
  }
  return dates;
}

export const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** A plain-language summary, e.g. "Every 2 weeks on Mon, Wed, 6 times". */
export function describeRepeat(rule: RepeatRule) {
  const unit = { DAILY: "day", WEEKLY: "week", MONTHLY: "month", YEARLY: "year" }[rule.frequency];
  const every = rule.interval === 1
    ? { DAILY: "Daily", WEEKLY: "Weekly", MONTHLY: "Monthly", YEARLY: "Yearly" }[rule.frequency]
    : `Every ${rule.interval} ${unit}s`;
  const days = rule.frequency === "WEEKLY" && rule.weekdays.length > 0
    ? ` on ${rule.weekdays.map((day) => weekdayLabels[day]).join(", ")}`
    : "";
  const end = rule.until ? `, until ${rule.until}` : rule.count ? `, ${rule.count} times` : "";
  return `${every}${days}${end}`;
}
