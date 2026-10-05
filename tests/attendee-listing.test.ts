import { describe, expect, it } from "vitest";
import { eventPermissions, eventRoles, rolePermissions } from "@/modules/access/permissions";
import { formTemplates } from "@/modules/forms/definition";
import type { RegistrationRecord } from "@/modules/registrations/repository";
import {
  ATTENDEE_LISTING_BOM,
  attendeeListingCsv,
  attendeeListingParams,
  buildAttendeeListingRows,
  canViewDietaryDetails,
  hasDietaryNeeds,
  resolveListingFields,
  filterAttendeeListing,
  mealCategoryOf,
  mealTotals,
  parseAttendeeListingQuery,
} from "@/modules/registrations/attendee-listing";

const definition = formTemplates.find((template) => template.key === "womens_retreat_export")!.definition as unknown as Record<string, unknown>;
const blankDefinition = formTemplates.find((template) => template.key === "blank")?.definition as unknown as Record<string, unknown> | undefined;

function attendee(id: string, firstName: string, lastName: string, responses: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { id, firstName, lastName, email: "", phone: "", attendeeType: "Adult", position: 0, source: "PUBLIC_REGISTRATION", responses, checkedIn: false, checkInId: null, checkedInAt: null, ...extra };
}

function registration(id: string, status: string, attendees: ReturnType<typeof attendee>[], responses: Record<string, unknown> = {}, def: Record<string, unknown> | null = definition) {
  return {
    id,
    confirmationCode: `WR26-${id}`,
    status,
    accountHolder: { id: `p-${id}`, firstName: "Holder", lastName: id, email: `${id}@example.test`, phone: "" },
    attendees,
    publicSubmission: def ? { definition: def, responses, attendeeResponses: [] } : null,
  } as unknown as RegistrationRecord;
}

const registrations = [
  registration("A1", "CONFIRMED", [
    attendee("a1", "Ada", "Synthetic", { meal_preference: "Vegetarian", dietary_needs: "synthetic: no peanuts", childcare_needed: "Yes", volunteer: "No" }, { phone: "555-0101" }),
    attendee("a2", "Bea", "Synthetic", { meal_preference: "Standard", dietary_needs: "None", volunteer: "Yes" }, { attendeeType: "Teen" }),
  ], { church: "Test Church" }),
  registration("B2", "SUBMITTED", [attendee("b1", "Cleo", "Synthetic", { meal_preference: "Vegan" })], { church: "Not listed", church_other: "Other Fellowship" }),
  registration("C3", "CANCELLED", [attendee("c1", "Dee", "Synthetic", { meal_preference: "Gluten-free", dietary_needs: "synthetic: celiac" })]),
  registration("D4", "CONFIRMED", [attendee("d1", "=Eve", "Synthetic", {})]),
  registration("E5", "WAITLISTED", [attendee("e1", "Fay", "Synthetic", { meal_preference: "Vegan" })]),
];

const rows = buildAttendeeListingRows(registrations, { showDietaryDetails: true });
const defaults = parseAttendeeListingQuery(new URLSearchParams());

