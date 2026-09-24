import { describe, expect, it } from "vitest";
import { isCsvFile } from "@/components/csv-import-dialog";

describe("CSV import drop zone (#424)", () => {
  it("accepts a .csv file however the browser labels it", () => {
    expect(isCsvFile({ name: "roster.csv", type: "text/csv" })).toBe(true);
    // Dropped files can arrive with no type at all.
    expect(isCsvFile({ name: "roster.csv", type: "" })).toBe(true);
    expect(isCsvFile({ name: "ROSTER.CSV", type: "" })).toBe(true);
    // Windows often calls a CSV one of these.
    expect(isCsvFile({ name: "Roster.Csv", type: "application/vnd.ms-excel" })).toBe(true);
    expect(isCsvFile({ name: "roster.csv", type: "text/plain" })).toBe(true);
    expect(isCsvFile({ name: "export", type: "text/csv; charset=utf-8" })).toBe(true);
  });

  it("refuses files that aren't CSVs", () => {
    expect(isCsvFile({ name: "roster.xlsx", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })).toBe(false);
    expect(isCsvFile({ name: "notes.txt", type: "text/plain" })).toBe(false);
    expect(isCsvFile({ name: "photo.png", type: "" })).toBe(false);
  });
});
