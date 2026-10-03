import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { IcsParseError, maxFeedBytes, maxFeedEvents, parseIcsFeed } from "@/modules/calendar/ics-import";
import { expandOccurrences, parseRepeatRule } from "@/modules/calendar/recurrence";

const fixture = readFileSync(new URL("./fixtures/calendar-feed.ics", import.meta.url), "utf8");
const parsed = parseIcsFeed(fixture);
const byUid = (uid: string, recurrenceId = "") => parsed.entries.find((entry) => entry.uid === uid && entry.recurrenceId === recurrenceId);

function wrap(...events: string[]) {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", ...events.flatMap((event) => ["BEGIN:VEVENT", event, "END:VEVENT"]), "END:VCALENDAR"].join("\r\n");
}

describe("ICS import: mapping", () => {
  it("reads all-day items, with an exclusive end date turned inclusive", () => {
    expect(byUid("allday-1@synthetic.test")).toMatchObject({
      title: "Synthetic Camporee",
      description: "Three days outdoors.",
      startsOn: "2026-10-09",
      endsOn: "2026-10-11",
      timeLabel: "",
      status: "SCHEDULED",
      repeatRule: null,
    });
  });

  it("converts a TZID time to conference dates and builds the time label", () => {
    expect(byUid("timed-tzid-1@synthetic.test")).toMatchObject({
      startsOn: "2026-10-15",
      endsOn: "2026-10-15",
      timeLabel: "7:00 PM – 9:00 PM CDT",
      location: "Synthetic Hall, Room 2",
      linkUrl: "https://example.test/evening",
    });
  });

  it("converts a UTC time into the conference's day, and refuses a non-http link", () => {
    // 23:00Z is 6 PM in Chicago on the 20th; the end is 8 PM.
    expect(byUid("timed-utc-1@synthetic.test")).toMatchObject({ startsOn: "2026-10-20", endsOn: "2026-10-20", timeLabel: "6:00 PM – 8:00 PM CDT", linkUrl: null });
  });

  it("reads a floating time as conference time, and a late-evening UTC start as the conference's own day", () => {
    const feed = parseIcsFeed(wrap("UID:float\r\nDTSTART:20261015T090000\r\nDTEND:20261015T100000\r\nSUMMARY:Float", "UID:late\r\nDTSTART:20261016T030000Z\r\nDTEND:20261016T040000Z\r\nSUMMARY:Late"));
    expect(feed.entries[0]).toMatchObject({ startsOn: "2026-10-15", timeLabel: "9:00 AM – 10:00 AM CDT" });
    // 03:00Z on the 16th is still the evening of the 15th in Chicago.
    expect(feed.entries[1]).toMatchObject({ startsOn: "2026-10-15", endsOn: "2026-10-15" });
  });

  it("treats a timed end exactly at midnight as the previous day", () => {
    const feed = parseIcsFeed(wrap("UID:m\r\nDTSTART;TZID=America/Chicago:20261015T220000\r\nDTEND;TZID=America/Chicago:20261016T000000\r\nSUMMARY:Late show"));
    expect(feed.entries[0]).toMatchObject({ startsOn: "2026-10-15", endsOn: "2026-10-15" });
  });

  it("keeps a multi-day timed item as a date range with no time label", () => {
    const feed = parseIcsFeed(wrap("UID:m\r\nDTSTART;TZID=America/Chicago:20261015T180000\r\nDTEND;TZID=America/Chicago:20261017T120000\r\nSUMMARY:Retreat"));
    expect(feed.entries[0]).toMatchObject({ startsOn: "2026-10-15", endsOn: "2026-10-17", timeLabel: "" });
  });

  it("maps STATUS:CANCELLED", () => {
    expect(byUid("cancelled-1@synthetic.test")).toMatchObject({ status: "CANCELLED", startsOn: "2026-11-05", endsOn: "2026-11-05" });
  });

  it("unfolds long lines, unescapes text, strips HTML and ignores VALARM, VTODO and VTIMEZONE", () => {
    const folded = byUid("folded-1@synthetic.test");
    expect(folded?.title).toBe("A title the sender folded across several physical lines so that it only reads correctly once unfolded, with a comma; and a semicolon");
    expect(folded?.description).toBe("Bring snacks & water\n\nSecond line\nThird line");
    expect(folded?.description).not.toContain("alarm");
    expect(parsed.entries.some((entry) => entry.uid === "todo-1@synthetic.test")).toBe(false);
  });

  it("skips an event with no UID, with a warning", () => {
    expect(parsed.entries.some((entry) => entry.title === "No unique id")).toBe(false);
    expect(parsed.warnings.some((warning) => warning.includes("No unique id") && warning.includes("skipped"))).toBe(true);
  });

  it("keeps only the first date of an unsupported RRULE, with a warning", () => {
    expect(byUid("monthly-weird-1@synthetic.test")).toMatchObject({ repeatRule: null, startsOn: "2026-12-03" });
    expect(parsed.warnings.some((warning) => warning.includes("First Tuesday") && warning.includes("first date"))).toBe(true);
  });

  it("caps long descriptions and titles", () => {
    const feed = parseIcsFeed(wrap(`UID:long\r\nDTSTART;VALUE=DATE:20261201\r\nSUMMARY:${"T".repeat(300)}\r\nDESCRIPTION:${"d".repeat(5000)}`));
    expect(feed.entries[0].title.length).toBeLessThanOrEqual(140);
    expect(feed.entries[0].description.length).toBeLessThanOrEqual(2000);
  });

  it("gives an untitled item a placeholder title", () => {
    expect(parseIcsFeed(wrap("UID:x\r\nDTSTART;VALUE=DATE:20261201")).entries[0].title).toBe("(No title)");
  });
});