describe("attendee listing rows", () => {
  it("builds one row per attendee with resolved answers", () => {
    expect(rows).toHaveLength(6);
    expect(rows[0]).toMatchObject({
      confirmationCode: "WR26-A1", status: "CONFIRMED", name: "Ada Synthetic", attendeeType: "Adult", church: "Test Church",
      mealPreference: "Vegetarian", mealCategory: "vegetarian", dietaryNeeds: "synthetic: no peanuts", hasDietaryNeeds: true,
      childcareNeeded: "Yes", volunteer: "No", phone: "555-0101", accountHolderName: "Holder A1", accountHolderEmail: "A1@example.test",
    });
    expect(rows[1]).toMatchObject({ attendeeType: "Teen", mealCategory: "regular", hasDietaryNeeds: false, volunteer: "Yes" });
  });

  it("falls back to the typed church when the directory choice is Not listed", () => {
    expect(rows.find((row) => row.name === "Cleo Synthetic")!.church).toBe("Other Fellowship");
  });

  it("leaves a column blank when the registration's form lacks the question", () => {
    const [row] = buildAttendeeListingRows([registration("Z9", "CONFIRMED", [attendee("z1", "Zed", "Synthetic", { meal_preference: "Vegan" })], {}, null)], { showDietaryDetails: true });
    expect(row).toMatchObject({ mealPreference: "", dietaryNeeds: "", childcareNeeded: "", volunteer: "", church: "", mealCategory: "none" });
    if (blankDefinition) {
      const [blank] = buildAttendeeListingRows([registration("Z8", "CONFIRMED", [attendee("z2", "Yan", "Synthetic", { meal_preference: "Vegan" })], {}, blankDefinition)], { showDietaryDetails: true });
      expect(blank.mealPreference).toBe("");
    }
  });

  it("falls back to the original submission's answers when the attendee has none saved", () => {
    const source = registration("F6", "CONFIRMED", [attendee("f1", "Gil", "Synthetic", {})]);
    (source.publicSubmission as unknown as { attendeeResponses: unknown[] }).attendeeResponses = [{ meal_preference: "Vegan" }];
    expect(buildAttendeeListingRows([source], { showDietaryDetails: true })[0].mealPreference).toBe("Vegan");
  });

  it("categorises meals", () => {
    expect(["Standard", "Regular", "Vegetarian", "Vegan", "Gluten-free", "Kosher", ""].map(mealCategoryOf))
      .toEqual(["regular", "regular", "vegetarian", "vegan", "gluten_free", "other", "none"]);
  });
});

describe("attendee listing filters", () => {
  it("defaults to Confirmed registrations only, so cancelled, submitted and waitlisted are out", () => {
    expect(defaults.statuses).toEqual(["CONFIRMED"]);
    expect(filterAttendeeListing(rows, defaults).map((row) => row.confirmationCode)).toEqual(["WR26-A1", "WR26-A1", "WR26-D4"]);
  });

  it("includes Submitted or Cancelled on request, never Draft or Waitlisted", () => {
    const query = parseAttendeeListingQuery(new URLSearchParams("statuses=submitted,CANCELLED,WAITLISTED,DRAFT"));
    expect(query.statuses).toEqual(["SUBMITTED", "CANCELLED"]);
    expect(filterAttendeeListing(rows, query).map((row) => row.status)).toEqual(["SUBMITTED", "CANCELLED"]);
    const repeated = new URLSearchParams([["statuses", "CONFIRMED"], ["statuses", "CANCELLED"]]);
    expect(parseAttendeeListingQuery(repeated).statuses).toEqual(["CONFIRMED", "CANCELLED"]);
    expect(parseAttendeeListingQuery(new URLSearchParams("statuses=nonsense")).statuses).toEqual(["CONFIRMED"]);
  });

  it("filters by meal, dietary needs, and name or confirmation code", () => {
    const all = parseAttendeeListingQuery(new URLSearchParams("statuses=CONFIRMED,SUBMITTED,CANCELLED"));
    expect(filterAttendeeListing(rows, { ...all, meal: "vegan" }).map((row) => row.name)).toEqual(["Cleo Synthetic"]);
    expect(filterAttendeeListing(rows, { ...all, dietaryOnly: true }).map((row) => row.name)).toEqual(["Ada Synthetic", "Dee Synthetic"]);
    expect(filterAttendeeListing(rows, { ...all, search: "bea" }).map((row) => row.name)).toEqual(["Bea Synthetic"]);
    expect(filterAttendeeListing(rows, { ...all, search: "wr26-c3" }).map((row) => row.name)).toEqual(["Dee Synthetic"]);
  });

  it("sorts by a column in either direction and ignores unknown sort keys", () => {
    expect(filterAttendeeListing(rows, { ...defaults, sort: "name", direction: "desc" }).map((row) => row.name)).toEqual(["Bea Synthetic", "Ada Synthetic", "=Eve Synthetic"]);
    expect(filterAttendeeListing(rows, { ...defaults, sort: "attendeeType", direction: "asc" })[0].attendeeType).toBe("Adult");
    expect(parseAttendeeListingQuery(new URLSearchParams("sort=accountHolderEmail;drop")).sort).toBeNull();
  });

  it("round-trips the query through URL parameters", () => {
    const query = parseAttendeeListingQuery(new URLSearchParams("statuses=CONFIRMED,CANCELLED&meal=vegan&dietary=1&q=ada&sort=name&dir=desc"));
    expect(parseAttendeeListingQuery(attendeeListingParams(query))).toEqual(query);
    expect(attendeeListingParams(defaults).toString()).toBe("");
  });
});

