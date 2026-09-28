/**
 * Shapes and wording for "Move this import to another club year" (#541).
 * Pure, so the route's error mapping and the staff UI can share them.
 */

export type ImportYearConflict =
  | { kind: "TARGET_HAS_IMPORT"; toYear: string }
  /** `sameName`: matched by name and roster section, not by person (for example a child a director added by hand). */
  | { kind: "ALREADY_ON_TARGET_ROSTER"; rosterMemberId: string; name: string; sameName?: boolean }
  | { kind: "IN_TRANSFER"; rosterMemberId: string; name: string };

export type ImportYearMovePreview = {
  organizationId: string;
  fromYear: string;
  toYear: string;
  identityId: string;
  entryId: string;
  /** Roster rows that move: every status, since a removed row is still that import's. */
  rowsToMove: number;
  /** Of those, the ones not removed: what the roster shows. */
  peopleOnRoster: number;
  conflicts: ImportYearConflict[];
};

export class ImportYearMoveError extends Error {
  constructor(
    readonly code: "IMPORT_NOT_FOUND" | "INVALID_TARGET_YEAR" | "IMPORT_MOVE_CONFLICT",
    message: string,
    readonly preview?: ImportYearMovePreview,
  ) {
    super(message);
    this.name = "ImportYearMoveError";
  }
}


/** One conflict in plain words. Staff resolve it by hand; nothing is ever merged. */
export function conflictLabel(conflict: ImportYearConflict, toYear: string) {
  if (conflict.kind === "TARGET_HAS_IMPORT") return `This club already has a ${toYear} import. Nothing can be moved into ${toYear} until that one is moved to another year.`;
  if (conflict.kind === "ALREADY_ON_TARGET_ROSTER") {
    return conflict.sameName
      ? `Someone named ${conflict.name} in the same role is already on the ${toYear} roster. Remove that person from the ${toYear} roster (or this one from the old year), then try again.`
      : `${conflict.name} is already on the ${toYear} roster.`;
  }
  return `${conflict.name} is part of a member transfer, which is recorded for this club year.`;
}
