import { describe, expect, it } from "vitest";
import {
  isAlternateAnswer,
  teamAgeDate,
  teamRoleFor,
  teamRuleProblems,
  type TeamPerson,
} from "@/modules/club-teams/rules";

/** The team rules (#809): size, the alternate, the age date, and who is a coach. Synthetic names only. */

const pbe = { minTeamMembers: 2, maxTeamMembers: 7, maxAlternates: 1, maxMemberAge: 19, ageAsOf: "2026-01-01" };
const member = (name: string, overrides: Partial<TeamPerson> = {}): TeamPerson => ({ name, role: "MEMBER", alternate: false, age: 14, ...overrides });
const coach = (name: string, overrides: Partial<TeamPerson> = {}): TeamPerson => ({ name, role: "COACH", alternate: false, age: 40, ...overrides });
const team = (count: number) => Array.from({ length: count }, (_, index) => member(`Member ${index + 1}`));
const problems = (people: TeamPerson[], settings = pbe) => teamRuleProblems(settings, people, "2027-01-16");

describe("team size", () => {
  it.each([2, 3, 6, 7])("accepts %i team members", (count) => {
    expect(problems(team(count))).toEqual([]);
  });

  it("refuses one team member, and says coaches do not count", () => {
    expect(problems([member("Alex Sample"), coach("Pat Coach")])).toEqual([
      "A team needs at least 2 team members; this one has 1. Coaches don't count. Add team members from your roster or as extra people.",
    ]);
  });

  it("refuses no team members at all", () => {
    expect(problems([])[0]).toContain("this one has 0.");
  });

  it("refuses eight team members, counting the alternate among them, and says how many to remove", () => {
    const people = [...team(7), member("Eighth Person")];
    expect(problems(people)).toEqual([
      "A team can have at most 7 team members, including the alternate; this one has 8. Remove 1 team member.",
    ]);
  });

  it("does not count coaches toward the most, however many there are", () => {
    expect(problems([...team(7), coach("Coach One"), coach("Coach Two"), coach("Coach Three")])).toEqual([]);
  });

  it("holds an event with no limits, or no settings at all, to nothing", () => {
    expect(teamRuleProblems(null, [], "2027-01-16")).toEqual([]);
    expect(teamRuleProblems({ ...pbe, minTeamMembers: null, maxTeamMembers: null }, [member("Only One")], "2027-01-16")).toEqual([]);
  });
});

describe("the alternate", () => {
  it("accepts one alternate among the team members", () => {
    expect(problems([...team(6), member("Alt Person", { alternate: true })])).toEqual([]);
  });

  it("refuses a second alternate, naming both", () => {
    expect(problems([member("Alex Sample", { alternate: true }), member("Casey Example", { alternate: true }), member("Third Person")])).toEqual([
      "Only 1 team member can be the alternate, but 2 are marked: Alex Sample, Casey Example. Untick Alternate for the others.",
    ]);
  });

  it("refuses an alternate on an event that has none", () => {
    expect(problems([member("Alex Sample", { alternate: true }), member("Casey Example")], { ...pbe, maxAlternates: 0 })).toEqual([
      "This event has no alternate, so Alex Sample can't be marked the alternate.",
    ]);
  });

  it("refuses a coach marked as the alternate", () => {
    expect(problems([...team(2), coach("Pat Coach", { alternate: true })])).toEqual([
      "Pat Coach is a coach, so can't be the alternate. Untick Alternate for them.",
    ]);
  });

  it("reads the alternate answer from a checked box or a stored Yes", () => {
    expect([true, "Yes", "true", " yes "].every(isAlternateAnswer)).toBe(true);
    expect([false, "No", "", null, undefined, 1].some(isAlternateAnswer)).toBe(false);
  });
});

