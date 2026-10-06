import {
  LODGING_REQUEST_ACCESSIBILITY_HEADERS,
  LODGING_REQUEST_CSV_HEADERS,
  lodgingRequestExportCells,
  type LodgingRequestExportRow,
} from "@/modules/lodging/preferences-domain";
import { toCsv } from "@/modules/reporting/csv";

/** The staff lodging-request CSV, written by the shared CSV writer (spreadsheet formulas are defused). */
export function lodgingRequestsCsv(rows: readonly LodgingRequestExportRow[], includeAccessibility: boolean) {
  return toCsv([
    [...LODGING_REQUEST_CSV_HEADERS, ...(includeAccessibility ? LODGING_REQUEST_ACCESSIBILITY_HEADERS : [])],
    ...rows.map((row) => lodgingRequestExportCells(row, includeAccessibility)),
  ]);
}
