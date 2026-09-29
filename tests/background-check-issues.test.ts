import { describe, expect, it } from "vitest";
import { backgroundFlagsCsv } from "@/modules/background-checks/domain";
import { assessIssues, daysUntil, describeIssues, formatIssueDate, parseIssues } from "@/modules/background-checks/issues";

describe("parsing the background-check issues column (#544)", () => {
  it("reads blank as good standing", () => {
    for (const blank of [null, undefined, "", "   ", " , ,"]) {
      expect(parseIssues(blank)).toEqual({ items: [], unrecognised: [] });
    }
  });

  it("reads Non-Driver, BGC and Training with no date", () => {
    expect(parseIssues("Non-Driver").items).toEqual([{ kind: "NON_DRIVER", date: null }]);
    expect(parseIssues("BGC").items).toEqual([{ kind: "BGC", date: null }]);
    expect(parseIssues("Training").items).toEqual([{ kind: "TRAINING", date: null }]);
  });

  it("reads a two-digit-year date as month/day/20YY", () => {
    expect(parseIssues("Training (10/04/26)").items).toEqual([{ kind: "TRAINING", date: "2026-10-04" }]);
  });

  it("reads several comma-separated items", () => {
    expect(parseIssues("Training (10/04/26),BGC (10/04/26)")).toEqual({
      items: [{ kind: "TRAINING", date: "2026-10-04" }, { kind: "BGC", date: "2026-10-04" }],
      unrecognised: [],
    });
  });

  it("is lenient about case, spacing, and a four-digit year", () => {
    expect(parseIssues("  bgc(1/5/2027) ,  TRAINING  ( 10 / 04 / 26 ) ,non driver, NON-DRIVER,Non_Driver,").items).toEqual([
      { kind: "BGC", date: "2027-01-05" },
      { kind: "TRAINING", date: "2026-10-04" },
      { kind: "NON_DRIVER", date: null },
      { kind: "NON_DRIVER", date: null },
      { kind: "NON_DRIVER", date: null },
    ]);
  });

  it("keeps anything unknown, as written, and never guesses", () => {
    expect(parseIssues("BGC, Fingerprints pending")).toEqual({
      items: [{ kind: "BGC", date: null }],
      unrecognised: ["Fingerprints pending"],
    });
    // A date that isn't a real calendar date is unrecognised, not silently undated.
    expect(parseIssues("BGC (13/45/26)")).toEqual({ items: [], unrecognised: ["BGC (13/45/26)"] });
    expect(parseIssues("BGC (02/30/26)").unrecognised).toEqual(["BGC (02/30/26)"]);
    expect(parseIssues("BGC 10/04/26").unrecognised).toEqual(["BGC 10/04/26"]);
  });
});

describe("assessing issues on a day (#544)", () => {
  const today = "2026-10-01";

  it("treats an undated BGC or Training as expired", () => {
    expect(assessIssues("BGC", today).expired).toEqual(["BGC"]);
    expect(assessIssues("Training", today).expired).toEqual(["TRAINING"]);
  });

  it("treats a past date as expired and a future date as ahead, with an injected day", () => {
    expect(assessIssues("Training (09/30/26)", today)).toMatchObject({ expired: ["TRAINING"], soonest: null });
    expect(assessIssues("Training (10/02/26)", today)).toMatchObject({ expired: [], soonest: "2026-10-02" });
    expect(assessIssues("Training (10/02/26)", "2026-10-03")).toMatchObject({ expired: ["TRAINING"], soonest: null });
  });

  it("tells a passed date from an undated item", () => {
    expect(assessIssues("BGC (09/30/26), Training", today)).toMatchObject({ expired: ["BGC", "TRAINING"], pastDue: ["BGC"] });
    expect(assessIssues("Training", today).pastDue).toEqual([]);
  });

  it("lasts through the date itself", () => {
    expect(assessIssues("BGC (10/01/26)", today)).toMatchObject({ expired: [], soonest: "2026-10-01" });
  });

  it("finds the soonest of several future dates and flags Non-Driver on its own", () => {
    expect(assessIssues("BGC (12/01/26), Training (10/15/26), Non-Driver", today)).toEqual({
      nonDriver: true,
      expired: [],
      pastDue: [],
      soonest: "2026-10-15",
      unrecognised: [],
    });
  });

  it("formats and counts dates without a time zone shift", () => {
    expect(formatIssueDate("2026-10-04")).toBe("10/04/2026");
    expect(daysUntil("2026-10-01", "2026-10-31")).toBe(30);
    expect(daysUntil("2026-10-31", "2026-10-01")).toBe(-30);
  });
});

describe("readable reasons for staff (#544)", () => {
  const today = "2026-10-01";

  it("says what each item means, in the order written", () => {
    expect(describeIssues("Non-Driver", today)).toEqual(["Marked Non-Driver"]);
    expect(describeIssues("BGC", today)).toEqual(["Background check expired"]);
    expect(describeIssues("Training", today)).toEqual(["Child-protection training not completed"]);
    expect(describeIssues("Training (10/04/26),BGC (09/30/26), non driver", today)).toEqual([
      "Child-protection training expiring (10/04/2026)",
      "Background check expired (09/30/2026)",
      "Marked Non-Driver",
    ]);
  });

  it("is empty for blank text and leaves unrecognised items to the text shown beside it", () => {
    expect(describeIssues("", today)).toEqual([]);
    expect(describeIssues(null, today)).toEqual([]);
    expect(describeIssues("Fingerprints pending", today)).toEqual([]);
  });
});

describe("the event background-check CSV never carries the issues text (#427, #544)", () => {
  it("has no issues column, so the download can go to any event workspace role", () => {
    const csv = backgroundFlagsCsv([{
      lastName: "Driver", firstName: "Dana", attendeeType: "ADULT", clubName: "Test Club", confirmationCode: "TEST-1",
      state: "NOT_COMPLIANT", expiresOn: null,
    }]);
    expect(csv).not.toContain("Issues");
    expect(csv.split(/\r?\n/)[0]).toBe(["Last name", "First name", "Attendee type", "Club", "Confirmation code", "Background check", "Expired on"].map((name) => `"${name}"`).join(","));
  });
});
