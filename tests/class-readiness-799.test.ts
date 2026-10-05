import { describe, expect, it } from "vitest";
import { classChoiceReadiness, missingChoicesText, readinessSummaryText } from "@/modules/honors/class-readiness";

// Synthetic people, sessions and classes only (#799 G3).
const sessions = [{ id: "s1", name: "Session 1" }, { id: "s2", name: "Session 2" }];

const offering = (id: string, over: Partial<{ span: "SINGLE_SESSION" | "ALL_SESSIONS"; sessionId: string | null; minimumAge: number | null; seatsTaken: number; capacity: number; isActive: boolean }> = {}) => ({
  id,
  honorName: `Honor ${id}`,
  span: "SINGLE_SESSION" as const,
  sessionId: "s1" as string | null,
  isActive: true,
  minimumAge: null,
  perClubLimit: null,
  capacity: 20,
  seatsTaken: 0,
  clubSeatsTaken: 0,
  ...over,
});

const person = (id: string, over: Partial<{ ageOnEventDate: number | null; consumesSeat: boolean; attendeeType: string }> = {}) => ({
  id, firstName: `Pat${id}`, lastName: "Synthetic", attendeeType: "YOUTH", consumesSeat: true, ageOnEventDate: 12, ...over,
});

const offerings = [offering("a", { sessionId: "s1" }), offering("b", { sessionId: "s2" }), offering("all", { span: "ALL_SESSIONS", sessionId: null })];

describe("a member is not complete until every session they can take has a choice (#799 G3)", () => {
  it("lists every session when nothing is chosen", () => {
    const result = classChoiceReadiness({ attendees: [person("1")], sessions, offerings, selections: {} });
    expect(result.complete).toBe(false);
    expect(result.incompleteCount).toBe(1);
    expect(result.people[0]!.missing.map((entry) => entry.sessionName)).toEqual(["Session 1", "Session 2"]);
    expect(missingChoicesText(result.people[0]!)).toBe("Still needs a class for Session 1 and Session 2.");
  });

  it("is still incomplete with only one of two sessions chosen, and names the other", () => {
    const result = classChoiceReadiness({ attendees: [person("1")], sessions, offerings, selections: { "1": ["a"] } });
    expect(result.people[0]!.complete).toBe(false);
    expect(missingChoicesText(result.people[0]!)).toBe("Still needs a class for Session 2.");
  });

  it("is complete with a class in every session", () => {
    const result = classChoiceReadiness({ attendees: [person("1")], sessions, offerings, selections: { "1": ["a", "b"] } });
    expect(result.complete).toBe(true);
    expect(result.people[0]!.missing).toEqual([]);
  });

  it("counts one all-sessions class as every session", () => {
    expect(classChoiceReadiness({ attendees: [person("1")], sessions, offerings, selections: { "1": ["all"] } }).complete).toBe(true);
  });

  it("does not ask for a session in which nothing is open to them (full, too young, withdrawn)", () => {
    const limited = [
      offering("a", { sessionId: "s1", minimumAge: 16 }),
      offering("b", { sessionId: "s2", seatsTaken: 20 }),
    ];
    const youth = classChoiceReadiness({ attendees: [person("1", { ageOnEventDate: 12 })], sessions, offerings: limited, selections: {} });
    expect(youth.complete).toBe(true);
    // A staff member takes no seat, so a full class is still open to them.
    const staff = classChoiceReadiness({ attendees: [person("2", { consumesSeat: false, attendeeType: "STAFF", ageOnEventDate: 40 })], sessions, offerings: limited, selections: {} });
    expect(staff.people[0]!.missing.map((entry) => entry.sessionId)).toEqual(["s1", "s2"]);
    const withdrawn = classChoiceReadiness({ attendees: [person("3")], sessions, offerings: [offering("a", { isActive: false })], selections: {} });
    expect(withdrawn.complete).toBe(true);
  });

  it("an unknown or removed class choice does not count", () => {
    expect(classChoiceReadiness({ attendees: [person("1")], sessions, offerings, selections: { "1": ["gone"] } }).complete).toBe(false);
  });

  it("summarises for the whole club, by count and never as complete early", () => {
    const result = classChoiceReadiness({ attendees: [person("1"), person("2"), person("3")], sessions, offerings, selections: { "1": ["a", "b"], "2": ["a"] } });
    expect(result.incompleteCount).toBe(2);
    expect(readinessSummaryText(result)).toBe("2 of 3 people still need class choices.");
    expect(readinessSummaryText({ people: [{} as never], incompleteCount: 1 })).toBe("1 of 1 person still needs class choices.");
    expect(readinessSummaryText({ people: [], incompleteCount: 0 })).toBe("Everyone has their class choices.");
  });
});
