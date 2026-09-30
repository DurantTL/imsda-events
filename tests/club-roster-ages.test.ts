import { describe, expect, it } from "vitest";
import { parseTypedAge, reportedAgeDefaults, withReportedAgePrefill, withRosterAge } from "@/modules/club-registrations/roster-ages";

const roster = [
  { memberId: "m1", ageOnEventDate: 12, reportedAge: null },
  { memberId: "m2", ageOnEventDate: null, reportedAge: 15 },
  { memberId: "m3", ageOnEventDate: null, reportedAge: null },
  { memberId: "m4", ageOnEventDate: 30, reportedAge: 99 },
];
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

  it("starts from the reported age only for people going with no birth date and no typed age", () => {
    expect(reportedAgeDefaults(roster, ["m1", "m2", "m3", "m4"], {})).toEqual({ m2: 15 });
    expect(reportedAgeDefaults(roster, ["m1", "m3"], {})).toEqual({});
    expect(reportedAgeDefaults(roster, ["m2"], { m2: 9 })).toEqual({});
    const prefilled = withReportedAgePrefill(empty, roster, ["m1", "m2", "m4"], "attendee_age");
    expect(prefilled.rosterAges).toEqual({ m2: 15 });
    expect(prefilled.attendeeResponses.m2).toEqual({ attendee_age: "15" });
  });
});
