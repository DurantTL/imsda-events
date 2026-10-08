import { describe, expect, it } from "vitest";
import {
  backgroundCheckAttention,
  carryoverAttention,
  classAttention,
  missingAnswersAttention,
} from "@/modules/club-registrations/attention";
import { rosterAnsweredFieldKeys, rosterAnsweredSummary } from "@/modules/club-registrations/domain";
import { accountPromptVisible } from "@/modules/forms/account-prompt";
import { attendeeMissingFieldLabels, isAttendeeCardComplete } from "@/modules/forms/roster-cards";
import { classChoiceReadiness } from "@/modules/honors/class-readiness";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";

const field = (key: string, type = "TEXT", options: string[] = [], label = key, required = false) => (
  { id: `f_${key}`, key, label, helpText: "", type, scope: "ATTENDEE" as const, required, options }
);

const definition = registrationFormDefinitionSchema.parse({
  title: "Synthetic club event",
  description: "",
  confirmationMessage: "Done",
  attendeeRoster: { enabled: true, minAttendees: 1, maxAttendees: 50, attendeeLabel: "Member", addButtonLabel: "Add" },
  sections: [{
    id: "s_roster",
    title: "Roster",
    description: "",
    fields: [
      field("first_name", "TEXT", [], "First name", true),
      field("last_name", "TEXT", [], "Last name", true),
      field("attendee_age", "NUMBER", [], "Age", true),
      field("gender", "SELECT", ["Female", "Male"], "Gender", true),
      field("attendee_type", "SELECT", ["Pathfinder", "Staff"], "Role", true),
      field("vegetarian", "CHECKBOX", [], "Vegetarian", false),
    ],
  }],
});

describe("optional-account panel (#854)", () => {
  it("shows to a signed-out registrant, and to a group contact", () => {
    expect(accountPromptVisible({ signedIn: false, clubRegistration: false })).toBe(true);
  });

  it("is hidden for anyone signed in, and on a club's own registration", () => {
    expect(accountPromptVisible({ signedIn: true, clubRegistration: false })).toBe(false);
    expect(accountPromptVisible({ signedIn: false, clubRegistration: true })).toBe(false);
    expect(accountPromptVisible({ signedIn: true, clubRegistration: true })).toBe(false);
  });
});

describe("roster answers are not asked again (#853)", () => {
  const known = { first_name: "Alex", last_name: "Sample", attendee_age: "11", gender: "Female", attendee_type: "Pathfinder" };
  const rosterValues = { gender: "Female", attendee_type: "Pathfinder" };

  it("still asks for a value the roster lacks or the form could not match", () => {
    const keys = rosterAnsweredFieldKeys(
      definition,
      { ...known, attendee_age: "", attendee_type: "" },
      { carriedFromRoster: true, rosterValues, unresolvedKeys: ["gender"] },
    );
    expect(keys).toEqual({ locked: ["first_name", "last_name"], changeable: [] });
  });

  it("asks both gender and role once either differs from the roster", () => {
    const keys = rosterAnsweredFieldKeys(definition, { ...known, attendee_type: "Staff" }, { carriedFromRoster: true, rosterValues });
    expect(keys.changeable).toEqual([]);
  });

  it("never hides other questions such as diet", () => {
    const keys = rosterAnsweredFieldKeys(definition, { ...known, vegetarian: "true" }, { carriedFromRoster: true, rosterValues });
    expect([...keys.locked, ...keys.changeable]).not.toContain("vegetarian");
  });

  it("summarises the hidden answers in words, without the name", () => {
    const hidden = definition.sections[0]!.fields.filter((candidate) => ["first_name", "attendee_age", "gender", "attendee_type"].includes(candidate.key));
    expect(rosterAnsweredSummary(hidden, known)).toBe("age 11, Female, Pathfinder");
  });
});

