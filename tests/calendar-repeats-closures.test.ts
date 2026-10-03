import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  eventFindMany: vi.fn(),
  entryFindMany: vi.fn(),
  entryCreate: vi.fn(),
  entryFindUnique: vi.fn(),
  entryUpdate: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => {
  const client = {
    event: { findMany: mocks.eventFindMany },
    calendarEntry: {
      findMany: mocks.entryFindMany,
      create: mocks.entryCreate,
      findUnique: mocks.entryFindUnique,
      update: mocks.entryUpdate,
    },
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(client),
  };
  return { getPrisma: () => client };
});
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: vi.fn() }));

import { AgendaItem } from "@/components/calendar-agenda-item";
import { draftToRepeat, noRepeat, repeatToDraft, shortMonthHint } from "@/components/calendar-admin-workspace";
import { buildCalendarIcs, closureCategory, firstPerSeries, parseMonthParam, type CalendarItem } from "@/modules/calendar/domain";
import { createCalendarEntry, listPublicCalendarItems, updateCalendarEntry, CalendarError } from "@/modules/calendar/repository";
import { parseRepeatRule } from "@/modules/calendar/recurrence";
import { calendarEntryInputSchema, calendarEntryUpdateSchema } from "@/modules/calendar/schemas";
import { buildSubscribeLinks } from "@/modules/calendar/subscribe";

const now = new Date("2026-10-03T12:00:00Z");

function entryRow(overrides: Record<string, unknown>) {
  return {
    id: "entry-1",
    title: "Staff meeting",
    description: "",
    startsOn: "2026-10-05",
    endsOn: "2026-10-05",
    timeLabel: "",
    location: "",
    category: "",
    linkUrl: null,
    status: "SCHEDULED",
    entryType: "STANDARD",
    repeatRule: null,
    repeatExceptions: [],
    isPublished: true,
    updatedAt: new Date("2026-10-01T00:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.eventFindMany.mockResolvedValue([]);
});

describe("repeating entries on the public calendar", () => {
  it("expands a weekly entry into the window and drops skipped dates, with one key per occurrence", async () => {
    mocks.entryFindMany.mockResolvedValue([entryRow({ repeatRule: "FREQ=WEEKLY", repeatExceptions: ["2026-10-12"] })]);
    const items = await listPublicCalendarItems("2026-10-01", "2026-10-31", now);
    expect(items.map((item) => item.startsOn)).toEqual(["2026-10-05", "2026-10-19", "2026-10-26"]);
    expect(new Set(items.map((item) => item.key)).size).toBe(3);
    expect(items.every((item) => item.recurrence === null)).toBe(true);
  });

  it("still reads a repeating entry that began long before the window, but only published ones", async () => {
    mocks.entryFindMany.mockResolvedValue([]);
    await listPublicCalendarItems("2026-10-01", "2026-10-31", now);
    expect(mocks.entryFindMany.mock.calls[0][0].where).toMatchObject({
      isPublished: true,
      startsOn: { lte: "2026-10-31" },
      OR: [{ endsOn: { gte: "2026-10-01" } }, { repeatRule: { not: null } }],
    });
  });

  it("keeps the master item with its RRULE and EXDATEs for the feed", async () => {
    mocks.entryFindMany.mockResolvedValue([entryRow({ repeatRule: "FREQ=WEEKLY;COUNT=4", repeatExceptions: ["2026-10-12"] })]);
    const items = await listPublicCalendarItems("2026-10-01", "2026-10-31", now, { expandRepeats: false });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: "entry-entry-1", recurrence: { rule: "FREQ=WEEKLY;WKST=MO;COUNT=4", exceptions: ["2026-10-12"] } });
  });

  it("keeps a feed master whose first date is long before the window", async () => {
    mocks.entryFindMany.mockResolvedValue([entryRow({ startsOn: "2020-01-06", endsOn: "2020-01-06", repeatRule: "FREQ=WEEKLY" })]);
    const items = await listPublicCalendarItems("2026-10-01", "2026-10-31", now, { expandRepeats: false });
    expect(items).toHaveLength(1);
  });

  it("marks closures", async () => {
    mocks.entryFindMany.mockResolvedValue([entryRow({ title: "Conference office closed", entryType: "CLOSURE" })]);
    const [item] = await listPublicCalendarItems("2026-10-01", "2026-10-31", now);
    expect(item.isClosure).toBe(true);
  });
});

