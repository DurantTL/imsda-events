import { afterEach, describe, expect, it, vi } from "vitest";
import { CsvImportError } from "@/modules/imports/csv-parser";
import { extractGoogleSheetId, fetchWr26BundleFromGoogleSheet } from "@/modules/imports/google-sheets";

const SHEET_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=0`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("extractGoogleSheetId", () => {
  it("pulls the spreadsheet id out of a normal share link", () => {
    expect(extractGoogleSheetId(SHEET_URL)).toBe(SHEET_ID);
  });

  it("returns null for a link that isn't a Google Sheet", () => {
    expect(extractGoogleSheetId("https://example.test/not-a-sheet")).toBeNull();
  });
});

describe("fetchWr26BundleFromGoogleSheet", () => {
  it("rejects a URL that isn't a Google Sheets link before making any request", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(fetchWr26BundleFromGoogleSheet("https://example.test/sheet"))
      .rejects.toBeInstanceOf(CsvImportError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetches each recognized tab by name and returns WR26 bundle files", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = new URL(input);
      const sheetName = url.searchParams.get("sheet");
      if (sheetName === "Registrations") {
        return new Response("Registration ID,First Name\nREG-1,Avery\n", { status: 200 });
      }
      if (sheetName === "Attendees") {
        return new Response("Attendee ID,Registration ID\nATT-1,REG-1\n", { status: 200 });
      }
      return new Response("<HTML><body>Invalid query</body></HTML>", { status: 400 });
    }));

    const files = await fetchWr26BundleFromGoogleSheet(SHEET_URL);
    const names = files.map((file) => file.name).sort();
    expect(names).toEqual(["attendees.csv", "registrations.csv"]);
  });

  it("fails clearly when the sheet is missing required tabs", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<HTML>error</HTML>", { status: 400 })));
    await expect(fetchWr26BundleFromGoogleSheet(SHEET_URL))
      .rejects.toMatchObject({ code: "MISSING_COLUMNS" });
  });
});
