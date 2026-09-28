import { clubClassLevelLabels, clubRosterGenderLabels } from "@/modules/club-rosters/domain";
import type { RosterExportColumn } from "@/modules/club-rosters/export-columns";
import type { RosterMemberRecord } from "@/modules/club-rosters/repository";

/**
 * Turns roster members into the export builder's table (#490): one cell per
 * chosen column, in the chosen order, under the chosen header. The same
 * function backs both the preview and the CSV download, so the CSV always
 * matches what the director previewed.
 *
 * `birthDates` is only ever populated by an authorized, audited reveal in
 * `runRosterExport`; a member missing from it (or a blank map, when
 * the birth-date column wasn't chosen) renders as an empty cell rather than
 * throwing, since a roster row can genuinely have no birth date on file yet.
 */
export function buildRosterExportTable(
  members: RosterMemberRecord[],
  columns: RosterExportColumn[],
  birthDates: Record<string, string> | null = null,
) {
  const headers = columns.map((column) => column.header);
  const rows = members.map((member) => columns.map((column) => rosterExportCell(member, column.key, birthDates)));
  return { headers, rows };
}

function rosterExportCell(
  member: RosterMemberRecord,
  key: RosterExportColumn["key"],
  birthDates: Record<string, string> | null,
): string {
  switch (key) {
    case "firstName":
      return member.firstName;
    case "lastName":
      return member.lastName;
    case "birthDate":
      return birthDates?.[member.id] ?? "";
    case "age":
      return member.age !== null ? String(member.age) : member.reportedAge !== null ? String(member.reportedAge) : "";
    case "gender":
      return member.gender ? clubRosterGenderLabels[member.gender] : "";
    case "classLevel":
      return member.classLevel ? clubClassLevelLabels[member.classLevel] : "";
    case "role":
      return member.role || "";
  }
}
