import { describe, expect, it } from "vitest";
import { buildRosterExportTable } from "@/modules/club-rosters/export";
import {
  DEFAULT_ROSTER_EXPORT_COLUMNS,
  ROSTER_EXPORT_COLUMN_KEYS,
  isSensitiveRosterExportColumn,
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
    willingToDrive: false,
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("roster export columns (#490)", () => {
  it("defaults to names only, and offers no emergency contact or medical field", () => {
    expect(DEFAULT_ROSTER_EXPORT_COLUMNS.map((column) => column.key)).toEqual(["firstName", "lastName"]);
    expect(ROSTER_EXPORT_COLUMN_KEYS).toEqual(["firstName", "lastName", "birthDate", "age", "gender", "classLevel", "role"]);
    expect(ROSTER_EXPORT_COLUMN_KEYS).not.toContain("emergencyContact");
  });

  it("marks only birth date as sensitive; age is not, even though it comes from the same field", () => {
    expect(isSensitiveRosterExportColumn("birthDate")).toBe(true);
    for (const key of ROSTER_EXPORT_COLUMN_KEYS.filter((k) => k !== "birthDate")) {
      expect(isSensitiveRosterExportColumn(key)).toBe(false);
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
