import { describe, expect, it } from "vitest";
import { ageInputProblem, ageInputValue, effectiveRosterAges, parseTypedAge, withRosterAge } from "@/modules/club-registrations/roster-ages";

const person = (memberId: string, ageOnEventDate: number | null, reportedAge: number | null) => ({
  memberId, firstName: "Sam", lastName: memberId.toUpperCase(), ageOnEventDate, reportedAge,
});
const roster = [person("m1", 12, null), person("m2", null, 15), person("m3", null, null), person("m4", 30, 99)];
const empty = { rosterAges: {} as Record<string, number>, attendeeResponses: {} as Record<string, Record<string, unknown>> };

describe("ages typed in for roster people with no birth date (#639)", () => {
  it("accepts only whole numbers from 0 to 120", () => {
    expect(parseTypedAge("12")).toBe(12);
    expect(parseTypedAge("0")).toBe(0);
    expect(parseTypedAge("120")).toBe(120);
    for (const raw of ["", "  ", "121", "-1", "4.5", "abc"]) expect(parseTypedAge(raw)).toBeUndefined();
  });

  it("sets and clears an age, mirroring it into the form's age answer", () => {
    const set = withRosterAge({ ...empty, attendeeResponses: { m3: { diet: "None" } } }, "m3", 14, "attendee_age");
    expect(set.rosterAges).toEqual({ m3: 14 });
    expect(set.attendeeResponses.m3).toEqual({ diet: "None", attendee_age: "14" });
    const cleared = withRosterAge(set, "m3", undefined, "attendee_age");
    expect(cleared.rosterAges).toEqual({});
    expect(cleared.attendeeResponses.m3).toEqual({ diet: "None" });
    expect(withRosterAge(empty, "m3", 14, null).attendeeResponses).toEqual({});
  });

  it("starts at the saved age, else the reported age, until the director edits the field", () => {
    expect(ageInputValue(roster[1]!, {}, {})).toBe("15");
    expect(ageInputValue(roster[1]!, {}, { m2: 9 })).toBe("9");
    expect(ageInputValue(roster[2]!, {}, {})).toBe("");
    expect(effectiveRosterAges(roster, ["m1", "m2", "m3", "m4"], {}, {})).toEqual({ m2: 15 });
  });

  it("never falls back to the reported age once the field has been edited", () => {
    // Cleared: blank is a problem, not the reported 15.
    expect(ageInputValue(roster[1]!, { m2: "" }, {})).toBe("");
    expect(ageInputProblem(roster[1]!, { m2: "" }, {})).toContain("Enter");
    expect(effectiveRosterAges(roster, ["m2"], { m2: "" }, {})).toEqual({});
    // Invalid text is reported and is not an age.
    for (const raw of ["121", "4.5", "-2", "x"]) {
      expect(ageInputProblem(roster[1]!, { m2: raw }, {})).toBe("Enter Sam M2's age as a whole number from 0 to 120.");
      expect(effectiveRosterAges(roster, ["m2"], { m2: raw }, {})).toEqual({});
    }
    expect(ageInputProblem(roster[1]!, { m2: "16" }, {})).toBeNull();
    expect(effectiveRosterAges(roster, ["m2"], { m2: "16" }, {})).toEqual({ m2: 16 });
  });

  it("requires an age only for people with no birth date, and blank for one with no reported age is a problem", () => {
    expect(ageInputProblem(roster[2]!, {}, {})).toContain("Sam M3");
    expect(ageInputProblem(roster[0]!, { m1: "" }, {})).toBeNull();
    expect(ageInputProblem(roster[3]!, {}, {})).toBeNull();
  });
});
