import { describe, expect, it } from "vitest";
import {
  backgroundCheckAttention,
  carryoverAttention,
  classAttention,
  missingAnswersAttention,
} from "@/modules/club-registrations/attention";
import { rosterAnsweredFieldKeys, rosterAnsweredSummary } from "@/modules/club-registrations/domain";
import { accountPromptVisible } from "@/modules/forms/account-prompt";
import { attendeeMissingFieldLabels, cardStatusComplete, isAttendeeCardComplete } from "@/modules/forms/roster-cards";
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
  it("shows only to a signed-out visitor on a regular event", () => {
    expect(accountPromptVisible({ signedIn: false, clubEvent: false })).toBe(true);
    expect(accountPromptVisible({ signedIn: true, clubEvent: false })).toBe(false);
    expect(accountPromptVisible({ signedIn: false, clubEvent: true })).toBe(false);
    expect(accountPromptVisible({ signedIn: true, clubEvent: true })).toBe(false);
  });
});

describe("roster answers are not asked again (#853)", () => {
  const known = { first_name: "Alex", last_name: "Sample", attendee_age: "11", gender: "Female", attendee_type: "Pathfinder" };

  it("hides name, age, gender and role for a roster person", () => {
    expect(rosterAnsweredFieldKeys(definition, known, { carriedFromRoster: true }))
      .toEqual(["first_name", "last_name", "attendee_age", "gender", "attendee_type"]);
  });

  it("still asks for a value the roster lacks or the form could not match", () => {
    const keys = rosterAnsweredFieldKeys(
      definition,
      { ...known, attendee_age: "", attendee_type: "" },
      { carriedFromRoster: true, unresolvedKeys: ["gender"] },
    );
    expect(keys).toEqual(["first_name", "last_name"]);
  });

  it("only hides what the roster owns for an extra person, and never other questions", () => {
    const keys = rosterAnsweredFieldKeys(definition, { ...known, vegetarian: "true" }, { carriedFromRoster: false });
    expect(keys).toEqual(["first_name", "last_name", "attendee_age"]);
    expect(keys).not.toContain("vegetarian");
  });

  it("summarises the hidden answers in words", () => {
    const hidden = definition.sections[0]!.fields.filter((candidate) => ["attendee_age", "gender", "attendee_type"].includes(candidate.key));
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
    // The form answers alone would read Complete; the class makes the card need attention.
    expect(cardStatusComplete(true, 0) && items.length === 0).toBe(false);

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