function item(overrides: Partial<CalendarItem>): CalendarItem {
  return {
    key: "entry-1",
    kind: "ENTRY",
    title: "Staff meeting",
    description: "",
    startsOn: "2026-10-05",
    endsOn: "2026-10-05",
    timeLabel: "",
    location: "",
    category: "",
    href: null,
    status: "SCHEDULED",
    registrationOpen: false,
    ...overrides,
  };
}

describe("calendar feed repeats and closures", () => {
  it("writes RRULE and EXDATE on one event instead of expanding it", () => {
    const ics = buildCalendarIcs([
      item({ recurrence: { rule: "FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20270601", exceptions: ["2026-10-21", "2026-10-12"] } }),
    ], { baseUrl: "https://events.example.test", now });
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(ics).toContain("UID:entry-1@imsda-events");
    expect(ics).toContain("RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20270601");
    expect(ics).toContain("EXDATE;VALUE=DATE:20261012,20261021");
  });

  it("writes no RRULE or EXDATE for a one-off and no EXDATE without skips", () => {
    expect(buildCalendarIcs([item({})], { baseUrl: "https://x.test", now })).not.toMatch(/RRULE|EXDATE/);
    expect(buildCalendarIcs([item({ recurrence: { rule: "FREQ=DAILY", exceptions: [] } })], { baseUrl: "https://x.test", now })).not.toContain("EXDATE");
  });

  it("puts closures in the Office closure category alongside their own category", () => {
    const ics = buildCalendarIcs([
      item({ title: "Conference office closed", isClosure: true }),
      item({ key: "entry-2", title: "Holiday", isClosure: true, category: "Staff, HR" }),
    ], { baseUrl: "https://x.test", now });
    expect(ics).toContain(`CATEGORIES:${closureCategory}\r\n`);
    expect(ics).toContain(`CATEGORIES:${closureCategory},Staff\\, HR\r\n`);
  });
});

describe("closure rendering", () => {
  it("labels a closure with text and an icon, not colour alone", () => {
    const html = renderToStaticMarkup(createElement(AgendaItem, { item: item({ title: "Conference office closed", isClosure: true }) }));
    expect(html).toContain("calendar-closure");
    expect(html).toContain("Office closed");
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(html).not.toContain("Conference date");
  });

  it("leaves an ordinary date as it was", () => {
    const html = renderToStaticMarkup(createElement(AgendaItem, { item: item({}) }));
    expect(html).toContain("Conference date");
    expect(html).not.toContain("calendar-closure");
  });
});

describe("lists and the month view", () => {
  it("shows only the first occurrence of a repeating entry in a list", () => {
    const list = [
      item({ key: "entry-1:2026-10-06", seriesId: "entry-1", startsOn: "2026-10-06", endsOn: "2026-10-06" }),
      item({ key: "entry-9", title: "Rally", startsOn: "2026-10-07", endsOn: "2026-10-07" }),
      item({ key: "entry-1:2026-10-13", seriesId: "entry-1", startsOn: "2026-10-13", endsOn: "2026-10-13" }),
    ];
    expect(firstPerSeries(list).map((entry) => entry.key)).toEqual(["entry-1:2026-10-06", "entry-9"]);
  });

  it("keeps ?month= within five years of today", () => {
    expect(parseMonthParam("2031-12", "2026-10-03")).toEqual({ year: 2031, month: 12 });
    expect(parseMonthParam("2032-01", "2026-10-03")).toEqual({ year: 2026, month: 10 });
    expect(parseMonthParam("2100-12", "2026-10-03")).toEqual({ year: 2026, month: 10 });
    expect(parseMonthParam("2000-01", "2026-10-03")).toEqual({ year: 2026, month: 10 });
  });
});

