import { describe, expect, it } from "vitest";
import {
  churchStem,
  classLevelFrom,
  defaultClubName,
  parseClubRegistrationExport,
  splitName,
} from "@/modules/club-imports/domain";

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
    const { drafts, skipped } = parseClubRegistrationExport([entry()]);
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
