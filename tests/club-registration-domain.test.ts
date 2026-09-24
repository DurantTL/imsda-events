import { describe, expect, it } from "vitest";
import {
  attendeeAgeKey,
  attendeeNameKeys,
  clubAttendeeClientId,
  clubFormProblem,
  lockedAttendeeFieldKeys,
  rosterGenderPrefill,
  rosterMemberIdFromClientId,
  rosterOwnedResponses,
  rosterRolePrefill,
} from "@/modules/club-registrations/domain";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";

const field = (key: string, type = "TEXT", scope: "ATTENDEE" | "REGISTRATION" = "ATTENDEE", options: string[] = [], label = key) => (
  { id: `f_${key}`, key, label, helpText: "", type, scope, required: ["first_name", "last_name", "attendee_name"].includes(key), options }
);

function form(fields: ReturnType<typeof field>[], roster = true) {
  return registrationFormDefinitionSchema.parse({
    title: "Club form",
    description: "",
    confirmationMessage: "Done",
    ...(roster ? { attendeeRoster: { enabled: true, minAttendees: 1, maxAttendees: 50, attendeeLabel: "Member", addButtonLabel: "Add" } } : {}),
    sections: [{ id: "s_contact", title: "Contact", description: "", fields: [field("email", "EMAIL", "REGISTRATION"), field("contact_name", "TEXT", "REGISTRATION")] },
      { id: "s_roster", title: "Roster", description: "", fields }],
  });
}

const person = { firstName: "Alex", lastName: "Sample", ageOnEventDate: 11, gender: "FEMALE" as const };

describe("club form mapping", () => {
  it("round-trips roster IDs through form client IDs", () => {
    expect(rosterMemberIdFromClientId(clubAttendeeClientId("abc"))).toBe("abc");
    expect(rosterMemberIdFromClientId("initial-attendee-1")).toBeNull();
  });

  it("finds split or full attendee name fields and the age field", () => {
    const split = form([field("first_name"), field("last_name"), field("attendee_age", "NUMBER")]);
    expect(attendeeNameKeys(split)).toEqual({ kind: "split", first: "first_name", last: "last_name" });
    expect(attendeeAgeKey(split)).toBe("attendee_age");
    expect(lockedAttendeeFieldKeys(split)).toEqual(["first_name", "last_name", "attendee_age"]);
    expect(rosterOwnedResponses(split, person)).toEqual({ first_name: "Alex", last_name: "Sample", attendee_age: "11" });

    const full = form([field("attendee_name")]);
    expect(rosterOwnedResponses(full, person)).toEqual({ attendee_name: "Alex Sample" });
  });

  it("prefills gender only when the form offers a matching option", () => {
    expect(rosterGenderPrefill(form([field("first_name"), field("last_name"), field("gender", "SELECT", "ATTENDEE", ["Female", "Male"])]), person)).toEqual({ gender: "Female" });
    expect(rosterGenderPrefill(form([field("first_name"), field("last_name")]), person)).toEqual({});
  });

  it("explains why a form can't take club registrations", () => {
    expect(clubFormProblem(form([field("first_name"), field("last_name")]))).toBeNull();
    expect(clubFormProblem(form([field("first_name"), field("last_name")], false))).toMatch(/list of attendees/);
    expect(clubFormProblem(form([field("first_name"), field("last_name"), field("birthday", "DATE", "ATTENDEE", [], "Birthday")]))).toMatch(/birth dates/);
  });

  it("prefills the roster role so directors don't re-pick it for everyone", () => {
    const roleForm = form([field("first_name"), field("last_name"), field("attendee_type", "RADIO", "ATTENDEE", ["Pathfinder", "TLT", "Staff", "Child"])]);
    expect(rosterRolePrefill(roleForm, { ...person, role: " pathfinder ", attendeeType: "YOUTH" })).toEqual({ attendee_type: "Pathfinder" });
    expect(rosterRolePrefill(roleForm, { ...person, role: "Counselor", attendeeType: "STAFF" })).toEqual({ attendee_type: "Staff" });
    expect(rosterRolePrefill(roleForm, { ...person, role: "", attendeeType: "UNDERAGE" })).toEqual({ attendee_type: "Child" });
    expect(rosterRolePrefill(roleForm, { ...person, role: "Explorer", attendeeType: "YOUTH" })).toEqual({});
    expect(rosterRolePrefill(form([field("first_name"), field("last_name")]), { ...person, role: "Pathfinder" })).toEqual({});
  });
});


describe("extra people not on the roster (#388)", () => {
  it("validates a guest and keeps saved guests that still read as guests", async () => {
    const { clubGuestSchema, guestsFromJson, clubGuestClientId, guestIdFromClientId, guestIsAdult } = await import("@/modules/club-registrations/domain");
    expect(clubGuestSchema.parse({ id: "abc123def", firstName: " Pat ", lastName: "Driver", age: 42, email: "" }))
      .toEqual({ id: "abc123def", firstName: "Pat", lastName: "Driver", age: 42, email: null });
    expect(clubGuestSchema.safeParse({ id: "abc123def", firstName: "Pat", lastName: "Driver", age: 200, email: null }).success).toBe(false);
    expect(clubGuestSchema.safeParse({ id: "bad id!", firstName: "Pat", lastName: "Driver", age: 30, email: null }).success).toBe(false);
    expect(guestsFromJson("nonsense")).toEqual([]);
    expect(guestIdFromClientId(clubGuestClientId("abc123def"))).toBe("abc123def");
    expect(guestIdFromClientId("member:m1")).toBeNull();
    expect(guestIsAdult({ age: 17 })).toBe(false);
    expect(guestIsAdult({ age: 18 })).toBe(true);
  });
});
