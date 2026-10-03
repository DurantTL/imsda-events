/**
 * Roster export builder (#490): the columns a director may choose for an
 * outside camporee's own roster format. Pure and side-effect free so both the
 * builder UI and the server routes agree on what a column key means, without
 * either importing the other's code.
 *
 * Medical and insurance data are never offered here. Guardian contacts (#510,
 * the emergency-contact decision) are offered as sensitive columns, and only
 * to someone who may see guardians (`guardian: true` below): the club's
 * director and deputy. Only fields the roster already collects appear.
 */
type RosterExportColumnDefinition = { header: string; sensitive: boolean; guardian?: true };

export const ROSTER_EXPORT_COLUMNS = {
  firstName: { header: "First name", sensitive: false },
  lastName: { header: "Last name", sensitive: false },
  birthDate: { header: "Birth date", sensitive: true },
  age: { header: "Age", sensitive: false },
  gender: { header: "Gender", sensitive: false },
  classLevel: { header: "Class", sensitive: false },
  role: { header: "Role", sensitive: false },
  guardian1Name: { header: "Guardian 1 name", sensitive: true, guardian: true },
  guardian1Relationship: { header: "Guardian 1 relationship", sensitive: true, guardian: true },
  guardian1Email: { header: "Guardian 1 email", sensitive: true, guardian: true },
  guardian1Phone: { header: "Guardian 1 cell phone", sensitive: true, guardian: true },
  guardian2Name: { header: "Guardian 2 name", sensitive: true, guardian: true },
  guardian2Relationship: { header: "Guardian 2 relationship", sensitive: true, guardian: true },
  guardian2Email: { header: "Guardian 2 email", sensitive: true, guardian: true },
  guardian2Phone: { header: "Guardian 2 cell phone", sensitive: true, guardian: true },
} as const satisfies Record<string, RosterExportColumnDefinition>;


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

/** True for a guardian column (#510): offered and run only for someone who may see guardians. */
export function isGuardianRosterExportColumn(key: RosterExportColumnKey) {
  return (ROSTER_EXPORT_COLUMNS[key] as RosterExportColumnDefinition).guardian === true;
}

/** The columns a person may be offered: guardian columns only when they may see guardians. */
export function rosterExportColumnKeysFor(canSeeGuardians: boolean): RosterExportColumnKey[] {
  return ROSTER_EXPORT_COLUMN_KEYS.filter((key) => canSeeGuardians || !isGuardianRosterExportColumn(key));
}

/** Parses a guardian column key into its slot (1 or 2) and field, or null for any other column. */
export function guardianColumnParts(key: RosterExportColumnKey): { position: 1 | 2; field: "name" | "relationship" | "email" | "phone" } | null {
  const match = /^guardian([12])(Name|Relationship|Email|Phone)$/.exec(key);
  if (!match) return null;
  return { position: Number(match[1]) as 1 | 2, field: match[2]!.toLowerCase() as "name" | "relationship" | "email" | "phone" };
}

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
