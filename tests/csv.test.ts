import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "@/modules/reporting/csv";

describe("CSV export safety", () => {
  it("quotes commas and double quotes", () => {
    expect(csvCell('Miller, "Jennifer"')).toBe('"Miller, ""Jennifer"""');
  });

  it("neutralizes spreadsheet formulas", () => {
    expect(csvCell("=HYPERLINK(\"bad\")")).toBe('"\'=HYPERLINK(""bad"")"');
  });

  it("uses CRLF rows for downloadable exports", () => {
    expect(toCsv([["Name", "Balance"], ["Alicia", 0]])).toBe('"Name","Balance"\r\n"Alicia","0"\r\n');
  });
});

