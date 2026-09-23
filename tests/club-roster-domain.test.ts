import { describe, expect, it } from "vitest";
import { ageOn, birthDateProblem, clubYearFor, parseCalendarDate } from "@/modules/club-rosters/domain";
import { rosterMemberInputSchema, rosterMemberUpdateSchema } from "@/modules/club-rosters/schemas";

describe("club roster rules", () => {
  it("names the club year that runs September through August", () => {
    expect(clubYearFor(new Date("2026-08-31T12:00:00Z"))).toBe("2025-26");
    expect(clubYearFor(new Date("2026-09-01T12:00:00Z"))).toBe("2026-27");
    expect(clubYearFor(new Date("2027-04-29T12:00:00Z"))).toBe("2026-27");
    expect(clubYearFor(new Date("2099-12-01T00:00:00Z"))).toBe("2099-00");
  });

  it("computes whole-year age on a calendar date", () => {
    expect(ageOn("2014-12-06", "2026-12-05")).toBe(11);
    expect(ageOn("2014-12-06", "2026-12-06")).toBe(12);
    expect(ageOn("2016-02-29", "2027-02-28")).toBe(10);
    expect(ageOn("2016-02-29", "2027-03-01")).toBe(11);
    expect(ageOn("2016-02-30", "2027-03-01")).toBeNull();
  });

  it("accepts only real, past, plausible birth dates", () => {
    expect(parseCalendarDate("2015-02-29")).toBeNull();
    expect(birthDateProblem("2015-02-29", "2026-10-01")).toMatch(/real birth date/);
    expect(birthDateProblem("2026-10-02", "2026-10-01")).toMatch(/future/);
    expect(birthDateProblem("1890-01-01", "2026-10-01")).toMatch(/year/);
    expect(birthDateProblem("2014-06-15", "2026-10-01")).toBeNull();
  });

  it("keeps medical and unknown fields off the roster input", () => {
    const base = { firstName: "Test", lastName: "Youth", birthDate: "2014-06-15", attendeeType: "YOUTH" };
    expect(rosterMemberInputSchema.parse(base)).toMatchObject({ role: "", gender: null });
    expect(() => rosterMemberInputSchema.parse({ ...base, allergies: "none" })).toThrow();
    expect(() => rosterMemberUpdateSchema.parse({ status: "REMOVED" })).toThrow();
  });
});
