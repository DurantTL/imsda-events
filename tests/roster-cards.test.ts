import { describe, expect, it } from "vitest";
import { attendeeRoleLabel, isAttendeeCardComplete, startsCollapsed } from "@/modules/forms/roster-cards";
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
  it("starts collapsed only for a card carried over from the roster", () => {
    expect(startsCollapsed(true)).toBe(true);
    expect(startsCollapsed(false)).toBe(false);
  });
});
