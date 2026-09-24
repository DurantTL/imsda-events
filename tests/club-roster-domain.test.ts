import { describe, expect, it } from "vitest";
import {
  ageOn,
  birthDateProblem,
  centuryForTwoDigitYear,
  clubYearFor,
  missingRosterFields,
  parseCalendarDate,
  parseRosterBirthDateInput,
} from "@/modules/club-rosters/domain";
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
    const base = { firstName: "Test", lastName: "Youth", birthDate: "2014-06-15", attendeeType: "YOUTH", gender: "FEMALE" };
    expect(rosterMemberInputSchema.parse(base)).toMatchObject({ role: "Pathfinder", gender: "FEMALE" });
    expect(() => rosterMemberInputSchema.parse({ ...base, allergies: "none" })).toThrow();
    expect(() => rosterMemberUpdateSchema.parse({ status: "REMOVED" })).toThrow();
  });

  it("saves an empty role as Pathfinder (#424)", () => {
    const base = { firstName: "Test", lastName: "Youth", birthDate: "2014-06-15", attendeeType: "YOUTH", gender: "MALE" };
    expect(rosterMemberInputSchema.parse({ ...base, role: "" })).toMatchObject({ role: "Pathfinder" });
    expect(rosterMemberInputSchema.parse({ ...base, role: "  " })).toMatchObject({ role: "Pathfinder" });
    expect(rosterMemberInputSchema.parse({ ...base, role: "Counselor" })).toMatchObject({ role: "Counselor" });
    expect(rosterMemberUpdateSchema.parse({ role: "" })).toEqual({ role: "Pathfinder" });
    // A status-only edit (deactivate/reactivate) doesn't touch role at all.
    expect(rosterMemberUpdateSchema.parse({ status: "INACTIVE" })).toEqual({ status: "INACTIVE" });
  });

  it("requires Male or Female to add or edit someone, but not to only change status (#424)", () => {
    const base = { firstName: "Test", lastName: "Youth", birthDate: "2014-06-15", attendeeType: "YOUTH" };
    // Adding someone always needs a gender field; leaving it out or sending null both fail the same way.
    expect(() => rosterMemberInputSchema.parse(base)).toThrow(/Choose Male or Female/);
    expect(() => rosterMemberInputSchema.parse({ ...base, gender: null })).toThrow(/Choose Male or Female/);
    expect(rosterMemberInputSchema.parse({ ...base, gender: "FEMALE" })).toMatchObject({ gender: "FEMALE" });

    // Present but null (a full edit with nothing chosen) is rejected...
    expect(() => rosterMemberUpdateSchema.parse({ gender: null })).toThrow(/Choose Male or Female/);
    // ...but omitted entirely (deactivate/reactivate, or any other partial edit) is fine.
    expect(rosterMemberUpdateSchema.parse({ status: "ACTIVE" })).toEqual({ status: "ACTIVE" });
    expect(rosterMemberUpdateSchema.parse({ gender: "MALE" })).toEqual({ gender: "MALE" });
  });

  it("parses M/D/YYYY, M/D/YY, and ISO birth dates the same way everywhere (#424)", () => {
    expect(parseRosterBirthDateInput("04/17/2014")).toBe("2014-04-17");
    expect(parseRosterBirthDateInput("4/17/2014")).toBe("2014-04-17");
    expect(parseRosterBirthDateInput("2014-04-17")).toBe("2014-04-17");
    // Two-digit years: no later than this year's own last two digits is 20YY, otherwise 19YY.
    expect(parseRosterBirthDateInput("4/17/14", 2026)).toBe("2014-04-17");
    expect(parseRosterBirthDateInput("3/2/68", 2026)).toBe("1968-03-02");
    expect(parseRosterBirthDateInput("3/2/26", 2026)).toBe("2026-03-02");
    expect(centuryForTwoDigitYear(26, 2026)).toBe(2026);
    expect(centuryForTwoDigitYear(27, 2026)).toBe(1927);
    // Impossible dates, and years before 1900, are rejected.
    expect(parseRosterBirthDateInput("2/30/2014")).toBeNull();
    expect(parseRosterBirthDateInput("13/1/2014")).toBeNull();
    expect(parseRosterBirthDateInput("not a date")).toBeNull();
    expect(parseRosterBirthDateInput("1/1/1899")).toBeNull();
    expect(parseRosterBirthDateInput("1/1/1900")).toBe("1900-01-01");
  });

  it("flags a roster member missing any field the roster collects (#424)", () => {
    const complete = { attendeeType: "YOUTH", role: "Pathfinder", classLevel: "FRIEND", gender: "FEMALE", birthDateNeeded: false };
    expect(missingRosterFields(complete)).toEqual([]);
    expect(missingRosterFields({ ...complete, birthDateNeeded: true })).toEqual(["Birth date"]);
    expect(missingRosterFields({ ...complete, gender: null, classLevel: null, role: "" })).toEqual(["Gender", "Current class", "Role"]);
    expect(missingRosterFields({ attendeeType: null, role: "", classLevel: null, gender: null, birthDateNeeded: true }))
      .toEqual(["Birth date", "Gender", "Current class", "Role", "Type"]);
  });
});
