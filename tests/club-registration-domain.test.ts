import { describe, expect, it } from "vitest";
import {
  attendeeAgeKey,
  attendeeNameKeys,
  clubAttendeeClientId,
  clubFormProblem,
  lockedAttendeeFieldKeys,
  medicalFreeTextFields,
  rosterGenderPrefill,
  rosterMemberIdFromClientId,
  rosterOwnedResponses,
  rosterRolePrefill,
} from "@/modules/club-registrations/domain";
import { formTemplates, registrationFormDefinitionSchema } from "@/modules/forms/definition";

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
    expect(clubFormProblem(form([field("first_name"), field("last_name"), field("medical_notes", "LONG_TEXT", "ATTENDEE", [], "Medical or accessibility notes")]))).toMatch(/free-text medical, health, or accessibility question \("Medical or accessibility notes"\)/);
  });

  it("flags attendee free-text medical/health fields but not dietary, food-allergy, checkbox, or yes/no ones (#408)", () => {
    const medicalNote = field("medical_notes", "LONG_TEXT", "ATTENDEE", [], "Medical or accessibility notes");
    const healthNote = field("health_notes", "TEXT", "ATTENDEE", [], "Health conditions to know about");
    const allergyNote = field("allergy_notes", "LONG_TEXT", "ATTENDEE", [], "Allergy details");
    const dietary = field("dietary_needs", "LONG_TEXT", "ATTENDEE", [], "Dietary restrictions");
    const medicalPersonnelCheckbox = field("medical_personnel", "CHECKBOX", "ATTENDEE", [], "Medical personnel?");
    const medicalNeedFlag = field("medical_or_accessibility_need", "RADIO", "ATTENDEE", ["No", "Yes"], "Has a medical or accessibility need the club director knows about");
    const keyOnly = field("medical_info", "LONG_TEXT", "ATTENDEE", [], "Anything the camp nurse should know");
    const medications = field("current_meds", "TEXT", "ATTENDEE", [], "Medications");
    const accessibilityNeeds = field("access", "LONG_TEXT", "ATTENDEE", [], "Accessibility needs");
    const dietaryAllergies = field("diet", "LONG_TEXT", "ATTENDEE", [], "Dietary needs / allergies");
    const registrationScopedMedical = field("registrant_medical_notes", "LONG_TEXT", "REGISTRATION", [], "Medical notes");

    const matches = medicalFreeTextFields(form([
      field("first_name"), field("last_name"),
      medicalNote, healthNote, keyOnly, medications, accessibilityNeeds,
      allergyNote, dietaryAllergies,
      dietary, medicalPersonnelCheckbox, medicalNeedFlag, registrationScopedMedical,
    ])).map((f) => f.key);

    expect(matches).toEqual([
      "medical_notes", "health_notes", "medical_info", "current_meds", "access",
    ]);
  });

  it("has no free-text medical field on the seeded Spring Camporee template (#408)", () => {
    const camporee = formTemplates.find((template) => template.key === "spring_camporee_export");
    expect(camporee).toBeDefined();
    const definition = registrationFormDefinitionSchema.parse(camporee!.definition);
    expect(medicalFreeTextFields(definition)).toEqual([]);
    expect(clubFormProblem(definition)).toBeNull();

    const rosterSection = definition.sections.find((section) => section.id === "sc_roster");
    const rosterKeys = rosterSection?.fields.map((f) => f.key) ?? [];
    expect(rosterKeys).toContain("dietary_needs");
    expect(rosterKeys).toContain("medical_personnel");
    expect(rosterKeys).toContain("medical_or_accessibility_need");
    expect(rosterKeys).not.toContain("medical_or_accessibility_notes");
  });

  it("ships a club-registration-ready, unpriced Honors Weekend template (#436)", () => {
    const honorsWeekend = formTemplates.find((template) => template.key === "honors_weekend");
    expect(honorsWeekend).toBeDefined();
    const definition = registrationFormDefinitionSchema.parse(honorsWeekend!.definition);
    expect(medicalFreeTextFields(definition)).toEqual([]);
    expect(clubFormProblem(definition)).toBeNull();

    const allFields = definition.sections.flatMap((section) => section.fields);
    expect(allFields.some((f) => f.type === "DATE")).toBe(false);

    const rosterSection = definition.sections.find((section) => section.id === "hw_roster");
    const rosterKeys = rosterSection?.fields.map((f) => f.key) ?? [];
    expect(rosterKeys).toContain("first_name");
    expect(rosterKeys).toContain("last_name");
    expect(rosterKeys).toContain("attendee_age");
    expect(rosterKeys).toContain("dietary_needs");
    expect(rosterKeys).toContain("medical_or_accessibility_need");
    // Same roster roles as Spring Camporee, so role prefill, club reports,
    // and attendee types line up across club events.
    const role = rosterSection?.fields.find((f) => f.key === "attendee_type");
    expect(role?.options).toEqual(["Pathfinder", "TLT", "Staff", "Child"]);
    expect(role?.helpText).toBe("Class seats follow each person’s type on the club roster, not this answer.");

    // Pricing is left for staff to set per event (#436): no field on the
    // template carries a price.
    for (const field of allFields) {
      expect(field.priceCents).toBeUndefined();
      expect(field.choicePricesCents).toBeUndefined();
      expect(field.latePricing).toBeUndefined();
    }
  });

  it("prefills the roster role so directors don't re-pick it for everyone", () => {
    const roleForm = form([field("first_name"), field("last_name"), field("attendee_type", "RADIO", "ATTENDEE", ["Pathfinder", "TLT", "Staff", "Child"])]);
    expect(rosterRolePrefill(roleForm, { ...person, role: " pathfinder ", attendeeType: "YOUTH" })).toEqual({ attendee_type: "Pathfinder" });
    expect(rosterRolePrefill(roleForm, { ...person, role: "Counselor", attendeeType: "STAFF" })).toEqual({ attendee_type: "Staff" });
    expect(rosterRolePrefill(roleForm, { ...person, role: "", attendeeType: "UNDERAGE" })).toEqual({ attendee_type: "Child" });
    // A youth with no roster role starts as a Pathfinder; an unrecognized role is left for the director.
    expect(rosterRolePrefill(roleForm, { ...person, role: "Explorer", attendeeType: "YOUTH" })).toEqual({});
    expect(rosterRolePrefill(roleForm, { ...person, role: "", attendeeType: "YOUTH" })).toEqual({ attendee_type: "Pathfinder" });
    expect(rosterRolePrefill(roleForm, { ...person, role: "Explorer" })).toEqual({});
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