describe("needs-attention reasons (#853)", () => {
  it("names the unanswered required questions", () => {
    const labels = attendeeMissingFieldLabels(definition, {}, { first_name: "Alex", last_name: "Sample", attendee_age: "11" });
    expect(labels).toEqual(["Gender", "Role"]);
    expect(isAttendeeCardComplete(definition, {}, { first_name: "Alex", last_name: "Sample", attendee_age: "11" })).toBe(false);
    expect(missingAnswersAttention(labels)[0]).toMatchObject({ reason: "Answer needed: Gender and Role" });
    expect(missingAnswersAttention([])).toEqual([]);
  });

  it("says a background check is needed and how to fix it", () => {
    expect(backgroundCheckAttention("NO_RECORD")[0]).toMatchObject({ reason: "Background check needed" });
    expect(backgroundCheckAttention("NO_RECORD")[0]!.fix).toMatch(/Sterling Volunteers/);
    expect(backgroundCheckAttention("NOT_COMPLIANT")[0]!.reason).toMatch(/not in compliance/);
    expect(backgroundCheckAttention("FLAGGED")[0]!.reason).toMatch(/expiring/);
    // Only missing, expired or not-in-compliance are blocking; "expiring soon" is a note.
    expect(backgroundCheckAttention("FLAGGED")[0]!.advisory).toBe(true);
    expect(backgroundCheckAttention("NO_RECORD")[0]!.advisory).toBeUndefined();
    expect(backgroundCheckAttention("NOT_COMPLIANT")[0]!.advisory).toBeUndefined();
    expect(backgroundCheckAttention("CLEAR")).toEqual([]);
    expect(backgroundCheckAttention(undefined)).toEqual([]);
  });

  it("counts unmatched roster values", () => {
    expect(carryoverAttention(0)).toEqual([]);
    expect(carryoverAttention(2)[0]!.reason).toBe("2 roster values didn't match the form");
  });

  it("is not complete when a youth owes a class and has none chosen", () => {
    const offerings = [{
      id: "o1", honorName: "Knots", span: "SINGLE_SESSION" as const, sessionId: "s1",
      isActive: true, minimumAge: null, perClubLimit: null, capacity: 10, seatsTaken: 0, clubSeatsTaken: 0,
    }];
    const youth = { id: "member:1", firstName: "Alex", lastName: "Sample", attendeeType: "YOUTH", consumesSeat: true, ageOnEventDate: 11 };
    const sessions = [{ id: "s1", name: "Session 1" }];
    const none = classChoiceReadiness({ attendees: [youth], sessions, offerings, selections: {} }).people[0];
    const items = classAttention(none);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ reason: "Class needed for Session 1" });
    // Every form answer is in, yet the owed class is a blocking (non-advisory) reason.
    expect(items.some((item) => !item.advisory)).toBe(true);

    const chosen = classChoiceReadiness({ attendees: [youth], sessions, offerings, selections: { "member:1": ["o1"] } }).people[0];
    expect(classAttention(chosen)).toEqual([]);
  });

  it("asks nothing of a person who owes no class, or has none they can take", () => {
    const offerings = [{
      id: "o1", honorName: "Knots", span: "SINGLE_SESSION" as const, sessionId: "s1",
      isActive: true, minimumAge: 16, perClubLimit: null, capacity: 10, seatsTaken: 0, clubSeatsTaken: 0,
    }];
    const sessions = [{ id: "s1", name: "Session 1" }];
    const staff = { id: "member:2", firstName: "Sam", lastName: "Sample", attendeeType: "STAFF", consumesSeat: false, ageOnEventDate: 40 };
    const young = { id: "member:3", firstName: "Kit", lastName: "Sample", attendeeType: "YOUTH", consumesSeat: true, ageOnEventDate: 10 };
    const people = classChoiceReadiness({ attendees: [staff, young], sessions, offerings, selections: {} }).people;
    expect(classAttention(people[0])).toEqual([]);
    expect(classAttention(people[1])).toEqual([]);
  });
});
