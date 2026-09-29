import { describe, expect, it } from "vitest";
import {
  buildCheckInBook,
  checkInBookCsv,
  checkInBookExtraOptions,
  parseCheckInBookStatuses,
  type CheckInBookRegistration,
} from "@/modules/reporting/check-in-book";
import { buildClubEventRecord } from "@/modules/reporting/club-event-reports";

// Synthetic data only.
function field(
  key: string,
  label: string,
  type: string,
  scope: "ATTENDEE" | "REGISTRATION" = "ATTENDEE",
  extra: Record<string, unknown> = {},
) {
  const isChoice = ["SELECT", "RADIO", "MULTISELECT"].includes(type);
  return { id: `field_${key}`, key, label, helpText: "", type, scope, required: false, options: isChoice ? ["Option A", "Option B"] : [], ...extra };
}

function definitionWith(...fields: Array<ReturnType<typeof field>>) {
  return {
    title: "Synthetic Form",
    description: "",
    confirmationMessage: "Thanks",
    sections: [{ id: "sec_one", title: "Section", description: "", fields }],
  };
}

function optionKeys(...fields: Array<ReturnType<typeof field>>) {
  return checkInBookExtraOptions([registration({ id: "reg-x", publicSubmission: { definition: definitionWith(...fields) } })]).map((option) => option.key);
}

const definition = {
  title: "Synthetic Camporee",
  description: "",
  confirmationMessage: "Thanks",
  sections: [{
    id: "sec_roster",
    title: "Roster",
    description: "",
    fields: [
      field("attendee_type", "Roster role", "SELECT"),
      field("attendee_age", "Age", "NUMBER"),
      field("skill_induction", "Camping Skill Induction", "CHECKBOX"),
      field("medical_notes", "Medical conditions", "TEXT"),
      field("dietary_needs", "Dietary restrictions", "TEXT"),
      field("insurance_company", "Insurance company", "TEXT"),
      field("birth_date", "Birth date", "DATE"),
      field("allergy_text", "Anything we should know", "LONG_TEXT"),
      field("shirt_size", "Shirt size", "SELECT"),
      field("tents", "Tents", "TEXT", "REGISTRATION"),
    ],
  }],
};

function registration(overrides: Partial<CheckInBookRegistration> & { id: string }): CheckInBookRegistration {
  return {
    confirmationCode: overrides.id.toUpperCase(),
    accountHolder: { firstName: "Reg", lastName: "Istrant", email: "reg@example.test", phone: "555-0101" },
    attendees: [],
    publicSubmission: { definition },
    ...overrides,
  };
}

function club(
  organizationId: string,
  organizationName: string,
  registrationId: string,
  responses: Record<string, unknown>,
  attendees: Array<{ id: string; firstName: string; lastName: string; responses: Record<string, unknown> }>,
) {
  return buildClubEventRecord({
    organizationId,
    organizationName,
    sponsoringChurch: "Synthetic SDA Church",
    registrationId,
    confirmationCode: registrationId.toUpperCase(),
    status: "CONFIRMED",
    submittedAt: "2026-09-01T00:00:00.000Z",
    registrationResponses: { director_name: "Dana Director", email: "dana@example.test", phone: "555-0100", ...responses },
    attendees,
    amountOwedCents: 0,
    pricingSnapshot: {},
    lateRateLabel: null,
  });
}

const event = { name: "Synthetic Fall Camporee", startsOn: "2026-10-02T00:00:00.000Z", endsOn: "2026-10-04T00:00:00.000Z", timezone: "America/Chicago" };

