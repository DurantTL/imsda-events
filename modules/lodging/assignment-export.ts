import {
  ASSIGNMENT_ACCESSIBILITY_HEADERS,
  ASSIGNMENT_CSV_HEADERS,
  assignmentCsvCells,
  type AssignmentCsvRow,
} from "@/modules/lodging/assignment-domain";
import type { RoomingReports } from "@/modules/lodging/assignment-view";
import { toCsv } from "@/modules/reporting/csv";

/**
 * The rooming and occupancy CSVs (#200), written by the shared CSV writer so spreadsheet formulas are defused. Pure.
 * The assignments file has the columns the confirmed CSV import reads (occupant id, place key and the nights), so an
 * export edited in a spreadsheet can be previewed and imported back. The accessibility columns are written only when
 * the caller holds VIEW_SENSITIVE_DATA (`reports.canSeeSensitive`).
 */

export const lodgingReportKinds = ["assignments", "occupancy", "unassigned", "conflicts", "closeout", "keys"] as const;
export type LodgingReportKind = (typeof lodgingReportKinds)[number];

export function assignmentRows(reports: RoomingReports): AssignmentCsvRow[] {
  return reports.rooming.flatMap((group) => group.occupants.map((occupant) => ({
    occupantId: occupant.occupantId,
    kind: occupant.kind,
    registrationCode: occupant.registrationCode,
    name: occupant.name,
    building: group.building,
    place: group.place,
    placeKey: group.placeKey,
    firstNight: occupant.firstNight,
    lastNight: occupant.lastNight,
    people: occupant.people,
    groundFloorNeeded: occupant.groundFloorNeeded,
    accessibleRoomNeeded: occupant.accessibleRoomNeeded,
  })));
}

export function lodgingReportCsv(kind: LodgingReportKind, reports: RoomingReports): string {
  switch (kind) {
    case "assignments":
      return toCsv([
        [...ASSIGNMENT_CSV_HEADERS, ...(reports.canSeeSensitive ? ASSIGNMENT_ACCESSIBILITY_HEADERS : [])],
        ...assignmentRows(reports).map((row) => assignmentCsvCells(row, reports.canSeeSensitive)),
      ]);
    case "occupancy":
      return toCsv([
        ["Night", "Capacity", "Occupied", "Available", "Units in service", "People in housing elsewhere", "Includes a unit with no fixed limit"],
        ...reports.occupancy.map((row) => [row.night, row.capacity, row.occupied, row.available, row.unitsInService, row.offsite, row.unlimited ? "Yes" : "No"]),
      ]);
    case "unassigned":
      return toCsv([["Item", "Detail", "First night"], ...reports.unassigned.map((row) => [row.title, row.detail, row.night ?? ""])]);
    case "conflicts":
      return toCsv([["Kind", "Item", "Detail", "First night"], ...reports.conflicts.map((row) => [row.label, row.title, row.detail, row.night ?? ""])]);
    case "closeout":
      return toCsv([["Kind", "Item", "Detail"], ...reports.closeout.map((row) => [row.label, row.title, row.detail])]);
    case "keys":
      return toCsv([
        ["Building", "Room or site", "People", "Arrival", "Departure", "Name on the registration", "Registration codes"],
        ...reports.keyHandoff.map((row) => [row.building, row.place, row.people, row.arrival, row.departure, row.holder, row.registrationCodes.join(" ")]),
      ]);
  }
}

export function isLodgingReportKind(value: string | null): value is LodgingReportKind {
  return value !== null && (lodgingReportKinds as readonly string[]).includes(value);
}