describe("the age limit, counted on the age date", () => {
  it("refuses a team member who is 20 on the age date, by name, with the date", () => {
    expect(problems([member("Casey Example", { age: 20 }), member("Alex Sample")])).toEqual([
      "Casey Example is 20 on January 1, 2026, and a team member can be at most 19. Make them a coach, or remove them from the team.",
    ]);
  });

  it("accepts 19, and does not hold a coach to it", () => {
    expect(problems([member("Alex Sample", { age: 19 }), member("Casey Example"), coach("Pat Coach", { age: 52 })])).toEqual([]);
  });

  it("says so when a team member's age is not known, rather than letting it through", () => {
    expect(problems([member("Morgan Unknown", { age: null }), member("Alex Sample")])).toEqual([
      "Morgan Unknown's age on January 1, 2026 isn't known, so the age limit can't be checked. Enter their age on January 1, 2026.",
    ]);
  });

  it("names the event date when the event sets no age date of its own", () => {
    expect(teamRuleProblems({ ...pbe, ageAsOf: null }, [member("Casey Example", { age: 21 }), member("Alex Sample")], "2027-01-16")[0]).toContain("on January 16, 2027");
    expect(teamAgeDate({ ageAsOf: null }, "2027-01-16")).toBe("2027-01-16");
    expect(teamAgeDate({ ageAsOf: "2026-01-01" }, "2027-01-16")).toBe("2026-01-01");
    expect(teamAgeDate(null, "2027-01-16")).toBe("2027-01-16");
  });

  it("reports every problem at once, each naming its person", () => {
    const list = problems([member("Casey Example", { age: 20, alternate: true }), member("Alex Sample", { alternate: true })]);
    expect(list).toHaveLength(2);
    expect(list.join(" ")).toContain("Casey Example");
  });
});

describe("who is a coach", () => {
  it("counts everyone under 18 as a team member, whatever the roster or the form says", () => {
    // A director cannot dodge the size limit by marking a 13-year-old as staff.
    expect(teamRoleFor({ responses: {}, rosterAttendeeType: "STAFF", age: 13 })).toBe("MEMBER");
    expect(teamRoleFor({ responses: { attendee_type: "Coach" }, rosterAttendeeType: "YOUTH", age: 14 })).toBe("MEMBER");
    expect(teamRoleFor({ responses: { attendee_type: "Coach" }, age: 15 })).toBe("MEMBER");
    expect(teamRoleFor({ responses: {}, rosterAttendeeType: "UNDERAGE", age: 6 })).toBe("MEMBER");
  });

  it("lets an 18 or 19 year old Pathfinder or TLT be a team member, even when staff on the roster", () => {
    expect(teamRoleFor({ responses: { attendee_type: "TLT" }, rosterAttendeeType: "STAFF", maxMemberAge: 19, age: 18 })).toBe("MEMBER");
    expect(teamRoleFor({ responses: {}, rosterAttendeeType: "STAFF", rosterClassLevel: "TLT", maxMemberAge: 19, age: 19 })).toBe("MEMBER");
    expect(teamRoleFor({ responses: { attendee_type: "Pathfinder" }, age: 19 })).toBe("MEMBER");
    expect(teamRoleFor({ responses: { attendee_type: "Pathfinder" }, rosterAttendeeType: "YOUTH", maxMemberAge: 19, age: 19 })).toBe("MEMBER");
  });

  it("makes an 18 or older person a coach unless given a team member's role", () => {
    expect(teamRoleFor({ responses: {}, rosterAttendeeType: "YOUTH", maxMemberAge: 19, age: 18 })).toBe("COACH");
    expect(teamRoleFor({ responses: {}, age: 35 })).toBe("COACH");
    expect(teamRoleFor({ responses: { attendee_type: "Coach" }, age: 35 })).toBe("COACH");
    expect(teamRoleFor({ responses: { attendee_type: "Coach" }, rosterAttendeeType: "STAFF", age: 38 })).toBe("COACH");
  });

  it("makes anyone older than the oldest team member age a coach, even answering Pathfinder", () => {
    expect(teamRoleFor({ responses: { attendee_type: "Pathfinder" }, rosterAttendeeType: "YOUTH", maxMemberAge: 19, age: 20 })).toBe("COACH");
    expect(teamRoleFor({ responses: { attendee_type: "TLT" }, maxMemberAge: 19, age: 25 })).toBe("COACH");
  });

  it("follows the roster type when the age is not known", () => {
    expect(teamRoleFor({ responses: {}, rosterAttendeeType: "STAFF", age: null })).toBe("COACH");
    expect(teamRoleFor({ responses: {}, rosterAttendeeType: "ADULT", age: null })).toBe("COACH");
    expect(teamRoleFor({ responses: {}, rosterAttendeeType: "YOUTH", age: null })).toBe("MEMBER");
    expect(teamRoleFor({ responses: {}, age: null })).toBe("MEMBER");
  });
});