const zebra = club("org-z", "Zebras", "reg-z", { kitchen_canopy: "10'x60'", tents: "10 @ 104 sq ft & 5 @ 128 sq ft" }, [
  { id: "z1", firstName: "Zed", lastName: "Adams", responses: { attendee_type: "Staff", attendee_age: 40 } },
]);
const ants = club("org-a", "Ants", "reg-a", {}, [
  { id: "a1", firstName: "Bea", lastName: "Young", responses: { attendee_type: "Pathfinder", attendee_age: 12 } },
  { id: "a2", firstName: "Cy", lastName: "Adler", responses: { attendee_type: "TLT", attendee_age: "16" } },
  { id: "a3", firstName: "Al", lastName: "Adler", responses: { attendee_type: "Child" } },
]);
const clubRegistrations = [
  registration({
    id: "reg-z",
    attendees: [{ id: "z1", firstName: "Zed", lastName: "Adams", attendeeType: "ATTENDEE", responses: { skill_induction: true, medical_notes: "SECRET-MED" } }],
  }),
  registration({
    id: "reg-a",
    attendees: [
      { id: "a1", firstName: "Bea", lastName: "Young", attendeeType: "ATTENDEE", responses: { skill_induction: true, medical_notes: "SECRET-MED" } },
      { id: "a2", firstName: "Cy", lastName: "Adler", attendeeType: "ATTENDEE", responses: { skill_induction: false } },
      { id: "a3", firstName: "Al", lastName: "Adler", attendeeType: "ATTENDEE", responses: {} },
    ],
  }),
];

describe("buildCheckInBook (club events)", () => {
  const book = buildCheckInBook({ event, mode: "CLUB", clubs: [zebra, ants], registrations: clubRegistrations, extraFieldKey: "skill_induction" });

  it("makes one page per club sorted by club name, with a cover count", () => {
    expect(book.pages.map((page) => page.title)).toEqual(["Ants", "Zebras"]);
    expect(book.cover).toEqual({ pageCount: 2, peopleCount: 4 });
  });

  it("sorts attendees by last then first name and uses the roster's role abbreviations and age", () => {
    const rows = book.pages[0].attendees;
    expect(rows.map((row) => row.name)).toEqual(["Al Adler", "Cy Adler", "Bea Young"]);
    expect(rows.map((row) => row.role)).toEqual(["Child", "TLT", "Pathfinder"]);
    expect(rows.map((row) => row.age)).toEqual([null, 16, 12]);
  });

  it("puts church, director, contact and the kitchen and tents needs in the header", () => {
    expect(book.pages[1]).toMatchObject({
      church: "Synthetic SDA Church",
      contactName: "Dana Director",
      phone: "555-0100",
      email: "dana@example.test",
      camping: { kitchen: "10'x60'", tents: "10 @ 104 sq ft & 5 @ 128 sq ft" },
    });
  });

  it("shows a dash when the camping answers are blank", () => {
    expect(book.pages[0].camping).toEqual({ kitchen: "—", tents: "—" });
  });

  it("fills the chosen extra column from each attendee's answer", () => {
    expect(book.extraColumn).toEqual({ key: "skill_induction", label: "Camping Skill Induction" });
    expect(book.pages[0].attendees.map((row) => row.extra)).toEqual(["", "", "Yes"]);
  });

  it("leaves the extra column out when nothing is picked", () => {
    const none = buildCheckInBook({ event, mode: "CLUB", clubs: [ants], registrations: clubRegistrations });
    expect(none.extraColumn).toBeNull();
    expect(none.pages[0].attendees.every((row) => row.extra === "")).toBe(true);
  });
});

describe("extra column eligibility", () => {
  it("offers only non-sensitive attendee fields", () => {
    const keys = checkInBookExtraOptions(clubRegistrations).map((option) => option.key);
    expect(keys).toEqual(["skill_induction", "shirt_size"]);
  });

  it.each(["medical_notes", "dietary_needs", "insurance_company", "birth_date", "allergy_text", "attendee_age", "tents", "nope"])(
    "ignores %s even when requested directly",
    (key) => {
      const book = buildCheckInBook({ event, mode: "CLUB", clubs: [ants], registrations: clubRegistrations, extraFieldKey: key });
      expect(book.extraColumn).toBeNull();
      expect(checkInBookCsv(book)).not.toContain("SECRET-MED");
    },
  );
});