describe("meal totals", () => {
  it("counts each meal type over the filtered rows", () => {
    const counts = (list: typeof rows) => Object.fromEntries(mealTotals(list).map((total) => [total.value, total.count]));
    expect(counts(filterAttendeeListing(rows, defaults))).toMatchObject({ regular: 1, vegetarian: 1, vegan: 0, gluten_free: 0, none: 1 });
    const all = parseAttendeeListingQuery(new URLSearchParams("statuses=CONFIRMED,SUBMITTED,CANCELLED"));
    expect(counts(filterAttendeeListing(rows, all))).toMatchObject({ regular: 1, vegetarian: 1, vegan: 1, gluten_free: 1 });
    expect(counts(filterAttendeeListing(rows, { ...all, meal: "vegan" }))).toMatchObject({ vegan: 1, vegetarian: 0 });
  });
});

describe("attendee listing CSV", () => {
  it("starts with a UTF-8 BOM and matches the on-screen columns and rows", () => {
    const shown = filterAttendeeListing(rows, defaults);
    const csv = attendeeListingCsv(shown);
    expect(csv.startsWith(ATTENDEE_LISTING_BOM)).toBe(true);
    const lines = csv.slice(1).trim().split("\r\n");
    expect(lines[0]).toBe('"Confirmation code","Status","Attendee","Type","Church","Meal preference","Dietary needs","Childcare needed","Volunteer","Phone","Account holder","Account holder email"');
    expect(lines).toHaveLength(1 + shown.length);
    expect(lines[1]).toBe('"WR26-A1","CONFIRMED","Ada Synthetic","Adult","Test Church","Vegetarian","synthetic: no peanuts","Yes","No","555-0101","Holder A1","A1@example.test"');
  });

  it("escapes formula-like cells", () => {
    const csv = attendeeListingCsv(filterAttendeeListing(rows, defaults));
    expect(csv).toContain(`"'=Eve Synthetic"`);
    expect(csv).not.toContain(`,"=Eve`);
  });
});

const build = (list: RegistrationRecord[], showDietaryDetails = true) => buildAttendeeListingRows(list, { showDietaryDetails });
const templateDefinition = (key: string) => formTemplates.find((template) => template.key === key)!.definition as unknown as Record<string, unknown>;

