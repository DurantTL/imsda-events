import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RosterCsvImport } from "@/components/roster-csv-import";
import { RosterTypeDefinitions } from "@/components/roster-type-definitions";
import {
  attendeeTypeAgeHint,
  clubRosterAttendeeTypeDefinitions,
  clubRosterAttendeeTypeLabels,
} from "@/modules/club-rosters/domain";

describe("roster member type help (#576)", () => {
  it("keeps the four stored values and labels unchanged", () => {
    expect(clubRosterAttendeeTypeLabels).toEqual({ YOUTH: "Youth", STAFF: "Staff", ADULT: "Adult", UNDERAGE: "Underage" });
    expect(Object.keys(clubRosterAttendeeTypeDefinitions)).toEqual(Object.keys(clubRosterAttendeeTypeLabels));
  });

  it("renders a definition for every type", () => {
    const html = renderToStaticMarkup(createElement(RosterTypeDefinitions));
    for (const [value, label] of Object.entries(clubRosterAttendeeTypeLabels)) {
      expect(html).toContain(`${label}:`);
      expect(html).toContain(
        clubRosterAttendeeTypeDefinitions[value as keyof typeof clubRosterAttendeeTypeDefinitions].replace(/'/g, "&#x27;"),
      );
    }
  });

  it("shows the definitions in the CSV template help", () => {
    // The dialog keeps its help closed until opened, so render the help node it is given.
    const dialog = RosterCsvImport({ base: "/x", onImported: () => {} });
    const html = renderToStaticMarkup(dialog.props.help);
    expect(html).toContain("roster-type-definitions");
    expect(html).toContain("Underage:");
  });

  it("hints when age and type disagree, and stays quiet otherwise", () => {
    const today = "2026-09-29";
    expect(attendeeTypeAgeHint("YOUTH", "2007-01-01", today)).toContain("19");
    expect(attendeeTypeAgeHint("ADULT", "2014-01-01", today)).toContain("12");
    expect(attendeeTypeAgeHint("STAFF", "2015-01-01", today)).not.toBeNull();
    expect(attendeeTypeAgeHint("UNDERAGE", "2014-01-01", today)).not.toBeNull();
    expect(attendeeTypeAgeHint("YOUTH", "2014-01-01", today)).toBeNull();
    expect(attendeeTypeAgeHint("ADULT", "1980-01-01", today)).toBeNull();
    expect(attendeeTypeAgeHint("STAFF", "1990-01-01", today)).toBeNull();
    expect(attendeeTypeAgeHint("UNDERAGE", "2024-01-01", today)).toBeNull();
    expect(attendeeTypeAgeHint("YOUTH", "not-a-date", today)).toBeNull();
  });

  it("switches at the age boundaries", () => {
    const today = "2026-09-29";
    expect(attendeeTypeAgeHint("YOUTH", "2008-09-29", today)).toBeNull(); // 18
    expect(attendeeTypeAgeHint("YOUTH", "2007-09-29", today)).not.toBeNull(); // 19
    expect(attendeeTypeAgeHint("STAFF", "2010-09-29", today)).toBeNull(); // 16
    expect(attendeeTypeAgeHint("STAFF", "2011-09-29", today)).not.toBeNull(); // 15
    expect(attendeeTypeAgeHint("ADULT", "2008-09-29", today)).toBeNull(); // 18
    expect(attendeeTypeAgeHint("ADULT", "2009-09-29", today)).not.toBeNull(); // 17
    expect(attendeeTypeAgeHint("UNDERAGE", "2023-09-29", today)).toBeNull(); // 3
    expect(attendeeTypeAgeHint("UNDERAGE", "2022-09-29", today)).not.toBeNull(); // 4
  });

  it("gives no hint for a future birth date", () => {
    expect(attendeeTypeAgeHint("YOUTH", "2027-01-01", "2026-09-29")).toBeNull();
  });
});