describe("buildCheckInBook (events without clubs)", () => {
  const book = buildCheckInBook({
    event,
    mode: "REGISTRATION",
    clubs: [],
    extraFieldKey: "skill_induction",
    registrations: [
      registration({
        id: "reg-2",
        accountHolder: { firstName: "Zoe", lastName: "Baker", email: "zoe@example.test", phone: "555-0102" },
        publicSubmission: { definition: definitionWith(field("guest_age", "Age", "NUMBER"), field("skill_induction", "Camping Skill Induction", "CHECKBOX")) },
        attendees: [{ id: "p1", firstName: "Pat", lastName: "Baker", attendeeType: "ADULT", responses: { guest_age: 30, skill_induction: true } }],
      }),
      registration({
        id: "reg-1",
        accountHolder: { firstName: "Al", lastName: "Able", email: "al@example.test", phone: "555-0103" },
        attendees: [
          { id: "p3", firstName: "Zip", lastName: "Able", attendeeType: "ADULT", responses: {} },
          { id: "p2", firstName: "Amy", lastName: "Able", attendeeType: "ADULT", responses: { attendee_type: "Guest" } },
        ],
      }),
    ],
  });

  it("prints one page per registration with the registrant's name and phone and no camping line", () => {
    expect(book.pages.map((page) => [page.title, page.phone, page.camping])).toEqual([
      ["Al Able", "555-0103", null],
      ["Zoe Baker", "555-0102", null],
    ]);
  });

  it("sorts attendees by name and reads role and the definition's age key (guest_age)", () => {
    expect(book.pages[0].attendees.map((row) => [row.name, row.role])).toEqual([["Amy Able", "Guest"], ["Zip Able", "ADULT"]]);
    expect(book.pages[1].attendees[0]).toMatchObject({ age: 30, extra: "Yes" });
  });

  it("leaves the registrant's email out of the page data and the CSV", () => {
    expect(book.pages.every((page) => page.email === "")).toBe(true);
    const csv = checkInBookCsv(book);
    expect(csv).not.toContain("example.test");
    expect(csv.split("\r\n")[0]).toBe('"Registrant","Phone","Check In","Attendee","Role","Age","Camping Skill Induction"');
  });
});

