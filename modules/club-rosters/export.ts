import { clubClassLevelLabels, clubRosterGenderLabels } from "@/modules/club-rosters/domain";
import { guardianColumnParts, type RosterExportColumn } from "@/modules/club-rosters/export-columns";
import type { GuardianRecord } from "@/modules/club-rosters/guardians-domain";
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
 * `guardians` (#510) is likewise only passed by `runRosterExport` after it has
 * confirmed the actor may see guardians; without it guardian cells are empty.
 */
export function buildRosterExportTable(
  members: RosterMemberRecord[],
  columns: RosterExportColumn[],
  birthDates: Record<string, string> | null = null,
  guardians: Record<string, GuardianRecord[]> | null = null,
) {
  const headers = columns.map((column) => column.header);
  const rows = members.map((member) => columns.map((column) => rosterExportCell(member, column.key, birthDates, guardians)));
  return { headers, rows };
}

function rosterExportCell(
  member: RosterMemberRecord,
  key: RosterExportColumn["key"],
  birthDates: Record<string, string> | null,
  guardians: Record<string, GuardianRecord[]> | null,
): string {
  const guardianPart = guardianColumnParts(key);
  if (guardianPart) {
    return guardians?.[member.id]?.find((guardian) => guardian.position === guardianPart.position)?.[guardianPart.field] ?? "";
  }
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
    default:
      return "";
  }
}