describe("subscribe links", () => {
  const links = buildSubscribeLinks("https://events.example.test/");

  it("builds every link from the canonical site URL", () => {
    expect(links.feedUrl).toBe("https://events.example.test/calendar/feed.ics");
    expect(links.webcalUrl).toBe("webcal://events.example.test/calendar/feed.ics");
    expect(links.apple).toBe("webcal://events.example.test/calendar/feed.ics");
    expect(links.google).toBe("https://calendar.google.com/calendar/render?cid=webcal%3A%2F%2Fevents.example.test%2Fcalendar%2Ffeed.ics");
    expect(links.outlook).toBe("https://outlook.live.com/calendar/0/addfromweb?url=https%3A%2F%2Fevents.example.test%2Fcalendar%2Ffeed.ics&name=IMSDA%20conference%20calendar");
    expect(links.outlookWork).toContain("https://outlook.office.com/calendar/0/addfromweb?url=https%3A%2F%2Fevents.example.test%2Fcalendar%2Ffeed.ics");
  });

  it("follows the configured host, including a local http one", () => {
    expect(buildSubscribeLinks("http://localhost:3000").webcalUrl).toBe("webcal://localhost:3000/calendar/feed.ics");
  });
});

describe("editor save and load", () => {
  it("round-trips the Repeats control through a rule", () => {
    const rule = parseRepeatRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=6")!;
    const draft = repeatToDraft(rule);
    expect(draft).toMatchObject({ frequency: "WEEKLY", interval: 2, weekdays: [1, 3], endMode: "count", count: 6 });
    expect(draftToRepeat(draft)).toEqual(rule);
    expect(repeatToDraft(parseRepeatRule("FREQ=YEARLY;UNTIL=20300101"))).toMatchObject({ endMode: "until", until: "2030-01-01" });
    expect(repeatToDraft(null)).toEqual(noRepeat);
    expect(draftToRepeat(noRepeat)).toBeNull();
  });

  it("validates the repeat and the skipped dates", () => {
    const base = { title: "Staff meeting", startsOn: "2026-10-05", endsOn: "2026-10-05" };
    expect(calendarEntryInputSchema.parse({ ...base, repeat: { frequency: "WEEKLY", weekdays: [1, 3], count: 4 }, repeatExceptions: ["2026-10-12"], entryType: "CLOSURE" }))
      .toMatchObject({ repeat: { frequency: "WEEKLY", interval: 1, until: null, count: 4 }, repeatExceptions: ["2026-10-12"], entryType: "CLOSURE" });
    expect(calendarEntryInputSchema.parse(base)).toMatchObject({ repeat: null, repeatExceptions: [], entryType: "STANDARD" });
    expect(() => calendarEntryInputSchema.parse({ ...base, repeat: { frequency: "DAILY", until: "2026-10-01" } })).toThrow();
    expect(() => calendarEntryInputSchema.parse({ ...base, repeat: { frequency: "DAILY", until: "2026-11-01", count: 3 } })).toThrow();
    expect(() => calendarEntryInputSchema.parse({ ...base, repeat: { frequency: "MONTHLY", weekdays: [1] } })).toThrow();
    expect(() => calendarEntryInputSchema.parse({ ...base, repeat: { frequency: "DAILY", interval: 0 } })).toThrow();
    expect(() => calendarEntryInputSchema.parse({ ...base, repeatExceptions: ["2026-02-30"] })).toThrow();
    expect(calendarEntryUpdateSchema.parse({ repeat: null })).toEqual({ repeat: null });
  });

  it("stores the repeat as an RRULE and loads it back as a structured rule", async () => {
    mocks.entryCreate.mockResolvedValue({ id: "entry-1", title: "Staff meeting", startsOn: "2026-10-05", endsOn: "2026-10-05", isPublished: true });
    mocks.entryFindMany.mockResolvedValue([entryRow({ repeatRule: "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6", repeatExceptions: ["2026-10-12"], entryType: "CLOSURE" })]);
    const input = calendarEntryInputSchema.parse({
      title: "Staff meeting",
      startsOn: "2026-10-05",
      endsOn: "2026-10-05",
      isPublished: true,
      entryType: "CLOSURE",
      repeat: { frequency: "WEEKLY", weekdays: [3, 1], count: 6 },
      repeatExceptions: ["2026-10-12"],
    });
    const entries = await createCalendarEntry(input, "admin-1");
    expect(mocks.entryCreate.mock.calls[0][0].data).toMatchObject({
      repeatRule: "FREQ=WEEKLY;BYDAY=MO,WE;WKST=SU;COUNT=6",
      repeatExceptions: ["2026-10-12"],
      entryType: "CLOSURE",
    });
    expect(mocks.entryCreate.mock.calls[0][0].data).not.toHaveProperty("repeat");
    expect(entries[0]).toMatchObject({
      entryType: "CLOSURE",
      repeat: { frequency: "WEEKLY", weekdays: [1, 3], count: 6 },
      repeatExceptions: ["2026-10-12"],
    });
  });

  it("rejects a weekly repeat whose weekdays leave out the start date's weekday", () => {
    // 2026-10-06 is a Tuesday.
    const base = { title: "Staff meeting", startsOn: "2026-10-06", endsOn: "2026-10-06" };
    const result = calendarEntryInputSchema.safeParse({ ...base, repeat: { frequency: "WEEKLY", weekdays: [1, 3] } });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toMatch(/start date's weekday \(Tue\)/);
    expect(calendarEntryInputSchema.safeParse({ ...base, repeat: { frequency: "WEEKLY", weekdays: [2, 3] } }).success).toBe(true);
    expect(calendarEntryUpdateSchema.safeParse({ startsOn: "2026-10-06", endsOn: "2026-10-06", repeat: { frequency: "WEEKLY", weekdays: [1] } }).success).toBe(false);
  });

  it("re-checks the stored repeat when only the start date changes", async () => {
    const existing = entryRow({ startsOn: "2026-10-06", endsOn: "2026-10-06", repeatRule: "FREQ=WEEKLY;BYDAY=TU,TH;WKST=SU;UNTIL=20261231" });
    mocks.entryFindUnique.mockResolvedValue(existing);
    mocks.entryUpdate.mockResolvedValue(existing);
    mocks.entryFindMany.mockResolvedValue([]);
    // Monday is not among Tue/Thu.
    await expect(updateCalendarEntry("entry-1", { startsOn: "2026-10-05", endsOn: "2026-10-05" }, "admin-1")).rejects.toMatchObject({ code: "INVALID_REPEAT" });
    // Moving past the UNTIL date fails too.
    await expect(updateCalendarEntry("entry-1", { startsOn: "2027-01-05", endsOn: "2027-01-05" }, "admin-1")).rejects.toMatchObject({ code: "INVALID_REPEAT" });
    expect(mocks.entryUpdate).not.toHaveBeenCalled();
    // Thursday is fine.
    await updateCalendarEntry("entry-1", { startsOn: "2026-10-08", endsOn: "2026-10-08" }, "admin-1");
    expect(mocks.entryUpdate).toHaveBeenCalledTimes(1);
  });

  it("makes the start weekday part of a weekly repeat and hints about short months", () => {
    // 2026-10-06 is a Tuesday (2).
    expect(draftToRepeat({ ...noRepeat, frequency: "WEEKLY", weekdays: [1, 3] }, "2026-10-06")?.weekdays).toEqual([1, 2, 3]);
    expect(draftToRepeat({ ...noRepeat, frequency: "WEEKLY" }, "2026-10-06")?.weekdays).toEqual([]);
    expect(shortMonthHint({ ...noRepeat, frequency: "MONTHLY" }, "2026-10-31")).toMatch(/Outlook/);
    expect(shortMonthHint({ ...noRepeat, frequency: "MONTHLY" }, "2026-10-28")).toBeNull();
    expect(shortMonthHint({ ...noRepeat, frequency: "YEARLY" }, "2028-02-29")).toMatch(/shorter months/);
    expect(shortMonthHint({ ...noRepeat, frequency: "YEARLY" }, "2026-10-31")).toBeNull();
  });

  it("clears a repeat, and refuses an end date before the first date", async () => {
    const existing = entryRow({ repeatRule: "FREQ=DAILY" });
    mocks.entryFindUnique.mockResolvedValue(existing);
    mocks.entryUpdate.mockResolvedValue({ ...existing, repeatRule: null });
    mocks.entryFindMany.mockResolvedValue([]);
    await updateCalendarEntry("entry-1", { repeat: null }, "admin-1");
    expect(mocks.entryUpdate.mock.calls[0][0].data).toMatchObject({ repeatRule: null });

    await expect(updateCalendarEntry("entry-1", { repeat: { frequency: "DAILY", interval: 1, weekdays: [], until: "2026-09-01", count: null, weekStart: 0 } }, "admin-1"))
      .rejects.toBeInstanceOf(CalendarError);
  });
});
