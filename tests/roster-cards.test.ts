import { describe, expect, it } from "vitest";
import { attendeeRoleLabel, isAttendeeCardComplete, issueAttendeeIndex, startsCollapsed } from "@/modules/forms/roster-cards";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";

function form() {
  return registrationFormDefinitionSchema.parse({
    title: "Card form",
    description: "",
    confirmationMessage: "Done",
    attendeeRoster: { enabled: true, minAttendees: 1, maxAttendees: 20, attendeeLabel: "Attendee", addButtonLabel: "Add" },
    sections: [{
      id: "s_roster",
      title: "Roster",
      description: "",
      fields: [
        { id: "f_first_name", key: "first_name", label: "First name", helpText: "", type: "TEXT", scope: "ATTENDEE", required: true, options: [] },
        { id: "f_last_name", key: "last_name", label: "Last name", helpText: "", type: "TEXT", scope: "ATTENDEE", required: true, options: [] },
        {
          id: "f_role", key: "attendee_type", label: "Role", helpText: "", type: "RADIO", scope: "ATTENDEE", required: true,
          options: ["Pathfinder", "Staff"], optionLabels: { Pathfinder: "Pathfinder (youth)" },
        },
        {
          id: "f_skill", key: "skill_level", label: "Skill level", helpText: "", type: "SELECT", scope: "ATTENDEE", required: true,
          options: ["Beginner", "Advanced"], conditional: { fieldKey: "attendee_type", operator: "EQUALS", value: "Pathfinder" },
        },
      ],
    }],
  });
}

describe("attendee card completeness (#483)", () => {
  it("is incomplete while a required, visible field has no answer", () => {
    const definition = form();
    expect(isAttendeeCardComplete(definition, {}, {})).toBe(false);
    expect(isAttendeeCardComplete(definition, {}, { first_name: "Alex", last_name: "Sample" })).toBe(false);
  });

  it("is complete once every required, visible field is answered", () => {
    const definition = form();
    // Staff never sees the (Pathfinder-only) skill field, so it's complete without it.
    expect(isAttendeeCardComplete(definition, {}, { first_name: "Alex", last_name: "Sample", attendee_type: "Staff" })).toBe(true);
    // A Pathfinder does see it, and isn't complete until it's answered.
    expect(isAttendeeCardComplete(definition, {}, { first_name: "Alex", last_name: "Sample", attendee_type: "Pathfinder" })).toBe(false);
    expect(isAttendeeCardComplete(definition, {}, {
      first_name: "Alex", last_name: "Sample", attendee_type: "Pathfinder", skill_level: "Beginner",
    })).toBe(true);
  });

  it("re-evaluates immediately when the role changes: a hidden field's stale answer no longer blocks completion", () => {
    const definition = form();
    // Skill level was answered while Pathfinder, then the role changed to
    // Staff — the field is hidden now, so its old answer doesn't matter.
    expect(isAttendeeCardComplete(definition, {}, {
      first_name: "Alex", last_name: "Sample", attendee_type: "Staff", skill_level: "Beginner",
    })).toBe(true);
  });
});

describe("attendee card role label (#483)", () => {
  it("shows the role's display label when one is configured, else the raw value", () => {
    const definition = form();
    expect(attendeeRoleLabel(definition, {}, { attendee_type: "Pathfinder" })).toBe("Pathfinder (youth)");
    expect(attendeeRoleLabel(definition, {}, { attendee_type: "Staff" })).toBe("Staff");
    expect(attendeeRoleLabel(definition, {}, {})).toBeNull();
  });
});

describe("card collapse state (#483)", () => {
  const base = { carriedFromRoster: true, complete: true, mismatchCount: 0, targetedByIssue: false };

  it("starts a complete club roster card collapsed", () => {
    expect(startsCollapsed(base)).toBe(true);
    // Computed from real answers, the way the form does it.
    const definition = form();
    const complete = isAttendeeCardComplete(definition, {}, { first_name: "Alex", last_name: "Sample", attendee_type: "Staff" });
    expect(startsCollapsed({ ...base, complete })).toBe(true);
  });

  it("starts a card with a carryover mismatch expanded, so the \"Couldn't match\" prompt shows", () => {
    expect(startsCollapsed({ ...base, mismatchCount: 1 })).toBe(false);
  });

  it("starts an incomplete card expanded", () => {
    const definition = form();
    // A blank carried role leaves the card incomplete.
    const complete = isAttendeeCardComplete(definition, {}, { first_name: "Alex", last_name: "Sample" });
    expect(complete).toBe(false);
    expect(startsCollapsed({ ...base, complete })).toBe(false);
  });

  it("starts a card a validation issue points into expanded", () => {
    expect(startsCollapsed({ ...base, targetedByIssue: true })).toBe(false);
  });

  it("never starts a manually added or imported card collapsed", () => {
    expect(startsCollapsed({ ...base, carriedFromRoster: false })).toBe(false);
  });
});

describe("issue to card mapping (#483)", () => {
  it("uses an explicit attendee index, then the path, then the first card for an attendee field", () => {
    expect(issueAttendeeIndex({ attendeeIndex: 2, path: "attendees.0.responses.x" }, "ATTENDEE")).toBe(2);
    expect(issueAttendeeIndex({ path: "attendees.3.responses.skill_level" }, "ATTENDEE")).toBe(3);
    expect(issueAttendeeIndex({ attendeeIndex: null }, "ATTENDEE")).toBe(0);
    expect(issueAttendeeIndex({ path: "responses.email" }, "REGISTRATION")).toBeNull();
    expect(issueAttendeeIndex({}, null)).toBeNull();
  });
});
