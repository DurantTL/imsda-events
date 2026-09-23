import { describe, expect, it } from "vitest";
import {
  buildCalendarIcs,
  calendarCategories,
  eventTimeLabel,
  filterByCategory,
  formatDateRange,
  isCalendarDate,
  itemsOnDate,
  itemsOverlapping,
  monthGrid,
  parseMonthParam,
  shiftMonth,
  type CalendarItem,
} from "@/modules/calendar/domain";
import { calendarEntryInputSchema, calendarEntryUpdateSchema, calendarEventSettingsSchema } from "@/modules/calendar/schemas";

function item(overrides: Partial<CalendarItem>): CalendarItem {
  return {
    key: "entry-1",
    kind: "ENTRY",
    title: "Camporee",
    description: "",
    startsOn: "2026-10-09",
    endsOn: "2026-10-11",
    timeLabel: "",
    location: "",
    category: "",
    href: null,
    status: "SCHEDULED",
    registrationOpen: false,
    ...overrides,
  };
}

describe("calendar months", () => {
  it("fills whole Sunday-first weeks around the month", () => {
    const weeks = monthGrid({ year: 2026, month: 12 });
    expect(weeks[0][0]).toBe("2026-11-29");
    expect(weeks.at(-1)?.[6]).toBe("2027-01-02");
    expect(weeks.every((week) => week.length === 7)).toBe(true);
    expect(weeks.flat()).toContain("2026-12-31");
  });

  it("reads ?month= safely and moves across years", () => {
    expect(parseMonthParam("2027-02", "2026-09-23")).toEqual({ year: 2027, month: 2 });
    expect(parseMonthParam("2027-13", "2026-09-23")).toEqual({ year: 2026, month: 9 });
    expect(parseMonthParam("<script>", "2026-09-23")).toEqual({ year: 2026, month: 9 });
    expect(shiftMonth({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
    expect(shiftMonth({ year: 2027, month: 1 }, -1)).toEqual({ year: 2026, month: 12 });
  });

  it("puts multi-day items on every day they span", () => {
    const camporee = item({});
    expect(itemsOnDate([camporee], "2026-10-08")).toHaveLength(0);
    expect(itemsOnDate([camporee], "2026-10-10")).toHaveLength(1);
    expect(itemsOnDate([camporee], "2026-10-11")).toHaveLength(1);
    expect(itemsOverlapping([camporee], "2026-10-11", "2026-10-31")).toHaveLength(1);
    expect(itemsOverlapping([camporee], "2026-10-12", "2026-10-31")).toHaveLength(0);
  });

  it("filters by category without regard to case", () => {
    const items = [item({ key: "a", category: "Youth" }), item({ key: "b", category: "Camp meeting" }), item({ key: "c" })];
    expect(calendarCategories(items)).toEqual(["Camp meeting", "Youth"]);
    expect(filterByCategory(items, "youth").map((entry) => entry.key)).toEqual(["a"]);
    expect(filterByCategory(items, undefined)).toHaveLength(3);
  });
});

describe("calendar labels", () => {
  it("formats single, same-month, cross-month, and cross-year ranges", () => {
    expect(formatDateRange("2026-12-05", "2026-12-05")).toBe("December 5, 2026");
    expect(formatDateRange("2026-12-05", "2026-12-07")).toBe("December 5–7, 2026");
    expect(formatDateRange("2026-10-30", "2026-11-01")).toBe("October 30 – November 1, 2026");
    expect(formatDateRange("2026-12-30", "2027-01-02")).toBe("Dec 30, 2026 – Jan 2, 2027");
  });

  it("shows hours in the event's own time zone only for one-day events", () => {
    const start = new Date("2026-12-05T15:00:00Z");
    expect(eventTimeLabel(start, new Date("2026-12-05T23:00:00Z"), "America/Chicago")).toBe("9:00 AM – 5:00 PM CST");
    expect(eventTimeLabel(start, new Date("2026-12-07T18:00:00Z"), "America/Chicago")).toBe("");
  });
});

describe("calendar feed", () => {
  it("writes all-day events with escaped text, an exclusive end date, and status", () => {
    const ics = buildCalendarIcs([
      item({ key: "event-1", kind: "EVENT", title: "Men's Convention; 2027", href: "/events/mens", location: "Lake, MO" }),
      item({ key: "entry-2", title: "Rally", startsOn: "2026-11-01", endsOn: "2026-11-01", status: "CANCELLED", href: "https://example.org/rally" }),
    ], { baseUrl: "https://events.example.test/", now: new Date("2026-09-23T12:00:00Z") });
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("DTSTART;VALUE=DATE:20261009\r\nDTEND;VALUE=DATE:20261012");
    expect(ics).toContain("SUMMARY:Men's Convention\\; 2027");
    expect(ics).toContain("LOCATION:Lake\\, MO");
    expect(ics).toContain("URL:https://events.example.test/events/mens");
    expect(ics).toContain("STATUS:CANCELLED");
    expect(ics).toContain("DTSTAMP:20260923T120000Z");
    expect(ics.split("\r\n").every((line) => new TextEncoder().encode(line).length <= 75)).toBe(true);
  });

  it("folds long lines", () => {
    const ics = buildCalendarIcs([item({ description: "Bring a sleeping bag. ".repeat(20) })], { baseUrl: "https://x.test", now: new Date() });
    expect(ics).toContain("\r\n ");
  });
});

describe("calendar input", () => {
  const valid = { title: "Camporee", startsOn: "2026-10-09", endsOn: "2026-10-11" };

  it("accepts a simple entry and defaults to a draft", () => {
    expect(calendarEntryInputSchema.parse(valid)).toMatchObject({ isPublished: false, status: "SCHEDULED", linkUrl: null });
  });

  it("rejects impossible dates, reversed ranges, and non-https links", () => {
    expect(isCalendarDate("2026-02-30")).toBe(false);
    expect(calendarEntryInputSchema.safeParse({ ...valid, startsOn: "2026-02-30" }).success).toBe(false);
    expect(calendarEntryInputSchema.safeParse({ ...valid, endsOn: "2026-10-01" }).success).toBe(false);
    expect(calendarEntryInputSchema.safeParse({ ...valid, linkUrl: "javascript:alert(1)" }).success).toBe(false);
    expect(calendarEntryInputSchema.safeParse({ ...valid, linkUrl: "http://example.org" }).success).toBe(false);
    expect(calendarEntryInputSchema.parse({ ...valid, linkUrl: "" }).linkUrl).toBeNull();
    expect(calendarEntryInputSchema.parse({ ...valid, linkUrl: "https://example.org/a" }).linkUrl).toBe("https://example.org/a");
  });

  it("updates dates only as a pair, and allows a publish toggle alone", () => {
    expect(calendarEntryUpdateSchema.safeParse({ isPublished: true }).success).toBe(true);
    expect(calendarEntryUpdateSchema.safeParse({ startsOn: "2026-10-09" }).success).toBe(false);
    expect(calendarEntryUpdateSchema.safeParse({ startsOn: "2026-10-09", endsOn: "2026-10-08" }).success).toBe(false);
  });

  it("clears an event category when sent blank", () => {
    expect(calendarEventSettingsSchema.parse({ calendarCategory: "" })).toEqual({ calendarCategory: null });
    expect(calendarEventSettingsSchema.safeParse({ isPublished: true }).success).toBe(false);
  });
});