describe("ICS import: repeats", () => {
  const weekly = byUid("weekly-1@synthetic.test");

  it("maps the RRULE and every EXDATE form onto the repeat model", () => {
    expect(weekly?.repeatRule).toBe("FREQ=WEEKLY;BYDAY=TU;WKST=MO;COUNT=6");
    expect(weekly?.startsOn).toBe("2026-10-06");
    // Two comma-separated EXDATEs, a second EXDATE line, and the overridden occurrence's own date (Nov 10).
    expect(weekly?.repeatExceptions).toEqual(["2026-10-13", "2026-10-20", "2026-10-27", "2026-11-10"]);
  });

  it("expands to the occurrences the feed means", () => {
    const rule = parseRepeatRule(weekly!.repeatRule);
    const dates = expandOccurrences(weekly!, rule, weekly!.repeatExceptions, "2026-10-01", "2026-12-31").map((occurrence) => occurrence.startsOn);
    // COUNT=6: Oct 6, 13, 20, 27, Nov 3, Nov 10; four are skipped (Nov 10 is replaced by the override item on Nov 11).
    expect(dates).toEqual(["2026-10-06", "2026-11-03"]);
  });

  it("makes a RECURRENCE-ID override its own item and skips that date in the series", () => {
    const override = parsed.entries.find((entry) => entry.uid === "weekly-1@synthetic.test" && entry.recurrenceId !== "");
    expect(override).toMatchObject({ title: "Weekly prayer (moved)", startsOn: "2026-11-11", repeatRule: null });
    expect(override?.recurrenceId).toBe("2026-11-11T00:00:00.000Z");
    const feed = parseIcsFeed(wrap(
      "UID:s\r\nDTSTART;VALUE=DATE:20261001\r\nRRULE:FREQ=DAILY;COUNT=5\r\nSUMMARY:Series",
      "UID:s\r\nRECURRENCE-ID;VALUE=DATE:20261003\r\nDTSTART;VALUE=DATE:20261003\r\nSUMMARY:Special",
    ));
    expect(feed.entries.find((entry) => entry.recurrenceId === "")?.repeatExceptions).toEqual(["2026-10-03"]);
    expect(feed.entries.find((entry) => entry.recurrenceId === "2026-10-03")?.title).toBe("Special");
  });

  it("reads a UTC UNTIL as a conference-zone date", () => {
    const feed = parseIcsFeed(wrap("UID:u\r\nDTSTART;TZID=America/Chicago:20261001T190000\r\nDTEND;TZID=America/Chicago:20261001T200000\r\nRRULE:FREQ=DAILY;UNTIL=20261004T010000Z\r\nSUMMARY:Daily"));
    // 01:00Z on the 4th is the evening of the 3rd in Chicago.
    expect(feed.entries[0].repeatRule).toBe("FREQ=DAILY;UNTIL=20261003");
  });

  it("keeps duplicate UIDs to the first, with a warning", () => {
    const feed = parseIcsFeed(wrap("UID:d\r\nDTSTART;VALUE=DATE:20261001\r\nSUMMARY:First", "UID:d\r\nDTSTART;VALUE=DATE:20261002\r\nSUMMARY:Second"));
    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0].title).toBe("First");
    expect(feed.warnings.some((warning) => warning.includes("more than once"))).toBe(true);
  });
});

describe("ICS import: limits and bad input", () => {
  it("rejects something that is not a calendar", () => {
    expect(() => parseIcsFeed("<html>sign in</html>")).toThrow(IcsParseError);
  });

  it("rejects a body over 2 MB", () => {
    expect(() => parseIcsFeed(`BEGIN:VCALENDAR\r\n${"X".repeat(maxFeedBytes)}\r\nEND:VCALENDAR`)).toThrow(/2 MB/);
  });

  it("reads at most 2,000 events and says so", () => {
    const events = Array.from({ length: maxFeedEvents + 5 }, (_, index) => `UID:e${index}\r\nDTSTART;VALUE=DATE:20261001\r\nSUMMARY:E${index}`);
    const feed = parseIcsFeed(wrap(...events));
    expect(feed.entries).toHaveLength(maxFeedEvents);
    expect(feed.warnings.some((warning) => warning.includes("2000"))).toBe(true);
  });

  it("warns once about an unknown time zone and falls back to conference time", () => {
    const feed = parseIcsFeed(wrap("UID:z\r\nDTSTART;TZID=Not/AZone:20261015T090000\r\nDTEND;TZID=Not/AZone:20261015T100000\r\nSUMMARY:Z"));
    expect(feed.entries[0].timeLabel).toBe("9:00 AM – 10:00 AM CDT");
    expect(feed.warnings).toHaveLength(1);
  });
});
