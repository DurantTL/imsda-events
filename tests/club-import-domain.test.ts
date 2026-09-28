import { describe, expect, it } from "vitest";
import {
  churchStem,
  classLevelFrom,
  clubYearChoices,
  defaultClubName,
  earlierImportNotice,
  importPersonKey,
  inFileDuplicateKeys,
  parseClubRegistrationExport,
  scopeClubYear,
  skipReasonLabel,
  splitName,
  submissionYearNote,
} from "@/modules/club-imports/domain";
import { clubImportItemSchema } from "@/modules/club-imports/schemas";
import { syntheticExportEntry } from "./support/club-import-fixture";

const september = new Date("2026-09-28T15:00:00Z");

// Synthetic entries shaped like the Fluent Forms export of form 89. No real people.
function entry(overrides: Record<string, unknown> = {}, response: Record<string, unknown> = {}) {
  return {
    id: 501,
    form_id: "89",
    status: "read",
    created_at: "2026-09-10 14:00:00",
    response: {
      multi_select: ["Example SDA Church"],
      leader_name: "Pat Example",
      leader_address: "1 Sample Street, Testville",
      leader_cell_phone: "555-0100",
      leader_email: "Leader@Example.test",
      leader_child_protection: "yes",
      co_leader_name: "Sam Sample",
      co_leader_address: "2 Sample Street",
      co_leader_email: "not an email",
      co_leader_child_protection: "no",
      other_assistants: [["Robin Q Tester", "3 Sample Street", "555-0101", "robin@example.test", "Yes"]],
      approx_pathfinders: "3",
      repeater_container: [["Alex Sample", "12", "Friend"], ["Jordan Example", "15", "master guide"], ["Casey", "x", "Pathfinder"]],
      ...response,
    },
    ...overrides,
  };
}

