import { describe, expect, it } from "vitest";
import { buildRosterExportTable } from "@/modules/club-rosters/export";
import {
  DEFAULT_ROSTER_EXPORT_COLUMNS,
  ROSTER_EXPORT_COLUMN_KEYS,
  guardianColumnParts,
  isGuardianRosterExportColumn,
  isSensitiveRosterExportColumn,
  rosterExportColumnKeysFor,
  sensitiveRosterExportColumns,
} from "@/modules/club-rosters/export-columns";
import { toCsv } from "@/modules/reporting/csv";
import type { RosterMemberRecord } from "@/modules/club-rosters/repository";

function member(overrides: Partial<RosterMemberRecord> = {}): RosterMemberRecord {
  return {
    id: "member-1",
    firstName: "Ana",
    lastName: "Reyes",
    attendeeType: "YOUTH",
    role: "Pathfinder",
    classLevel: "EXPLORER",
    gender: "FEMALE",
    status: "ACTIVE",
    source: "DIRECTOR",
    age: 12,
    reportedAge: null,
    birthDateNeeded: false,
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("roster export columns (#490)", () => {
  it("defaults to names only, and offers no emergency contact or medical field", () => {
    expect(DEFAULT_ROSTER_EXPORT_COLUMNS.map((column) => column.key)).toEqual(["firstName", "lastName"]);
    expect(ROSTER_EXPORT_COLUMN_KEYS).toEqual([
      "firstName", "lastName", "birthDate", "age", "gender", "classLevel", "role",
      "guardian1Name", "guardian1Relationship", "guardian1Email", "guardian1Phone",
      "guardian2Name", "guardian2Relationship", "guardian2Email", "guardian2Phone",
    ]);
    expect(ROSTER_EXPORT_COLUMN_KEYS).not.toContain("emergencyContact");
  });

  it("marks birth date and every guardian column as sensitive; age is not, even though it comes from the same field", () => {
    expect(isSensitiveRosterExportColumn("birthDate")).toBe(true);
    for (const key of ROSTER_EXPORT_COLUMN_KEYS.filter((k) => k !== "birthDate" && !isGuardianRosterExportColumn(k))) {
      expect(isSensitiveRosterExportColumn(key)).toBe(false);
    }
    for (const key of ROSTER_EXPORT_COLUMN_KEYS.filter(isGuardianRosterExportColumn)) {
      expect(isSensitiveRosterExportColumn(key)).toBe(true);
    }
    expect(sensitiveRosterExportColumns([{ key: "age", header: "Age" }, { key: "birthDate", header: "DOB" }]))
      .toEqual([{ key: "birthDate", header: "DOB" }]);
  });
});

describe("buildRosterExportTable (#490)", () => {
  it("renders chosen columns, in order, under chosen headers", () => {
    const table = buildRosterExportTable(
      [member()],
      [{ key: "lastName", header: "Last" }, { key: "firstName", header: "First" }, { key: "role", header: "Role" }],
    );
    expect(table.headers).toEqual(["Last", "First", "Role"]);
    expect(table.rows).toEqual([["Reyes", "Ana", "Pathfinder"]]);
  });

  it("uses ages already on the roster record, never opening a birth date for the age column", () => {
    const table = buildRosterExportTable([member({ age: 9 })], [{ key: "age", header: "Age" }]);
    expect(table.rows).toEqual([["9"]]);
  });

  it("falls back to a reported age only when there's no birth date on file", () => {
    const table = buildRosterExportTable(
      [member({ age: null, reportedAge: 10 })],
      [{ key: "age", header: "Age" }],
    );
    expect(table.rows).toEqual([["10"]]);
  });

  it("leaves the birth date cell blank without a supplied map, and fills it in from one", () => {
    const withoutMap = buildRosterExportTable([member()], [{ key: "birthDate", header: "DOB" }]);
    expect(withoutMap.rows).toEqual([[""]]);
    const withMap = buildRosterExportTable([member()], [{ key: "birthDate", header: "DOB" }], { "member-1": "2014-05-06" });
    expect(withMap.rows).toEqual([["2014-05-06"]]);
  });

  it("labels gender and class, and blanks a missing one instead of throwing", () => {
    const table = buildRosterExportTable(
      [member({ gender: null, classLevel: null })],
      [{ key: "gender", header: "Gender" }, { key: "classLevel", header: "Class" }],
    );
    expect(table.rows).toEqual([["", ""]]);
  });

  it("the CSV built from the table matches the table cell-for-cell, with the shared escaping", () => {
    const table = buildRosterExportTable(
      [member({ firstName: "=cmd", lastName: "O'Brien" })],
      [{ key: "firstName", header: "First" }, { key: "lastName", header: "Last" }],
    );
    const csv = toCsv([table.headers, ...table.rows]);
    expect(csv).toBe('"First","Last"\r\n"\'=cmd","O\'Brien"\r\n');
  });
});

describe("guardian export columns (#510)", () => {
  const guardians = {
    "member-1": [
      { position: 1, name: "Synthetic Guardian One", relationship: "Mother", email: "one@example.test", phone: "(555) 010-0101" },
      { position: 2, name: "Synthetic Guardian Two", relationship: "", email: "", phone: "555-010-0202" },
    ],
  };

  it("offers guardian columns only to someone who may see guardians", () => {
    const withAccess = rosterExportColumnKeysFor(true);
    const without = rosterExportColumnKeysFor(false);
    expect(without).toEqual(["firstName", "lastName", "birthDate", "age", "gender", "classLevel", "role"]);
    expect(withAccess).toHaveLength(15);
    expect(without.some(isGuardianRosterExportColumn)).toBe(false);
  });

  it("reads each guardian column as its slot and field", () => {
    expect(guardianColumnParts("guardian2Phone")).toEqual({ position: 2, field: "phone" });
    expect(guardianColumnParts("guardian1Relationship")).toEqual({ position: 1, field: "relationship" });
    expect(guardianColumnParts("firstName")).toBeNull();
  });

  it("fills guardian cells from the guardians it is given, and leaves them empty otherwise", () => {
    const columns = [
      { key: "firstName" as const, header: "First" },
      { key: "guardian1Name" as const, header: "G1" },
      { key: "guardian1Phone" as const, header: "G1 phone" },
      { key: "guardian2Relationship" as const, header: "G2 rel" },
      { key: "guardian2Phone" as const, header: "G2 phone" },
    ];
    expect(buildRosterExportTable([member()], columns, null, guardians).rows).toEqual([
      ["Ana", "Synthetic Guardian One", "(555) 010-0101", "", "555-010-0202"],
    ]);
    // Without guardians (the viewer may not see them), nothing leaks into the cells.
    expect(buildRosterExportTable([member()], columns).rows).toEqual([["Ana", "", "", "", ""]]);
  });
});
