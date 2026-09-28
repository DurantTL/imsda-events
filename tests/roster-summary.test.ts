import { describe, expect, it } from "vitest";
import { summarizeRosterAttendees } from "@/modules/forms/roster-summary";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";

function form() {
  return registrationFormDefinitionSchema.parse({
    title: "Summary form",
    description: "",
    confirmationMessage: "Done",
    attendeeRoster: { enabled: true, minAttendees: 1, maxAttendees: 50, attendeeLabel: "Member", addButtonLabel: "Add" },
    sections: [{
      id: "s_roster",
      title: "Roster",
      description: "",
      fields: [
        { id: "f_first_name", key: "first_name", label: "First name", helpText: "", type: "TEXT", scope: "ATTENDEE", required: true, options: [] },
        { id: "f_last_name", key: "last_name", label: "Last name", helpText: "", type: "TEXT", scope: "ATTENDEE", required: true, options: [] },
        { id: "f_role", key: "attendee_type", label: "Role", helpText: "", type: "RADIO", scope: "ATTENDEE", required: true, options: ["Pathfinder", "TLT", "Staff", "Child"] },
        { id: "f_investiture", key: "friend_investiture", label: "Friend investiture", helpText: "", type: "CHECKBOX", scope: "ATTENDEE", required: false, options: [] },
        {
          id: "f_master_guide", key: "master_guide_investiture", label: "Master Guide investiture?", helpText: "", type: "CHECKBOX", scope: "ATTENDEE", required: false, options: [],
          conditional: { fieldKey: "attendee_type", operator: "EQUALS", value: "Staff" },
        },
      ],
    }],
  });
}

describe("roster summary before review (#483)", () => {
  it("counts totals, roles, and inductions across attendees", () => {
    const definition = form();
    const attendees = [
      { attendee_type: "Pathfinder", friend_investiture: true },
      { attendee_type: "Pathfinder", friend_investiture: false },
      { attendee_type: "Staff", master_guide_investiture: true },
      { attendee_type: "TLT" },
    ];
    const summary = summarizeRosterAttendees(definition, {}, attendees);
    expect(summary.total).toBe(4);
    expect(summary.byRole).toEqual([
      { role: "Pathfinder", count: 2 },
      { role: "Staff", count: 1 },
      { role: "TLT", count: 1 },
    ]);
    expect(summary.unclassifiedCount).toBe(0);
    expect(summary.inductions).toEqual([
      { fieldKey: "friend_investiture", label: "Friend investiture", count: 1 },
      { fieldKey: "master_guide_investiture", label: "Master Guide investiture?", count: 1 },
    ]);
    expect(summary.inductionTotal).toBe(2);
  });

  it("counts an attendee with no role answer as unclassified, and ignores an induction field hidden by role", () => {
    const definition = form();
    const attendees = [
      {},
      // A Pathfinder can't have checked the Staff-only Master Guide box, but
      // even if legacy data carried it, it's hidden and doesn't count.
      { attendee_type: "Pathfinder", master_guide_investiture: true },
    ];
    const summary = summarizeRosterAttendees(definition, {}, attendees);
    expect(summary.total).toBe(2);
    expect(summary.byRole).toEqual([{ role: "Pathfinder", count: 1 }]);
    expect(summary.unclassifiedCount).toBe(1);
    expect(summary.inductions.find((row) => row.fieldKey === "master_guide_investiture")?.count).toBe(0);
  });

  it("returns an empty summary for no attendees", () => {
    const summary = summarizeRosterAttendees(form(), {}, []);
    expect(summary).toMatchObject({ total: 0, byRole: [], unclassifiedCount: 0, inductionTotal: 0 });
  });
});
