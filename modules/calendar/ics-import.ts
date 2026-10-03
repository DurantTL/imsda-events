/**
 * A small RFC 5545 reader for the Google Calendar import (#444 part B). Pure:
 * it turns the text of an ICS feed into calendar-entry fields and warnings and
 * touches neither the network nor the database.
 *
 * It reads VEVENTs only (VTODO, VALARM and VTIMEZONE bodies are ignored; a
 * TZID is resolved by name with Intl). Dates are mapped to calendar dates in
 * the conference time zone, and the repeat rule goes through the same
 * `parseRepeatRule` that staff-made repeats use.
 */
import {
  CONFERENCE_TIME_ZONE,
  addDays,
  calendarDateIn,
  eventTimeLabel,
  isCalendarDate,
} from "@/modules/calendar/domain";
import { parseRepeatRule, serializeRepeatRule } from "@/modules/calendar/recurrence";

export const maxFeedBytes = 2 * 1024 * 1024;
export const maxFeedEvents = 2000;
export const maxExceptions = 200;
export const maxUidLength = 255;

export class IcsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IcsParseError";
  }
}

export type ImportedEntryFields = {
  title: string;
  description: string;
  location: string;
  linkUrl: string | null;
  status: "SCHEDULED" | "CANCELLED";
  startsOn: string;
  endsOn: string;
  timeLabel: string;
  repeatRule: string | null;
  repeatExceptions: string[];
};

/** The fields a feed owns. Staff edits to any of these are protected from refresh. */
export const importedFieldNames = [
  "title", "description", "location", "linkUrl", "status", "startsOn", "endsOn", "timeLabel", "repeatRule", "repeatExceptions",
] as const satisfies ReadonlyArray<keyof ImportedEntryFields>;

export type ImportedEntry = ImportedEntryFields & {
  uid: string;
  /** "" for a series' master or a one-off; the overridden occurrence for a RECURRENCE-ID item. */
  recurrenceId: string;
};

export type ParsedIcsFeed = {
  entries: ImportedEntry[];
  warnings: string[];
};

type Property = { name: string; params: Record<string, string>; value: string };

/** Content lines with RFC 5545 line folding undone. */
function unfold(text: string) {
  const lines: string[] = [];
  for (const raw of text.split(/\r\n|\n|\r/)) {
    if ((raw.startsWith(" ") || raw.startsWith("\t")) && lines.length > 0) lines[lines.length - 1] += raw.slice(1);
    else lines.push(raw);
  }
  return lines.filter((line) => line.length > 0);
}

function parseLine(line: string): Property | null {
  let inQuotes = false;
  let colon = -1;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') inQuotes = !inQuotes;
    else if (character === ":" && !inQuotes) {
      colon = index;
      break;
    }
  }
  if (colon < 1) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const params: Record<string, string> = {};
  const segments: string[] = [];
  let current = "";
  inQuotes = false;
  for (const character of head) {
    if (character === '"') inQuotes = !inQuotes;
    if (character === ";" && !inQuotes) {
      segments.push(current);
      current = "";
    } else current += character;
  }
  segments.push(current);
  const [name, ...rest] = segments;
  for (const segment of rest) {
    const equals = segment.indexOf("=");
    if (equals < 1) continue;
    params[segment.slice(0, equals).toUpperCase()] = segment.slice(equals + 1).replace(/^"|"$/g, "");
  }
  return { name: name.toUpperCase(), params, value };
}

function unescapeText(value: string) {
  return value.replace(/\\([nN,;\\])/g, (_match, character: string) => (character === "n" || character === "N" ? "\n" : character));
}

