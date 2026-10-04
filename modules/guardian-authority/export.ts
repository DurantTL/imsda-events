import { toCsv } from "@/modules/reporting/csv";

export type ResponsibleAdultCsvRow = {
  confirmationCode: string;
  minorName: string;
  minorAge: number | null;
  minorStatus: "MINOR" | "ADULT" | "UNKNOWN";
  responsibleAdult: string;
  adultConfirmationCode: string;
  state: string;
};

export const RESPONSIBLE_ADULT_CSV_HEADERS = [
  "Confirmation code",
  "Minor",
  "Age at event start",
  "Age status",
  "Responsible adult",
  "Adult's confirmation code",
  "Status",
] as const;

const ageStatusLabel = { MINOR: "Minor", ADULT: "Adult", UNKNOWN: "Age unknown" } as const;

/**
 * One row per minor (or person of unknown age) with who is responsible for them, so lodging can seat a minor
 * with their adult. Written by the shared CSV writer: a name that starts with `=`, `+`, `-` or `@` cannot run as
 * a spreadsheet formula.
 */
export function responsibleAdultsCsv(rows: readonly ResponsibleAdultCsvRow[]) {
  return toCsv([
    [...RESPONSIBLE_ADULT_CSV_HEADERS],
    ...rows.map((row) => [
      row.confirmationCode,
      row.minorName,
      row.minorAge ?? "",
      ageStatusLabel[row.minorStatus],
      row.responsibleAdult,
      row.adultConfirmationCode,
      row.state,
    ]),
  ]);
}
