import { describe, expect, it } from "vitest";
import {
  churchStem,
  classLevelFrom,
  clubYearChoices,
  defaultClubName,
  parseClubRegistrationExport,
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

