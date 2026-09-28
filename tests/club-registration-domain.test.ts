import { describe, expect, it } from "vitest";
import {
  attendeeAgeKey,
  attendeeNameKeys,
  clubAttendeeClientId,
  clubDirectoryOwnedResponses,
  clubDirectoryPrefillResponses,
  clubFormProblem,
  lockedAttendeeFieldKeys,
  lockedClubDirectoryFieldKeys,
  medicalFreeTextFields,
  rosterCarryoverMismatches,
  rosterGenderPrefill,
  rosterMemberIdFromClientId,
  rosterOwnedResponses,
  rosterRolePrefill,
  unmatchedRosterGender,
  unmatchedRosterRole,
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
    // An unrecognized role is left for the director (#483): never guessed from type.
    expect(rosterRolePrefill(roleForm, { ...person, role: "Explorer", attendeeType: "YOUTH" })).toEqual({});
    // A youth with no roster role is also left for the director (#483): a
    // blank role no longer defaults to Pathfinder.
    expect(rosterRolePrefill(roleForm, { ...person, role: "", attendeeType: "YOUTH" })).toEqual({});
    expect(rosterRolePrefill(roleForm, { ...person, role: "Explorer" })).toEqual({});
    expect(rosterRolePrefill(form([field("first_name"), field("last_name")]), { ...person, role: "Pathfinder" })).toEqual({});
  });

  it("reports an unmatched roster role instead of guessing or leaving it silently blank (#483)", () => {
    const roleForm = form([field("first_name"), field("last_name"), field("attendee_type", "RADIO", "ATTENDEE", ["Pathfinder", "TLT", "Staff", "Child"])]);
    expect(unmatchedRosterRole(roleForm, { role: "Teen Leader" })).toBe("Teen Leader");
    expect(unmatchedRosterRole(roleForm, { role: " pathfinder " })).toBeNull();
    expect(unmatchedRosterRole(roleForm, { role: "" })).toBeNull();
    expect(unmatchedRosterRole(roleForm, { role: undefined })).toBeNull();
    expect(unmatchedRosterRole(form([field("first_name"), field("last_name")]), { role: "Teen Leader" })).toBeNull();
  });

  it("reports an unmatched roster gender the same way (#483)", () => {
    const genderForm = form([field("first_name"), field("last_name"), field("gender", "SELECT", "ATTENDEE", ["Female", "Male"])]);
    expect(unmatchedRosterGender(genderForm, { gender: "FEMALE" })).toBeNull();
    expect(unmatchedRosterGender(form([field("first_name"), field("last_name")]), { gender: "FEMALE" })).toBeNull();
    expect(unmatchedRosterGender(genderForm, { gender: null })).toBeNull();
  });

  it("collects every carryover mismatch for one person (#483)", () => {
    const roleForm = form([
      field("first_name"), field("last_name"),
      field("attendee_type", "RADIO", "ATTENDEE", ["Pathfinder", "TLT", "Staff", "Child"]),
      field("gender", "SELECT", "ATTENDEE", ["Female", "Male"], "Gender"),
    ]);
    expect(rosterCarryoverMismatches(roleForm, { ...person, role: "Teen Leader", gender: "FEMALE" })).toEqual([
      { fieldKey: "attendee_type", label: "attendee_type", value: "Teen Leader" },
    ]);
    expect(rosterCarryoverMismatches(roleForm, { ...person, role: "Pathfinder", gender: "FEMALE" })).toEqual([]);
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

describe("club and church directory lock (#482)", () => {
  const directoryForm = registrationFormDefinitionSchema.parse({
    title: "Directory form",
    description: "",
    confirmationMessage: "Done",
    attendeeRoster: { enabled: true, minAttendees: 1, maxAttendees: 50, attendeeLabel: "Member", addButtonLabel: "Add" },
    sections: [
      { id: "s_contact", title: "Contact", description: "", fields: [
        { id: "f_club", key: "club_name", label: "Pathfinder club", helpText: "", type: "SELECT", scope: "REGISTRATION", required: true, options: [], optionSource: "CLUBS_DIRECTORY" },
        { id: "f_club_other", key: "club_name_other", label: "Club — not listed", helpText: "", type: "TEXT", scope: "REGISTRATION", required: true, options: [], conditional: { fieldKey: "club_name", operator: "EQUALS", value: "Not listed" } },
        { id: "f_church", key: "church_name", label: "Church", helpText: "", type: "SELECT", scope: "REGISTRATION", required: false, options: [], optionSource: "CHURCHES_DIRECTORY" },
      ] },
      { id: "s_roster", title: "Roster", description: "", fields: [field("first_name"), field("last_name")] },
    ],
  });

  it("locks only the club field; the church stays editable", () => {
    expect(lockedClubDirectoryFieldKeys(directoryForm)).toEqual(["club_name"]);
  });

  it("owns only the club answer, clearing the paired \"Not listed\" free text and never touching the church", () => {
    expect(clubDirectoryOwnedResponses(directoryForm, { clubName: "Test Pathfinders", churchName: "Test SDA Church" }))
      .toEqual({ club_name: "Test Pathfinders", club_name_other: null });
  });

  it("prefills the club and the sponsoring church as an editable default", () => {
    expect(clubDirectoryPrefillResponses(directoryForm, { clubName: "Test Pathfinders", churchName: "Test SDA Church" }))
      .toEqual({ club_name: "Test Pathfinders", church_name: "Test SDA Church" });
  });

  it("leaves the church blank when the club has no sponsoring church (or only an inactive one)", () => {
    // The repository reports an inactive sponsoring church as `churchName: null`.
    expect(clubDirectoryPrefillResponses(directoryForm, { clubName: "Test Pathfinders", churchName: null }))
      .toEqual({ club_name: "Test Pathfinders" });
  });

  it("uses the directory's own spelling when the club's name differs only by case or spacing", () => {
    const hydrated = {
      ...directoryForm,
      sections: directoryForm.sections.map((section) => ({
        ...section,
        fields: section.fields.map((candidate) => candidate.key === "club_name"
          ? { ...candidate, options: ["Test Pathfinders", "Not listed"] }
          : candidate),
      })),
    };
    expect(clubDirectoryOwnedResponses(hydrated, { clubName: "test  pathfinders", churchName: null }))
      .toMatchObject({ club_name: "Test Pathfinders" });
  });

  it("reports no locked fields for a form with no directory sources", () => {
    expect(lockedClubDirectoryFieldKeys(form([field("first_name"), field("last_name")]))).toEqual([]);
  });
});
