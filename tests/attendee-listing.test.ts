import { describe, expect, it } from "vitest";
import { formTemplates } from "@/modules/forms/definition";
import type { RegistrationRecord } from "@/modules/registrations/repository";
import {
  ATTENDEE_LISTING_BOM,
  attendeeListingCsv,
  attendeeListingParams,
  buildAttendeeListingRows,
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

const rows = buildAttendeeListingRows(registrations);
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
    const [row] = buildAttendeeListingRows([registration("Z9", "CONFIRMED", [attendee("z1", "Zed", "Synthetic", { meal_preference: "Vegan" })], {}, null)]);
    expect(row).toMatchObject({ mealPreference: "", dietaryNeeds: "", childcareNeeded: "", volunteer: "", church: "", mealCategory: "none" });
    if (blankDefinition) {
      const [blank] = buildAttendeeListingRows([registration("Z8", "CONFIRMED", [attendee("z2", "Yan", "Synthetic", { meal_preference: "Vegan" })], {}, blankDefinition)]);
      expect(blank.mealPreference).toBe("");
    }
  });

  it("falls back to the original submission's answers when the attendee has none saved", () => {
    const source = registration("F6", "CONFIRMED", [attendee("f1", "Gil", "Synthetic", {})]);
    (source.publicSubmission as unknown as { attendeeResponses: unknown[] }).attendeeResponses = [{ meal_preference: "Vegan" }];
    expect(buildAttendeeListingRows([source])[0].mealPreference).toBe("Vegan");
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
