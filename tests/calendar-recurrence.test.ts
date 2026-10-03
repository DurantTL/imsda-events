import { describe, expect, it } from "vitest";
import {
  describeRepeat,
  expandOccurrences,
  parseRepeatRule,
  previewOccurrences,
  serializeRepeatRule,
  type RepeatRule,
} from "@/modules/calendar/recurrence";

function rule(overrides: Partial<RepeatRule>): RepeatRule {
  return { frequency: "DAILY", interval: 1, weekdays: [], until: null, count: null, ...overrides };
}

const starts = (occurrences: Array<{ startsOn: string }>) => occurrences.map((occurrence) => occurrence.startsOn);

describe("repeat rules as RRULE", () => {
  it("round-trips every frequency through the RRULE string", () => {
    for (const value of [
      "FREQ=DAILY",
      "FREQ=DAILY;INTERVAL=3;COUNT=5",
      "FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20270601",
      "FREQ=MONTHLY;INTERVAL=2",
      "FREQ=YEARLY;COUNT=4",
    ]) {
      expect(serializeRepeatRule(parseRepeatRule(value)!)).toBe(value);
    }
  });

  it("reads an imported RRULE with a UTC UNTIL and a leading RRULE: prefix", () => {
    expect(parseRepeatRule("RRULE:FREQ=WEEKLY;UNTIL=20270601T050000Z;WKST=SU")).toMatchObject({ frequency: "WEEKLY", until: "2027-06-01" });
  });

  it("refuses rules outside the supported subset", () => {
    for (const value of ["", "FREQ=HOURLY", "FREQ=MONTHLY;BYDAY=MO", "FREQ=DAILY;BYMONTH=1", "FREQ=DAILY;COUNT=2;UNTIL=20270101", "FREQ=DAILY;INTERVAL=0", "INTERVAL=2"]) {
      expect(parseRepeatRule(value)).toBeNull();
    }
  });

  it("describes a repeat in words", () => {
    expect(describeRepeat(rule({ frequency: "WEEKLY", interval: 2, weekdays: [1, 3], count: 6 }))).toBe("Every 2 weeks on Mon, Wed, 6 times");
    expect(describeRepeat(rule({ frequency: "YEARLY" }))).toBe("Yearly");
  });
});

