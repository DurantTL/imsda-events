import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classBadge, classChoiceReadiness, requiresClassChoice } from "@/modules/honors/class-readiness";

/**
 * #803: youth are required to choose classes on any event that has class choices, Camp Meeting included; staff and adults
 * stay optional. The `requiresClassChoice` rule (#799) already works that way: it looks at the attendee's type only,
 * never at the event, and the class picker is shown for any event that has class offerings. This proves it with a Camp
 * Meeting-shaped event (synthetic people, sessions and classes only) and pins that nothing in the rule or in what feeds
 * it branches on the kind of event.
 */

const sessions = [{ id: "cm-morning", name: "Morning classes" }, { id: "cm-evening", name: "Evening classes" }];
const offering = (id: string, sessionId: string) => ({
  id, honorName: `Camp Meeting class ${id}`, span: "SINGLE_SESSION" as const, sessionId, isActive: true, minimumAge: null,
  perClubLimit: null, capacity: 30, seatsTaken: 0, clubSeatsTaken: 0,
});
const campMeetingClasses = [offering("m1", "cm-morning"), offering("e1", "cm-evening")];
const attendee = (id: string, attendeeType: string | null) => ({
  id, firstName: `Person${id}`, lastName: "Synthetic", attendeeType, consumesSeat: attendeeType !== "STAFF" && attendeeType !== "ADULT" && attendeeType !== "UNDERAGE", ageOnEventDate: 13,
});

describe("class choices are required of youth on Camp Meeting too (#803)", () => {
  const people = [attendee("youth", "YOUTH"), attendee("staff", "STAFF"), attendee("adult", "ADULT"), attendee("kid", "UNDERAGE"), attendee("untyped", null)];

  it("makes a youth with no pick incomplete, and names the sessions, on an event with class choices", () => {
    const result = classChoiceReadiness({ attendees: people, sessions, offerings: campMeetingClasses, selections: {} });
    const byId = new Map(result.people.map((person) => [person.attendeeId, person]));
    expect(byId.get("youth")).toMatchObject({ required: true, complete: false });
    expect(byId.get("youth")!.missing.map((entry) => entry.sessionName)).toEqual(["Morning classes", "Evening classes"]);
    expect(classBadge(byId.get("youth")!)).toBe("needs");
    // A member with no recorded type is treated as youth, as before.
    expect(byId.get("untyped")).toMatchObject({ required: true, complete: false });
    expect(result.incompleteCount).toBe(2);
    expect(result.complete).toBe(false);
  });

  it("keeps staff, adults and underage children optional: never incomplete", () => {
    const result = classChoiceReadiness({ attendees: people, sessions, offerings: campMeetingClasses, selections: {} });
    for (const id of ["staff", "adult", "kid"]) {
      const person = result.people.find((entry) => entry.attendeeId === id)!;
      expect(person).toMatchObject({ required: false, complete: true });
      expect(classBadge(person)).toBe("optional");
    }
    for (const attendeeType of ["STAFF", "ADULT", "UNDERAGE"]) expect(requiresClassChoice({ attendeeType })).toBe(false);
  });

  it("is complete once the youth has a class in every session", () => {
    const result = classChoiceReadiness({ attendees: [attendee("youth", "YOUTH")], sessions, offerings: campMeetingClasses, selections: { youth: ["m1", "e1"] }, saved: { youth: ["m1", "e1"] } });
    expect(result.complete).toBe(true);
  });

  it("asks nothing of anyone on an event with no class choices", () => {
    expect(classChoiceReadiness({ attendees: people, sessions: [], offerings: [], selections: {} })).toMatchObject({ complete: true, incompleteCount: 0 });
  });

  it("does not look at the event: the rule takes the attendee's type only, and nothing that feeds it branches on a kind of event", () => {
    expect(requiresClassChoice.length).toBe(1);
    for (const file of ["modules/honors/class-readiness.ts", "modules/honors/enrollment-repository.ts", "components/club-class-picker.tsx"]) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/eventType|CAMP_MEETING|HONORS_WEEKEND|isHonorsEvent|isCampMeeting/);
    }
  });
});
