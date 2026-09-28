/**
 * Roster export builder (#490): the columns a director may choose for an
 * outside camporee's own roster format. Pure and side-effect free so both the
 * builder UI and the server routes agree on what a column key means, without
 * either importing the other's code.
 *
 * Medical, insurance, and emergency-contact data are never offered here (the
 * issue defers emergency contact to a separate, still-undecided slice); only
 * fields the roster already collects appear below.
 */
export const ROSTER_EXPORT_COLUMNS = {
  firstName: { header: "First name", sensitive: false },
  lastName: { header: "Last name", sensitive: false },
  birthDate: { header: "Birth date", sensitive: true },
  age: { header: "Age", sensitive: false },
  gender: { header: "Gender", sensitive: false },
  classLevel: { header: "Class", sensitive: false },
  role: { header: "Role", sensitive: false },
} as const;

export type RosterExportColumnKey = keyof typeof ROSTER_EXPORT_COLUMNS;

export const ROSTER_EXPORT_COLUMN_KEYS = Object.keys(ROSTER_EXPORT_COLUMNS) as RosterExportColumnKey[];

export function isRosterExportColumnKey(value: string): value is RosterExportColumnKey {
  return Object.hasOwn(ROSTER_EXPORT_COLUMNS, value);
}

/** Minimal by default (the issue's decision): names only, nothing sensitive. */
export const DEFAULT_ROSTER_EXPORT_COLUMNS: RosterExportColumn[] = [
  { key: "firstName", header: ROSTER_EXPORT_COLUMNS.firstName.header },
  { key: "lastName", header: ROSTER_EXPORT_COLUMNS.lastName.header },
];

export type RosterExportColumn = { key: RosterExportColumnKey; header: string };

export function isSensitiveRosterExportColumn(key: RosterExportColumnKey) {
  return ROSTER_EXPORT_COLUMNS[key].sensitive;
}

/** The sensitive columns among a selection, in the order they were chosen — for naming in a confirmation. */
export function sensitiveRosterExportColumns(columns: RosterExportColumn[]) {
  return columns.filter((column) => isSensitiveRosterExportColumn(column.key));
}

/**
 * How many rows a preview returns. The server enforces this cap (never only
 * the builder), so a preview can't be used to pull the whole roster, and a
 * preview with birth dates opens only this many.
 */
export const ROSTER_EXPORT_PREVIEW_ROW_LIMIT = 5;