describe("expanding occurrences", () => {
  const first = { startsOn: "2026-10-05", endsOn: "2026-10-05" }; // a Monday

  it("repeats daily with an interval", () => {
    expect(starts(expandOccurrences(first, rule({ interval: 3 }), [], "2026-10-01", "2026-10-20")))
      .toEqual(["2026-10-05", "2026-10-08", "2026-10-11", "2026-10-14", "2026-10-17", "2026-10-20"]);
  });

  it("repeats weekly on the start weekday, or on chosen weekdays", () => {
    expect(starts(expandOccurrences(first, rule({ frequency: "WEEKLY" }), [], "2026-10-01", "2026-10-31")))
      .toEqual(["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]);
    expect(starts(expandOccurrences(first, rule({ frequency: "WEEKLY", weekdays: [1, 3] }), [], "2026-10-01", "2026-10-18")))
      .toEqual(["2026-10-05", "2026-10-07", "2026-10-12", "2026-10-14"]);
  });

  it("never lists weekdays before the first date, and honours a weekly interval", () => {
    // Wednesday start, Mon/Wed picked: the Monday of that week is before the start.
    expect(starts(expandOccurrences({ startsOn: "2026-10-07", endsOn: "2026-10-07" }, rule({ frequency: "WEEKLY", interval: 2, weekdays: [1, 3] }), [], "2026-10-01", "2026-11-10")))
      .toEqual(["2026-10-07", "2026-10-19", "2026-10-21", "2026-11-02", "2026-11-04"]);
  });

  it("repeats monthly on the same day, skipping months without it", () => {
    expect(starts(expandOccurrences({ startsOn: "2026-01-31", endsOn: "2026-01-31" }, rule({ frequency: "MONTHLY" }), [], "2026-01-01", "2026-06-30")))
      .toEqual(["2026-01-31", "2026-03-31", "2026-05-31"]);
    expect(starts(expandOccurrences({ startsOn: "2026-11-15", endsOn: "2026-11-15" }, rule({ frequency: "MONTHLY", interval: 2 }), [], "2026-11-01", "2027-06-30")))
      .toEqual(["2026-11-15", "2027-01-15", "2027-03-15", "2027-05-15"]);
  });

  it("repeats yearly, skipping February 29 in common years", () => {
    expect(starts(expandOccurrences({ startsOn: "2026-12-25", endsOn: "2026-12-25" }, rule({ frequency: "YEARLY" }), [], "2026-01-01", "2029-12-31")))
      .toEqual(["2026-12-25", "2027-12-25", "2028-12-25", "2029-12-25"]);
    expect(starts(expandOccurrences({ startsOn: "2028-02-29", endsOn: "2028-02-29" }, rule({ frequency: "YEARLY" }), [], "2028-01-01", "2036-12-31")))
      .toEqual(["2028-02-29", "2032-02-29", "2036-02-29"]);
  });

  it("ends on an until date (inclusive) or after a count", () => {
    expect(starts(expandOccurrences(first, rule({ frequency: "WEEKLY", until: "2026-10-19" }), [], "2026-10-01", "2027-01-01")))
      .toEqual(["2026-10-05", "2026-10-12", "2026-10-19"]);
    expect(starts(expandOccurrences(first, rule({ count: 3 }), [], "2026-10-01", "2027-01-01")))
      .toEqual(["2026-10-05", "2026-10-06", "2026-10-07"]);
  });

  it("counts a skipped occurrence toward COUNT, as RFC 5545 does", () => {
    expect(starts(expandOccurrences(first, rule({ count: 3 }), ["2026-10-06"], "2026-10-01", "2027-01-01")))
      .toEqual(["2026-10-05", "2026-10-07"]);
  });

  it("leaves out skipped dates", () => {
    expect(starts(expandOccurrences(first, rule({ frequency: "WEEKLY" }), ["2026-10-12"], "2026-10-01", "2026-10-31")))
      .toEqual(["2026-10-05", "2026-10-19", "2026-10-26"]);
  });

  it("only returns what overlaps the window, even for an old start", () => {
    const old = { startsOn: "2020-01-06", endsOn: "2020-01-06" };
    expect(starts(expandOccurrences(old, rule({ frequency: "WEEKLY" }), [], "2026-10-01", "2026-10-14")))
      .toEqual(["2026-10-05", "2026-10-12"]);
  });

  it("repeats a multi-day item at its full length and includes one still under way", () => {
    const camp = { startsOn: "2026-10-09", endsOn: "2026-10-11" };
    expect(expandOccurrences(camp, rule({ frequency: "WEEKLY" }), [], "2026-10-17", "2026-10-17"))
      .toEqual([{ startsOn: "2026-10-16", endsOn: "2026-10-18" }]);
  });

  it("is the item itself when it doesn't repeat", () => {
    expect(expandOccurrences(first, null, [], "2026-10-01", "2026-10-31")).toEqual([first]);
    expect(expandOccurrences(first, null, [], "2026-11-01", "2026-11-30")).toEqual([]);
  });

  it("keeps all-day dates fixed across daylight saving changes", () => {
    // US clocks spring forward on 2027-03-14 and fall back on 2026-11-01 (America/Chicago).
    expect(starts(expandOccurrences({ startsOn: "2027-03-12", endsOn: "2027-03-12" }, rule({}), [], "2027-03-12", "2027-03-16")))
      .toEqual(["2027-03-12", "2027-03-13", "2027-03-14", "2027-03-15", "2027-03-16"]);
    expect(starts(expandOccurrences({ startsOn: "2026-10-26", endsOn: "2026-10-26" }, rule({ frequency: "WEEKLY" }), [], "2026-10-20", "2026-11-10")))
      .toEqual(["2026-10-26", "2026-11-02", "2026-11-09"]);
    expect(starts(expandOccurrences({ startsOn: "2027-01-14", endsOn: "2027-01-14" }, rule({ frequency: "MONTHLY" }), [], "2027-01-01", "2027-04-30")))
      .toEqual(["2027-01-14", "2027-02-14", "2027-03-14", "2027-04-14"]);
  });

  it("previews occurrences with the skipped ones flagged", () => {
    expect(previewOccurrences(first, rule({ frequency: "WEEKLY" }), ["2026-10-12"], 3))
      .toEqual([
        { startsOn: "2026-10-05", skipped: false },
        { startsOn: "2026-10-12", skipped: true },
        { startsOn: "2026-10-19", skipped: false },
      ]);
  });
});