const htmlEntities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/** Google sometimes sends HTML in DESCRIPTION; the calendar shows plain text. */
function plainText(value: string, max: number) {
  // Bound the work first: a feed is untrusted, and a megabyte of one character must not cost more than the field it fills.
  const bounded = value.slice(0, max * 4);
  return unescapeText(bounded)
    .replace(/<\s{0,8}br\s{0,8}\/?\s{0,8}>/gi, "\n")
    .replace(/<\/\s{0,8}(p|div|li)\s{0,8}>/gi, "\n")
    .replace(/<[^<>]*>/g, "")
    .replace(/&(#39|[a-z]+);/gi, (match, name: string) => htmlEntities[name.toLowerCase()] ?? match)
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cap(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

type Moment =
  | { kind: "date"; date: string }
  | { kind: "time"; instant: Date; zone: string };

const datePattern = /^(\d{4})(\d{2})(\d{2})$/;
const dateTimePattern = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/i;

const wallClockFormatters = new Map<string, Intl.DateTimeFormat>();

function wallClockFormatter(timeZone: string) {
  let formatter = wallClockFormatters.get(timeZone);
  if (!formatter) {
    if (wallClockFormatters.size >= 600) wallClockFormatters.clear(); // a backstop; keys are canonical zone names
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    });
    wallClockFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function offsetMinutes(instant: Date, timeZone: string) {
  const parts = wallClockFormatter(timeZone).formatToParts(instant);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
}

/** The instant a wall-clock time has in a zone (the earlier one in a repeated hour, a shifted one in a skipped hour). */
function zonedInstant(wall: number, timeZone: string) {
  let guess = wall;
  for (let pass = 0; pass < 3; pass += 1) {
    const next = wall - offsetMinutes(new Date(guess), timeZone) * 60_000;
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

const aliasZones = new Map<string, string | null>();
const maxAliasZones = 200;
let canonicalByLowercase: Map<string, string> | null = null;

/**
 * The canonical IANA name for a feed's TZID, or null when it is not a zone.
 * Intl accepts any letter case, so a feed could otherwise supply endless
 * spellings of one zone; every cache below is keyed by the canonical name only.
 * Names that are not canonical (aliases like US/Central) resolve through a
 * hard-capped cache.
 */
function canonicalZone(name: string): string | null {
  if (name.length === 0 || name.length > 64) return null;
  if (!canonicalByLowercase) {
    canonicalByLowercase = new Map(["UTC", ...Intl.supportedValuesOf("timeZone")].map((zone) => [zone.toLowerCase(), zone]));
  }
  const key = name.toLowerCase();
  const known = canonicalByLowercase.get(key);
  if (known) return known;
  if (aliasZones.has(key)) return aliasZones.get(key) ?? null;
  let resolved: string | null = null;
  try {
    resolved = new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    resolved = null;
  }
  if (aliasZones.size >= maxAliasZones) aliasZones.clear();
  aliasZones.set(key, resolved);
  return resolved;
}

/** For tests: the sizes of the zone caches. */
export const zoneCacheSizes = () => ({ wallClock: wallClockFormatters.size, aliases: aliasZones.size });

function parseMoment(property: Property, warn: (message: string) => void): Moment | null {
  const value = property.value.trim();
  const dateOnly = value.match(datePattern);
  if (dateOnly && (property.params.VALUE === "DATE" || !property.params.VALUE)) {
    const date = `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`;
    return isCalendarDate(date) ? { kind: "date", date } : null;
  }
  const match = value.match(dateTimePattern);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, utc] = match;
  if (!isCalendarDate(`${year}-${month}-${day}`)) return null;
  const wall = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  if (utc) return { kind: "time", instant: new Date(wall), zone: "UTC" };
  let zone = CONFERENCE_TIME_ZONE;
  if (property.params.TZID) {
    const canonical = canonicalZone(property.params.TZID);
    if (canonical) zone = canonical;
    else warn(`A time zone name was not recognized, so its times were read as ${CONFERENCE_TIME_ZONE}.`);
  }
  return { kind: "time", instant: zonedInstant(wall, zone), zone };
}

function parseDuration(value: string) {
  const match = value.trim().match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
  if (!match || match[1] === "-") return null;
  const [weeks, days, hours, minutes, seconds] = match.slice(2).map((part) => Number(part ?? 0));
  const total = (weeks * 7 + days) * 86_400 + hours * 3600 + minutes * 60 + seconds;
  return total * 1000;
}

function isConferenceMidnight(instant: Date) {
  const parts = wallClockFormatter(CONFERENCE_TIME_ZONE).formatToParts(instant);
  return parts.every((part) => !["hour", "minute", "second"].includes(part.type) || Number(part.value) === 0);
}

function dayOffset(from: string, to: string) {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

function conferenceDate(instant: Date) {
  return calendarDateIn(instant, CONFERENCE_TIME_ZONE);
}

/** A moment as the conference-zone calendar date; a stable id for an overridden occurrence. */
function momentDate(moment: Moment) {
  return moment.kind === "date" ? moment.date : conferenceDate(moment.instant);
}

function momentKey(moment: Moment) {
  return moment.kind === "date" ? moment.date : moment.instant.toISOString();
}

type RawEvent = { props: Property[] };

function readEvents(text: string) {
  const lines = unfold(text);
  if (!lines.some((line) => /^BEGIN:VCALENDAR$/i.test(line.trim()))) {
    throw new IcsParseError("That address did not return a calendar (ICS) file.");
  }
  const events: RawEvent[] = [];
  const stack: string[] = [];
  let current: RawEvent | null = null;
  for (const line of lines) {
    const begin = line.match(/^BEGIN:(.+)$/i);
    const end = line.match(/^END:(.+)$/i);
    if (begin) {
      const name = begin[1].trim().toUpperCase();
      stack.push(name);
      if (name === "VEVENT" && stack.length === 2) current = { props: [] };
      continue;
    }
    if (end) {
      const name = end[1].trim().toUpperCase();
      if (name === "VEVENT" && stack.length === 2 && current) {
        events.push(current);
        current = null;
      }
      // Tolerate a stray END: only pop what matches.
      if (stack[stack.length - 1] === name) stack.pop();
      continue;
    }
    // Only the direct properties of a top-level VEVENT; a VALARM inside it is skipped.
    if (current && stack.length === 2 && stack[1] === "VEVENT") {
      const property = parseLine(line);
      if (property) current.props.push(property);
    }
  }
  return events;
}

/** UNTIL in UTC date-time form is a conference-zone date; the rule reader wants a plain date. */
function normalizeRule(value: string, warn: (message: string) => void) {
  const untilMatch = value.match(/UNTIL=(\d{8}T\d{6}Z?)/i);
  let rule = value.replace(/^RRULE:/i, "");
  if (untilMatch) {
    const moment = parseMoment({ name: "UNTIL", params: {}, value: untilMatch[1] }, warn);
    if (moment) rule = rule.replace(untilMatch[1], momentDate(moment).replace(/-/g, ""));
  }
  return rule;
}

export function parseIcsFeed(text: string): ParsedIcsFeed {
  if (Buffer.byteLength(text, "utf8") > maxFeedBytes) {
    throw new IcsParseError("The calendar file is larger than the 2 MB limit.");
  }
  const warnings: string[] = [];
  const warned = new Set<string>();
  const warn = (message: string) => {
    if (warned.has(message)) return;
    warned.add(message);
    warnings.push(message);
  };

  const raw = readEvents(text);
  if (raw.length > maxFeedEvents) warn(`The calendar has ${raw.length} events; only the first ${maxFeedEvents} were read.`);

  type Draft = { uid: string; recurrenceId: string; recurrenceDate: string | null; fields: ImportedEntryFields; exceptions: string[]; label: string };
  const seen = new Set<string>();
  const drafts: Draft[] = [];

  for (const event of raw.slice(0, maxFeedEvents)) {
    const first = (name: string) => event.props.find((property) => property.name === name);
    const all = (name: string) => event.props.filter((property) => property.name === name);
    const title = cap(plainText(first("SUMMARY")?.value ?? "", 140).replace(/\s+/g, " "), 140) || "(No title)";
    const label = `"${cap(title, 40)}"`;
    const uid = first("UID")?.value.trim() ?? "";
    if (!uid) {
      warn(`${label} has no unique id (UID) and was skipped.`);
      continue;
    }
    if (uid.length > maxUidLength) {
      warn(`${label} has an id (UID) longer than ${maxUidLength} characters and was skipped.`);
      continue;
    }
    const startProperty = first("DTSTART");
    const start = startProperty ? parseMoment(startProperty, warn) : null;
    if (!start) {
      warn(`${label} has no readable start date and was skipped.`);
      continue;
    }

    let recurrenceId = "";
    let recurrenceDate: string | null = null;
    const recurrenceProperty = first("RECURRENCE-ID");
    if (recurrenceProperty) {
      const moment = parseMoment(recurrenceProperty, warn);
      if (!moment) {
        warn(`${label} has an unreadable occurrence id and was skipped.`);
        continue;
      }
      if (/THISANDFUTURE/i.test(recurrenceProperty.params.RANGE ?? "")) {
        warn(`${label} changes "this and following" occurrences; only the one occurrence was imported.`);
      }
      recurrenceId = momentKey(moment);
      recurrenceDate = momentDate(moment);
    }

    const key = `${uid}\n${recurrenceId}`;
    if (seen.has(key)) {
      warn(`${label} appears more than once with the same id; the first one was kept.`);
      continue;
    }
    seen.add(key);

    // Dates. A DATE end is exclusive; so is a timed end that falls exactly on midnight.
    let startsOn: string;
    let endsOn: string;
    let timeLabel = "";
    if (start.kind === "date") {
      startsOn = start.date;
      const endProperty = first("DTEND");
      const end = endProperty ? parseMoment(endProperty, warn) : null;
      endsOn = end ? addDays(momentDate(end), -1) : startsOn;
      if (endsOn < startsOn) endsOn = startsOn;
    } else {
      const endProperty = first("DTEND");
      const endInstant = endProperty ? parseMoment(endProperty, warn) : null;
      let end: Date = start.instant;
      if (endInstant?.kind === "time") end = endInstant.instant;
      else if (endInstant?.kind === "date") {
        const [y, m, d] = endInstant.date.split("-").map(Number);
        end = zonedInstant(Date.UTC(y, m - 1, d), CONFERENCE_TIME_ZONE); // conference-zone midnight
      }
      else {
        const duration = first("DURATION") ? parseDuration(first("DURATION")!.value) : null;
        if (duration !== null) end = new Date(start.instant.getTime() + duration);
      }
      if (end < start.instant) end = start.instant;
      startsOn = conferenceDate(start.instant);
      const midnightEnd = end > start.instant && isConferenceMidnight(end);
      // A timed end exactly at midnight belongs to the day before.
      const lastMoment = midnightEnd ? new Date(end.getTime() - 1000) : end;
      endsOn = conferenceDate(lastMoment);
      if (endsOn < startsOn) endsOn = startsOn;
      timeLabel = eventTimeLabel(start.instant, lastMoment, CONFERENCE_TIME_ZONE);
      // No end time: show the start alone rather than "9:00 AM – 9:00 AM".
      if (end.getTime() === start.instant.getTime()) timeLabel = timeLabel.replace(/^(\S+ \S+) – \1/, "$1");
    }

    // Repeats. An override of one occurrence never repeats itself.
    let repeatRule: string | null = null;
    const exceptions: string[] = [];
    const rruleProperty = first("RRULE");
    if (rruleProperty && !recurrenceProperty) {
      const parsed = parseRepeatRule(normalizeRule(rruleProperty.value, warn));
      if (!parsed) {
        warn(`${label} repeats in a way the calendar can't show; only its first date was imported.`);
      } else if (parsed.until && parsed.until < startsOn) {
        warn(`${label} has a repeat that ends before it starts; only its first date was imported.`);
      } else {
        // BYDAY and a plain-date UNTIL are in the series' own zone; the item's dates are in conference time.
        // When the two zones put the first occurrence on different days, move them by the same offset.
        const offset = start.kind === "time" ? dayOffset(calendarDateIn(start.instant, start.zone), startsOn) : 0;
        if (offset !== 0) {
          if (parsed.frequency === "MONTHLY" || parsed.frequency === "YEARLY" || (parsed.frequency === "WEEKLY" && parsed.interval > 1)) {
            warn(`${label} repeats in a different time zone than the calendar's, so some dates may be a day off; check them after importing.`);
          }
          parsed.weekdays = parsed.weekdays.map((day) => (((day + offset) % 7) + 7) % 7).sort((a, b) => a - b);
          if (parsed.until && !/UNTIL=\d{8}T/i.test(rruleProperty.value)) parsed.until = addDays(parsed.until, offset);
        }
        repeatRule = serializeRepeatRule(parsed);
        // A feed is untrusted: stop reading skipped dates well past the number that is kept.
        const readLimit = maxExceptions * 2;
        let read = 0;
        for (const exdate of all("EXDATE")) {
          if (read >= readLimit) break;
          for (const piece of exdate.value.split(",", readLimit - read + 1)) {
            if (read >= readLimit) {
              warn(`${label} lists more than ${readLimit} skipped dates; the rest were ignored.`);
              break;
            }
            read += 1;
            const moment = parseMoment({ ...exdate, value: piece }, warn);
            if (moment) exceptions.push(momentDate(moment));
            else warn(`${label} has a skipped date that could not be read.`);
          }
        }
      }
    }

    const url = first("URL")?.value.trim() ?? "";
    // The editor only accepts https links, so only those are imported.
    const linkUrl = /^https:\/\//i.test(url) && url.length <= 500 ? url : null;
    if (url && !linkUrl) warn(`${label} has a link that is not a short https:// address, so the link was left off.`);
    const statusValue = (first("STATUS")?.value ?? "").trim().toUpperCase();
    drafts.push({
      uid,
      recurrenceId,
      recurrenceDate,
      label,
      exceptions,
      fields: {
        title,
        description: cap(plainText(first("DESCRIPTION")?.value ?? "", 2000), 2000),
        location: cap(plainText(first("LOCATION")?.value ?? "", 160).replace(/\s+/g, " "), 160),
        linkUrl,
        status: statusValue === "CANCELLED" ? "CANCELLED" : "SCHEDULED",
        startsOn,
        endsOn,
        timeLabel: cap(timeLabel, 80),
        repeatRule,
        repeatExceptions: [],
      },
    });
  }

  // A changed occurrence replaces the series' own on its date, so the series skips that date.
  const masters = new Map(drafts.filter((draft) => draft.recurrenceId === "").map((draft) => [draft.uid, draft]));
  for (const draft of drafts) {
    if (draft.recurrenceId === "" || !draft.recurrenceDate) continue;
    masters.get(draft.uid)?.exceptions.push(draft.recurrenceDate);
  }

  const entries = drafts.map((draft): ImportedEntry => {
    let exceptions = [...new Set(draft.exceptions)].sort();
    if (exceptions.length > maxExceptions) {
      warn(`${draft.label} skips more than ${maxExceptions} dates; only the first ${maxExceptions} were kept.`);
      exceptions = exceptions.slice(0, maxExceptions);
    }
    return { uid: draft.uid, recurrenceId: draft.recurrenceId, ...draft.fields, repeatExceptions: exceptions };
  });
  return { entries, warnings };
}