describe("reading the form 89 export (#376)", () => {
  it("turns an entry into an editable club draft", () => {
    const { drafts, skipped } = parseClubRegistrationExport([entry()], september);
    expect(skipped).toBe(0);
    const [draft] = drafts;
    expect(draft).toMatchObject({
      sourceKey: "form-89:501",
      entryId: "501",
      clubYear: "2026-27",
      churchName: "Example SDA Church",
      clubName: "Example Pathfinders",
    });
    expect(draft.invites).toEqual([
      expect.objectContaining({ role: "DIRECTOR", name: "Pat Example", email: "leader@example.test", include: true }),
      expect.objectContaining({ role: "DEPUTY", name: "Sam Sample", email: "", include: false }),
    ]);
    const byName = Object.fromEntries(draft.people.map((person) => [`${person.firstName} ${person.lastName}`.trim(), person]));
    expect(byName["Pat Example"]).toMatchObject({ attendeeType: "STAFF", role: "Director" });
    expect(byName["Robin Q Tester"]).toMatchObject({ firstName: "Robin Q", lastName: "Tester", attendeeType: "STAFF" });
    expect(byName["Alex Sample"]).toMatchObject({ attendeeType: "YOUTH", reportedAge: 12, classLevel: "FRIEND" });
    expect(byName["Jordan Example"]).toMatchObject({ classLevel: "MASTER_GUIDE", reportedAge: 15 });
    expect(byName.Casey).toMatchObject({ lastName: "", reportedAge: null, classLevel: null, classText: "Pathfinder" });
  });

  it("never carries addresses, phone numbers, or child-protection answers", () => {
    const text = JSON.stringify(parseClubRegistrationExport([entry()]).drafts);
    for (const secret of ["Sample Street", "555-0100", "555-0101", "robin@example.test", "child"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("skips trashed entries and other forms, and refuses a file with none", () => {
    const { drafts, skipped } = parseClubRegistrationExport([entry(), entry({ id: 502, status: "trashed" }), entry({ id: 503, form_id: "62" }), "junk"]);
    expect(drafts.map((draft) => draft.entryId)).toEqual(["501"]);
    expect(skipped).toBe(3);
    expect(() => parseClubRegistrationExport({ not: "a list" })).toThrow(/entries export/);
    expect(() => parseClubRegistrationExport([entry({ status: "trashed" })])).toThrow(/No club registrations/);
  });

  it("names clubs and matches churches loosely", () => {
    expect(defaultClubName("Des Moines Seventh-day Adventist Church")).toBe("Des Moines Pathfinders");
    expect(churchStem("Albany SDA Church")).toBe(churchStem("albany church"));
    expect(splitName("  Mary   Ann  Example ")).toEqual({ firstName: "Mary Ann", lastName: "Example" });
    expect(classLevelFrom("T.L.T.")).toBe("TLT");
    expect(classLevelFrom("Adventurer")).toBeNull();
  });
});

describe("choosing the club year (#541)", () => {
  it("defaults an August submission to the current club year, and says so", () => {
    const { drafts } = parseClubRegistrationExport([syntheticExportEntry()], september);
    const [draft] = drafts;
    expect(draft.submittedOn).toBe("2026-08-31");
    expect(draft.submittedClubYear).toBe("2025-26");
    expect(draft.clubYear).toBe("2026-27");
    expect(submissionYearNote(draft)).toBe("Submitted 2026-08-31, which falls in the 2025-26 club year. Importing into 2026-27.");
  });

  it("follows the import date, not the submission date", () => {
    const [inAugust] = parseClubRegistrationExport([syntheticExportEntry()], new Date("2026-08-31T18:00:00Z")).drafts;
    expect(inAugust.clubYear).toBe("2025-26");
    expect(submissionYearNote(inAugust)).toBe("");
    const [nextYear] = parseClubRegistrationExport([syntheticExportEntry()], new Date("2027-09-02T18:00:00Z")).drafts;
    expect(nextYear.clubYear).toBe("2027-28");
  });

  it("offers the previous, current, and next club year", () => {
    expect(clubYearChoices(september)).toEqual(["2025-26", "2026-27", "2027-28"]);
    expect(clubYearChoices(new Date("2099-12-31T00:00:00Z"))).toEqual(["2098-99", "2099-00", "2100-01"]);
  });

  it("respects the year sent through the confirm schema and rejects malformed years", () => {
    const base = { sourceKey: "form-89:1", entryId: "1", clubName: "Example Pathfinders", churchId: "church-1", invites: [], people: [] };
    expect(clubImportItemSchema.parse({ ...base, clubYear: "2025-26" }).clubYear).toBe("2025-26");
    expect(() => clubImportItemSchema.parse({ ...base, clubYear: "2025-28" })).toThrow(/valid club year/);
    expect(() => clubImportItemSchema.parse({ ...base, clubYear: "2026" })).toThrow();
  });

  it("gives every skip a plain reason", () => {
    expect(skipReasonLabel("ALREADY_ON_ROSTER", "2026-27")).toBe("already on the roster for 2026-27");
    expect(skipReasonLabel("DUPLICATE_IN_REGISTRATION", "2026-27")).toMatch(/twice/);
  });

  it("reads the synthetic August export completely", () => {
    const [draft] = parseClubRegistrationExport([syntheticExportEntry()], september).drafts;
    expect(draft.people).toHaveLength(2 + 8 + 38);
    expect(draft.people.every((person) => person.include && person.lastName)).toBe(true);
    expect(draft.people.find((person) => person.firstName === "Bo")).toMatchObject({ lastName: "Placeholder", attendeeType: "YOUTH" });
  });
});


describe("splitting a full name (#541)", () => {
  it("keeps a suffix with the last name, with or without periods, in any case", () => {
    expect(splitName("Chris Faux Jr.")).toEqual({ firstName: "Chris", lastName: "Faux Jr." });
    expect(splitName("Chris Faux jr")).toEqual({ firstName: "Chris", lastName: "Faux jr" });
    expect(splitName("Chris Faux SR.")).toEqual({ firstName: "Chris", lastName: "Faux SR." });
    expect(splitName("Pat Lee Example II")).toEqual({ firstName: "Pat Lee", lastName: "Example II" });
    expect(splitName("Pat Example iii")).toEqual({ firstName: "Pat", lastName: "Example iii" });
    expect(splitName("Pat Example IV")).toEqual({ firstName: "Pat", lastName: "Example IV" });
  });

  it("leaves a lone first name and suffix without a last name, for staff to fix", () => {
    expect(splitName("Chris Jr.")).toEqual({ firstName: "Chris Jr.", lastName: "" });
  });

  it("joins a particle to the last name only when another word follows it", () => {
    expect(splitName("Ana de la Cruz")).toEqual({ firstName: "Ana", lastName: "de la Cruz" });
    expect(splitName("Ana De Silva")).toEqual({ firstName: "Ana", lastName: "De Silva" });
    expect(splitName("Tom van Example")).toEqual({ firstName: "Tom", lastName: "van Example" });
    expect(splitName("Eva von Sample")).toEqual({ firstName: "Eva", lastName: "von Sample" });
    expect(splitName("Rui da Fixture Jr.")).toEqual({ firstName: "Rui", lastName: "da Fixture Jr." });
    expect(splitName("Lia del Mock")).toEqual({ firstName: "Lia", lastName: "del Mock" });
    // Nothing follows the particle, or it is the only first name: an ordinary word.
    expect(splitName("Van Example")).toEqual({ firstName: "Van", lastName: "Example" });
    expect(splitName("Ana Maria Da")).toEqual({ firstName: "Ana Maria", lastName: "Da" });
    // A lone "la" is not a particle; only "de la" is.
    expect(splitName("Ana La Rosa")).toEqual({ firstName: "Ana La", lastName: "Rosa" });
  });

  it("handles a comma before a suffix, a middle Van, and a surname that looks like a suffix (#541 N3)", () => {
    expect(splitName("Chris Faux, Jr.")).toEqual({ firstName: "Chris", lastName: "Faux Jr." });
    expect(splitName("Chris Faux , Sr")).toEqual({ firstName: "Chris", lastName: "Faux Sr" });
    expect(splitName("Tran Van Minh")).toEqual({ firstName: "Tran Van", lastName: "Minh" });
    expect(splitName("Kim Iv")).toEqual({ firstName: "Kim", lastName: "Iv" });
    expect(splitName("Kim II")).toEqual({ firstName: "Kim", lastName: "II" });
    expect(splitName("Pat Kim IV")).toEqual({ firstName: "Pat", lastName: "Kim IV" });
  });

  it("treats a suffix with or without its dot or comma as the same name", () => {
    const key = (firstName: string, lastName: string) => importPersonKey({ attendeeType: "STAFF", firstName, lastName });
    expect(key("Chris", "Faux Jr.")).toBe(key("Chris", "Faux Jr"));
    expect(key("Chris", "Faux, Jr.")).toBe(key("chris", "FAUX JR"));
    expect(key("Chris", "Faux Jr.")).not.toBe(key("Chris", "Faux"));
  });

  it("uses the split for imported people", () => {
    const [draft] = parseClubRegistrationExport([syntheticExportEntry({}, { leader_name: "Chris Faux Jr." })], september).drafts;
    expect(draft.people[0]).toMatchObject({ firstName: "Chris", lastName: "Faux Jr.", keepBoth: false });
  });
});

describe("same-named people in one registration (#541)", () => {
  const person = (key: string, firstName: string, lastName: string, attendeeType: "STAFF" | "YOUTH", include = true) =>
    ({ key, include, firstName, lastName, attendeeType });

  it("matches on the full name and the roster section, not on case or spacing", () => {
    expect(importPersonKey({ attendeeType: "YOUTH", firstName: "Robin", lastName: "Faux" })).toBe(importPersonKey({ attendeeType: "UNDERAGE", firstName: " robin", lastName: "FAUX " }));
    expect(importPersonKey({ attendeeType: "STAFF", firstName: "Robin", lastName: "Faux" })).toBe(importPersonKey({ attendeeType: "ADULT", firstName: "Robin", lastName: "Faux" }));
    expect(importPersonKey({ attendeeType: "STAFF", firstName: "Robin", lastName: "Faux" })).not.toBe(importPersonKey({ attendeeType: "YOUTH", firstName: "Robin", lastName: "Faux" }));
  });

  it("flags the later of two same-named youths, never a parent and child, and ignores skipped people", () => {
    expect([...inFileDuplicateKeys([
      person("a", "Robin", "Faux", "YOUTH"),
      person("b", "robin", "faux", "YOUTH"),
      person("c", "Robin", "Faux", "STAFF"),
      person("d", "Sam", "Faux", "YOUTH", false),
      person("e", "Sam", "Faux", "YOUTH"),
    ])]).toEqual(["b"]);
  });

  it("reads the synthetic export with no false duplicates", () => {
    const [draft] = parseClubRegistrationExport([syntheticExportEntry()], september).drafts;
    expect(inFileDuplicateKeys(draft.people).size).toBe(0);
  });
});

describe("earlier imports of an entry (#541)", () => {
  const club = { id: "club-9", name: "Fixture Pathfinders" };

  it("blocks the year it was imported for, pointing to Move", () => {
    expect(earlierImportNotice({ "2026-27": club }, "2026-27")).toEqual({
      blocking: true,
      clubId: "club-9",
      message: "Already imported for 2026-27. To fix the year, use Move import to another year.",
    });
  });

  it("suggests Move, without blocking, when it was imported for another year only", () => {
    const notice = earlierImportNotice({ "2025-26": club }, "2026-27");
    expect(notice).toMatchObject({ blocking: false, clubId: "club-9" });
    expect(notice?.message).toMatch(/^Already imported for 2025-26\. .*Move import to another year instead\.$/);
    expect(earlierImportNotice({}, "2026-27")).toBeNull();
  });

  it("reads the club year out of an import scope", () => {
    expect(scopeClubYear("form-89:2025-26")).toBe("2025-26");
    expect(scopeClubYear("form-89:501")).toBeNull();
    expect(scopeClubYear("form-12:2025-26")).toBeNull();
  });
});