describe("extra column sensitive-field rules", () => {
  it.each([
    ["current_medications", "Current medications"],
    ["insurer", "Insurer"],
    ["physician", "Physician"],
    ["seizures", "Seizures"],
    ["epipen", "EpiPen"],
    ["authorized_pickup", "Authorized pickup"],
    ["doctor_name", "Doctor"],
    ["asthma_flag", "Asthma"],
    ["inhaler_flag", "Inhaler"],
    ["accommodations", "Accommodations needed"],
    ["parent_contact", "Parent"],
    ["custody_note", "Custody"],
    ["emergency_contact", "Emergency contact"],
    ["background_check", "Background check"],
    ["disability", "Disability"],
    ["prescription", "Prescription"],
    ["health_form", "Health form"],
    ["dob_flag", "DOB"],
  ])("does not offer %s (%s) even as a checkbox or choice", (key, label) => {
    expect(optionKeys(field(key, label, "CHECKBOX"))).toEqual([]);
    expect(optionKeys(field(key, label, "SELECT"))).toEqual([]);
  });

  it("does not offer free text or long text at all", () => {
    expect(optionKeys(field("favorite_color", "Favorite color", "TEXT"), field("nickname", "Nickname", "LONG_TEXT"))).toEqual([]);
  });

  it("checks the help text and the choice labels, not just the label", () => {
    expect(optionKeys(field("group_a", "Group", "SELECT", "ATTENDEE", { helpText: "Tell us about any medication" }))).toEqual([]);
    expect(optionKeys(field("group_b", "Group", "SELECT", "ATTENDEE", { options: ["Has EpiPen", "None"] }))).toEqual([]);
    expect(optionKeys(field("group_c", "Group", "SELECT", "ATTENDEE", { options: ["Red", "Blue"], optionLabels: { Red: "Seizure watch" } }))).toEqual([]);
    expect(optionKeys(field("group_d", "Team color", "SELECT"))).toEqual(["group_d"]);
  });

  it("rules a field out when anything up its conditional or optionalWhen chain is sensitive", () => {
    const sensitive = field("has_medication", "Takes medication?", "CHECKBOX");
    const middle = field("middle_step", "Extra detail", "SELECT", "ATTENDEE", { conditional: { fieldKey: "has_medication", operator: "EQUALS", value: "true" } });
    const leaf = field("leaf_choice", "Leaf choice", "SELECT", "ATTENDEE", { optionalWhen: { fieldKey: "middle_step", operator: "NOT_EMPTY", value: "" } });
    const clean = field("clean_choice", "Clean choice", "SELECT");
    expect(optionKeys(sensitive, middle, leaf, clean)).toEqual(["clean_choice"]);
  });

  it("rules a field out when its controller is a blocked key such as gender", () => {
    const gender = field("gender", "Gender", "SELECT");
    const dependent = field("dance_group", "Dance group", "SELECT", "ATTENDEE", { conditional: { fieldKey: "gender", operator: "EQUALS", value: "Option A" } });
    expect(optionKeys(gender, dependent)).toEqual([]);
  });

  it("still offers a field that depends only on the attendee type", () => {
    const type = field("attendee_type", "Roster role", "SELECT");
    const dependent = field("skill_group", "Skill group", "SELECT", "ATTENDEE", { conditional: { fieldKey: "attendee_type", operator: "EQUALS", value: "Option A" } });
    expect(optionKeys(type, dependent)).toEqual(["skill_group"]);
  });

  it("terminates on a conditional cycle", () => {
    const one = field("cycle_one", "Cycle one", "SELECT", "ATTENDEE", { conditional: { fieldKey: "cycle_two", operator: "NOT_EMPTY", value: "" } });
    const two = field("cycle_two", "Cycle two", "SELECT", "ATTENDEE", { conditional: { fieldKey: "cycle_one", operator: "NOT_EMPTY", value: "" } });
    expect(optionKeys(one, two).sort()).toEqual(["cycle_one", "cycle_two"]);
  });

  it("drops a key that is ineligible in any form version", () => {
    const clean = definitionWith(field("skill_induction", "Camping Skill Induction", "CHECKBOX"), field("team_color", "Team color", "SELECT"));
    const older = definitionWith(field("skill_induction", "Camping Skill Induction", "CHECKBOX", "ATTENDEE", { helpText: "Note any medical needs" }), field("team_color", "Team color", "SELECT"));
    const keys = checkInBookExtraOptions([
      registration({ id: "v1", publicSubmission: { definition: clean } }),
      registration({ id: "v2", publicSubmission: { definition: older } }),
    ]).map((option) => option.key);
    expect(keys).toEqual(["team_color"]);
  });
});

describe("checkInBookCsv", () => {
  it("writes the same columns as the printed book, one row per attendee", () => {
    const book = buildCheckInBook({ event, mode: "CLUB", clubs: [zebra, ants], registrations: clubRegistrations, extraFieldKey: "skill_induction" });
    const lines = checkInBookCsv(book).trim().split("\r\n");
    expect(lines[0]).toBe('"Club","Church","Director","Phone","Email","Kitchen","Tents","Check In","Attendee","Role","Age","Camping Skill Induction"');
    expect(lines).toHaveLength(5);
    expect(lines[1]).toBe('"Ants","Synthetic SDA Church","Dana Director","555-0100","dana@example.test","—","—","","Al Adler","Child","",""');
    expect(lines[4]).toContain('"Zebras"');
    expect(lines[4]).toContain('"10\'x60\'"');
    expect(lines[4]).toContain('"Zed Adams","Staff","40","Yes"');
  });
});

describe("parseCheckInBookStatuses", () => {
  it("defaults to submitted and confirmed", () => {
    expect(parseCheckInBookStatuses(undefined)).toEqual(["SUBMITTED", "CONFIRMED"]);
    expect(parseCheckInBookStatuses(["bogus", "DRAFT"])).toEqual(["SUBMITTED", "CONFIRMED"]);
  });

  it("accepts a chosen set, repeated or comma-separated, and drops unknown values", () => {
    expect(parseCheckInBookStatuses(["WAITLISTED", "CONFIRMED", "bogus"])).toEqual(["CONFIRMED", "WAITLISTED"]);
    expect(parseCheckInBookStatuses("SUBMITTED,CANCELLED")).toEqual(["SUBMITTED", "CANCELLED"]);
  });
});
