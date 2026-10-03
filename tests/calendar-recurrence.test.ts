import { describe, expect, it } from "vitest";
import {
  describeRepeat,
  expandOccurrences,
  expansionDiagnostics,
  parseRepeatRule,
  previewOccurrences,
  repeatStartProblem,
  serializeRepeatRule,
  type RepeatRule,
} from "@/modules/calendar/recurrence";

function rule(overrides: Partial<RepeatRule>): RepeatRule {
  return { frequency: "DAILY", interval: 1, weekdays: [], until: null, count: null, weekStart: 0, ...overrides };
}

const starts = (occurrences: Array<{ startsOn: string }>) => occurrences.map((occurrence) => occurrence.startsOn);

describe("repeat rules as RRULE", () => {
  it("round-trips every frequency through the RRULE string", () => {
    for (const value of [
      "FREQ=DAILY",
      "FREQ=DAILY;INTERVAL=3;COUNT=5",
      "FREQ=WEEKLY;BYDAY=MO,WE,FR;WKST=SU;UNTIL=20270601",
      "FREQ=WEEKLY;WKST=MO",
      "FREQ=MONTHLY;INTERVAL=2",
      "FREQ=YEARLY;COUNT=4",
    ]) {
      expect(serializeRepeatRule(parseRepeatRule(value)!)).toBe(value);
    }
  });

  it("always writes WKST=SU for a weekly rule the editor makes, and no WKST for other frequencies", () => {
    expect(serializeRepeatRule(rule({ frequency: "WEEKLY", weekdays: [1] }))).toBe("FREQ=WEEKLY;BYDAY=MO;WKST=SU");
    expect(serializeRepeatRule(rule({ frequency: "MONTHLY" }))).toBe("FREQ=MONTHLY");
  });

  it("reads a missing WKST as Monday, per RFC 5545, and accepts SU", () => {
    expect(parseRepeatRule("FREQ=WEEKLY;BYDAY=SU")?.weekStart).toBe(1);
    expect(parseRepeatRule("FREQ=WEEKLY;WKST=MO")?.weekStart).toBe(1);
    expect(parseRepeatRule("FREQ=WEEKLY;WKST=SU")?.weekStart).toBe(0);
    expect(parseRepeatRule("FREQ=WEEKLY;WKST=WE")).toBeNull();
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

describe("weekly intervals and WKST", () => {
  // 2026-10-05 is a Monday. BYDAY=MO,SU every 2 weeks: Sunday sits at the start of a Sunday-week
  // but the end of a Monday-week, so the two WKST values disagree.
  const monday = { startsOn: "2026-10-05", endsOn: "2026-10-05" };
  const days = { frequency: "WEEKLY" as const, interval: 2, weekdays: [0, 1] };

  it("with WKST=SU, Sunday opens the week it belongs to", () => {
    // Weeks: Sun 10-04..Sat 10-10 (taken), skip 10-11..17, take 10-18..24 (Sun 10-18, Mon 10-19).
    expect(starts(expandOccurrences(monday, rule({ ...days, weekStart: 0 }), [], "2026-10-01", "2026-11-03")))
      .toEqual(["2026-10-05", "2026-10-18", "2026-10-19", "2026-11-01", "2026-11-02"]);
  });

  it("with WKST=MO, Sunday closes the week it belongs to", () => {
    // Weeks: Mon 10-05..Sun 10-11 (taken: Mon 10-05, Sun 10-11), skip, take 10-19 and 10-25.
    expect(starts(expandOccurrences(monday, rule({ ...days, weekStart: 1 }), [], "2026-10-01", "2026-11-03")))
      .toEqual(["2026-10-05", "2026-10-11", "2026-10-19", "2026-10-25", "2026-11-02"]);
  });

  it("counts correctly through a jump (first week holds fewer dates)", () => {
    const all = starts(expandOccurrences(monday, rule({ ...days, count: 7 }), [], "2026-10-01", "2030-01-01"));
    expect(all).toHaveLength(7);
    // The same rule read through a far-away window returns the tail of that list, not a fresh count.
    const late = starts(expandOccurrences(monday, rule({ ...days, count: 7 }), [], all[5], "2030-01-01"));
    expect(late).toEqual(all.slice(5));
    expect(starts(expandOccurrences(monday, rule({ ...days, count: 7 }), [], "2028-01-01", "2030-01-01"))).toEqual([]);
  });
});

describe("start date against the weekdays", () => {
  it("requires a weekly repeat with weekdays to include the start date's weekday", () => {
    expect(repeatStartProblem(rule({ frequency: "WEEKLY", weekdays: [1, 3] }), "2026-10-06")).toMatch(/Tue/);
    expect(repeatStartProblem(rule({ frequency: "WEEKLY", weekdays: [2, 3] }), "2026-10-06")).toBeNull();
    expect(repeatStartProblem(rule({ frequency: "WEEKLY" }), "2026-10-06")).toBeNull();
    expect(repeatStartProblem(rule({ frequency: "DAILY", until: "2026-10-01" }), "2026-10-06")).toMatch(/end before/);
  });
});

describe("cost of a far-off window", () => {
  it("expands a daily rule from 2000 with no end in a bounded number of steps", () => {
    expansionDiagnostics.steps = 0;
    const result = expandOccurrences({ startsOn: "2000-01-01", endsOn: "2000-01-01" }, rule({}), [], "2100-12-01", "2100-12-31");
    expect(result).toHaveLength(31);
    expect(expansionDiagnostics.steps).toBeLessThan(100);
  });

  it("jumps weekly rules, and daily rules with a count, too", () => {
    expansionDiagnostics.steps = 0;
    const weekly = expandOccurrences({ startsOn: "2000-01-03", endsOn: "2000-01-03" }, rule({ frequency: "WEEKLY", weekdays: [1, 3] }), [], "2100-12-01", "2100-12-31");
    expect(weekly.length).toBeGreaterThan(5);
    expect(expansionDiagnostics.steps).toBeLessThan(100);
    expansionDiagnostics.steps = 0;
    expect(expandOccurrences({ startsOn: "2000-01-01", endsOn: "2000-01-01" }, rule({ count: 40000 }), [], "2100-12-01", "2100-12-31").length).toBeGreaterThan(0);
    expect(expansionDiagnostics.steps).toBeLessThan(100);
  });

  it("gives the same dates with the jump as stepping from the start", () => {
    const sample = rule({ frequency: "WEEKLY", interval: 3, weekdays: [1, 4, 6] });
    const item = { startsOn: "2026-10-05", endsOn: "2026-10-06" };
    const everything = starts(expandOccurrences(item, sample, [], "2026-01-01", "2027-12-31"));
    for (const [from, to] of [["2027-02-10", "2027-03-20"], ["2026-12-31", "2027-01-15"]]) {
      const windowed = starts(expandOccurrences(item, sample, [], from, to));
      expect(windowed).toEqual(everything.filter((date) => date <= to && date >= addDay(from, -1)));
    }
  });
});

function addDay(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

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