describe("dietary details gate (ADR 0005 Addendum C)", () => {
  const cases: Array<[string, string[], boolean, boolean]> = [
    ["reports and sensitive on a general event", ["VIEW_REPORTS", "VIEW_SENSITIVE_DATA"], false, true],
    ["sensitive only on a general event", ["VIEW_SENSITIVE_DATA"], false, false],
    ["reports only on a general event", ["VIEW_REPORTS"], false, false],
    ["no permissions", [], false, false],
    ["reports and sensitive on a club event", ["VIEW_REPORTS", "VIEW_SENSITIVE_DATA"], true, false],
    ["reports, sensitive and health on a club event", ["VIEW_REPORTS", "VIEW_SENSITIVE_DATA", "VIEW_HEALTH_INFORMATION"], true, true],
    ["health and sensitive without reports on a club event", ["VIEW_SENSITIVE_DATA", "VIEW_HEALTH_INFORMATION"], true, false],
    ["health on a general event is not enough", ["VIEW_HEALTH_INFORMATION"], false, false],
  ];
  it.each(cases)("%s", (_name, permissions, clubEvent, expected) => {
    expect(canViewDietaryDetails({ permissions, clubEvent })).toBe(expected);
  });

  it("gives every built-in role the answer a person would expect", () => {
    for (const role of eventRoles) {
      const held: readonly string[] = rolePermissions[role];
      expect(canViewDietaryDetails({ permissions: held, clubEvent: true }), role).toBe(false);
      expect(canViewDietaryDetails({ permissions: held, clubEvent: false }), role).toBe(held.includes("VIEW_REPORTS") && held.includes("VIEW_SENSITIVE_DATA"));
    }
    expect(canViewDietaryDetails({ permissions: eventPermissions, clubEvent: true })).toBe(true);
  });

  it("shows only Yes or No when details are hidden, and the free text appears nowhere", () => {
    const hidden = build(registrations, false);
    expect(hidden.slice(0, 2).map((row) => row.dietaryNeeds)).toEqual(["Yes", "No"]);
    expect(JSON.stringify(hidden)).not.toContain("peanuts");
    expect(JSON.stringify(hidden)).not.toContain("celiac");
    expect(attendeeListingCsv(hidden)).not.toContain("peanuts");
    // The filter still works on the real answer.
    const all = parseAttendeeListingQuery(new URLSearchParams("statuses=CONFIRMED,CANCELLED&dietary=1"));
    expect(filterAttendeeListing(hidden, all).map((row) => row.name)).toEqual(["Ada Synthetic", "Dee Synthetic"]);
  });

  it("leaves the column blank when the form has no dietary question", () => {
    const [row] = build([registration("N1", "CONFIRMED", [attendee("n1", "Nia", "Synthetic", {})], {}, templateDefinition("tlt_application"))], false);
    expect(row.dietaryNeeds).toBe("");
  });
});

describe("field resolution over the built-in templates", () => {
  const expected: Record<string, Record<string, string>> = {
    womens_retreat_export: { meal: "meal_preference", dietary: "dietary_needs", childcare: "childcare_needed", volunteer: "volunteer", church: "church", churchOther: "church_other" },
    man_camp_export: { dietary: "dietary_needs", church: "church", churchOther: "church_other" },
    spring_camporee_export: { dietary: "dietary_needs", church: "church_name", churchOther: "church_name_other" },
    fall_camporee: { dietary: "dietary_needs", church: "church_name", churchOther: "church_name_other" },
    camp_meeting_export: { dietary: "dietary_restrictions", church: "church_name", churchOther: "church_other" },
    honors_weekend: { dietary: "dietary_needs", church: "church_name", churchOther: "church_name_other" },
    leadership_weekend: { dietary: "dietary_needs", church: "church_name", churchOther: "church_name_other" },
    tlt_retreat: { dietary: "dietary_needs" },
    outdoor_school: { dietary: "dietary_needs" },
    hispanic_institute: { church: "church_name", churchOther: "church_name_other" },
    tlt_application: { meal: "meal_preference" },
    blank_club_form: { church: "church_name", churchOther: "church_name_other" },
  };

  it("resolves the expected key per column for every template, and nothing for the rest", () => {
    for (const template of formTemplates) {
      const resolved = Object.fromEntries(
        Object.entries(resolveListingFields(template.definition as unknown as Record<string, unknown>)).map(([role, field]) => [role, field!.key]),
      );
      expect(resolved, template.key).toEqual(expected[template.key] ?? {});
    }
  });

  it("never reads the Spring Camporee's meal sponsorship questions as a meal", () => {
    expect(resolveListingFields(templateDefinition("spring_camporee_export")).meal).toBeUndefined();
    const [row] = build([registration("S1", "CONFIRMED", [attendee("s1", "Sam", "Synthetic", {})], { sponsoring_meals: "Yes", meal_times: ["Friday supper"], meal_sponsorship_count: 4 }, templateDefinition("spring_camporee_export"))]);
    expect(row.mealPreference).toBe("");
    expect(row.mealCategory).toBe("none");
  });

  it("resolves the same fields for every registration on one form version", () => {
    const many = Array.from({ length: 5 }, (_, index) => {
      const entry = registration(`V${index}`, "CONFIRMED", [attendee(`v${index}`, "Val", "Synthetic", { meal_preference: "Vegan" })]);
      // Each record carries its own copy of the definition, as the repository serialises them.
      (entry as unknown as { publicSubmission: Record<string, unknown> }).publicSubmission = { formSlug: "wr", versionNumber: 3, definition: structuredClone(definition), responses: {}, attendeeResponses: [] };
      return entry;
    });
    expect(build(many).map((row) => row.mealPreference)).toEqual(Array(5).fill("Vegan"));
  });
});

describe("no-needs answers", () => {
  it("treats neither, no restrictions and none needed as no dietary needs", () => {
    for (const text of ["Neither", "neither", "No restrictions", "No dietary restrictions", "None needed", "none", "N/A", "No"]) {
      expect(hasDietaryNeeds(text), text).toBe(false);
    }
    for (const text of ["Vegan", "Gluten Free", "Both", "synthetic: no peanuts", "Vegan; Gluten Free"]) {
      expect(hasDietaryNeeds(text), text).toBe(true);
    }
    expect(hasDietaryNeeds("None; Neither")).toBe(false);
  });

  it("reads a Neither meal answer as Regular and Both as Other", () => {
    expect(mealCategoryOf("Neither")).toBe("regular");
    expect(mealCategoryOf("Both")).toBe("other");
  });
});

describe("field scope", () => {
  it("reads attendee fields from the attendee and registration fields from the registration, with no cross-fallback", () => {
    const [first, second] = build([registration("R1", "CONFIRMED", [
      attendee("r1", "Ann", "Synthetic", { dietary_restrictions: "synthetic: attendee-level answer must not be read" }),
      attendee("r2", "Ben", "Synthetic", {}),
    ], { dietary_restrictions: "synthetic: registration-level allergy", church_name: "Test Church" }, templateDefinition("camp_meeting_export"))]);
    // dietary_restrictions is a registration-level field: first row only, never copied to the second.
    expect(first.dietaryNeeds).toBe("synthetic: registration-level allergy");
    expect(first.hasDietaryNeeds).toBe(true);
    expect(second.dietaryNeeds).toBe("");
    expect(second.hasDietaryNeeds).toBe(false);
    // The church describes everyone on the registration.
    expect([first.church, second.church]).toEqual(["Test Church", "Test Church"]);
  });

  it("counts a registration-level meal once", () => {
    const list = build([registration("R2", "CONFIRMED", [
      attendee("r1", "Ann", "Synthetic", {}),
      attendee("r2", "Ben", "Synthetic", {}),
    ], { meal_preference: "Neither" }, templateDefinition("tlt_application"))]);
    expect(mealTotals(list).find((total) => total.value === "regular")!.count).toBe(1);
  });

  it("does not read an attendee-level answer from the registration", () => {
    const [row] = build([registration("R3", "CONFIRMED", [attendee("r1", "Ann", "Synthetic", {})], { meal_preference: "Vegan" })]);
    expect(row.mealPreference).toBe("");
  });
});

describe("group registrations", () => {
  it("leaves Church blank even when the form holds church answers", () => {
    const group = registration("G1", "CONFIRMED", [attendee("g1", "Gus", "Synthetic", { meal_preference: "Vegan" })], { church: "Test Church", church_other: "Other Fellowship" });
    (group as unknown as { isGroup: boolean }).isGroup = true;
    const [row] = build([group]);
    expect(row.church).toBe("");
    expect(row.mealPreference).toBe("Vegan");
  });
});
