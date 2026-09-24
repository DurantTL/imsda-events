import { describe, expect, it } from "vitest";
import {
  clubAssignmentChangedSinceSent,
  clubAssignmentEmailBlock,
  clubAssignmentEverSent,
  clubAssignmentStatus,
  emptyClubAssignmentFields,
  hasAnyClubAssignmentPreferences,
  readClubAssignmentPreferences,
} from "@/modules/club-registrations/assignments";

describe("clubAssignmentStatus", () => {
  it("is UNASSIGNED when nothing is set", () => {
    expect(clubAssignmentStatus(emptyClubAssignmentFields)).toBe("UNASSIGNED");
  });

  it("is UNASSIGNED when only free-text notes are set", () => {
    expect(clubAssignmentStatus({ ...emptyClubAssignmentFields, notes: "Bring extra chairs" })).toBe("UNASSIGNED");
  });

  it("is PARTIAL when only some of campsite/duty/activity are set", () => {
    expect(clubAssignmentStatus({ ...emptyClubAssignmentFields, campsiteLocation: "Field C, site 12" })).toBe("PARTIAL");
    expect(clubAssignmentStatus({
      ...emptyClubAssignmentFields,
      campsiteLocation: "Field C, site 12",
      dutyLabel: "Flag raising / lowering",
    })).toBe("PARTIAL");
  });

  it("is SET only once campsite, duty, and activity are all set", () => {
    expect(clubAssignmentStatus({
      ...emptyClubAssignmentFields,
      campsiteLocation: "Field C, site 12",
      dutyLabel: "Flag raising / lowering",
      activityLabel: "Campfire singing",
    })).toBe("SET");
  });
});

describe("clubAssignmentChangedSinceSent", () => {
  it("is false for an assignment that has never been emailed", () => {
    expect(clubAssignmentChangedSinceSent({ version: 1, lastEmailedVersion: null })).toBe(false);
  });

  it("is false right after the version that was sent", () => {
    expect(clubAssignmentChangedSinceSent({ version: 2, lastEmailedVersion: 2 })).toBe(false);
  });

  it("is true once the version has moved past what was sent", () => {
    expect(clubAssignmentChangedSinceSent({ version: 3, lastEmailedVersion: 2 })).toBe(true);
  });
});

describe("clubAssignmentEverSent", () => {
  it("reflects whether an email has ever gone out", () => {
    expect(clubAssignmentEverSent({ lastEmailSentAt: null })).toBe(false);
    expect(clubAssignmentEverSent({ lastEmailSentAt: "2026-09-20T00:00:00.000Z" })).toBe(true);
  });
});

describe("readClubAssignmentPreferences", () => {
  it("reads only the sc_ preference keys that exist, by their form key", () => {
    const preferences = readClubAssignmentPreferences({
      duty_areas: ["Flag raising / lowering", "Bathroom clean-up"],
      flag_slots: ["Friday morning"],
      camp_next_to: "Pathfinder Pioneers",
      total_sqft: "600",
      unrelated_field: "ignored",
    });
    expect(preferences.dutyAreas).toEqual(["Flag raising / lowering", "Bathroom clean-up"]);
    expect(preferences.flagSlots).toEqual(["Friday morning"]);
    expect(preferences.campNextTo).toBe("Pathfinder Pioneers");
    expect(preferences.totalSquareFeet).toBe("600");
    expect(preferences.bathroomDays).toEqual([]);
    expect(preferences.trailers).toBeNull();
  });

  it("reads a total square footage stored as a number", () => {
    expect(readClubAssignmentPreferences({ total_sqft: 600 }).totalSquareFeet).toBe("600");
    expect(readClubAssignmentPreferences({ total_sqft: Number.NaN }).totalSquareFeet).toBeNull();
  });

  it("never invents an answer for a field that was never submitted", () => {
    const preferences = readClubAssignmentPreferences(null);
    expect(hasAnyClubAssignmentPreferences(preferences)).toBe(false);
  });
});

describe("clubAssignmentEmailBlock", () => {
  it("names only what staff actually set", () => {
    const block = clubAssignmentEmailBlock({
      ...emptyClubAssignmentFields,
      campsiteLocation: "Field C, site 12",
      dutyLabel: "Flag raising / lowering",
      dutyDay: "Friday",
      dutyTime: "morning",
    });
    expect(block).toContain("Campsite:** Field C, site 12");
    expect(block).toContain("Duty:** Flag raising / lowering — Friday morning");
    expect(block).not.toContain("Activity");
  });

  it("keeps each staff value on one list line and can't open a link or heading", () => {
    const block = clubAssignmentEmailBlock({
      ...emptyClubAssignmentFields,
      campsiteLocation: "Field C\n\n# Surprise heading",
      activityLabel: "Campfire [click here](https://example.test)",
      notes: "Line one\r\n- not a new item\n\nLine three",
    });
    const lines = block.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.startsWith("- **"))).toBe(true);
    expect(block).toContain("Campsite:** Field C # Surprise heading");
    expect(block).toContain("Activity:** Campfire click here(https://example.test)");
    expect(block).not.toMatch(/\[|\]/);
    expect(block).toContain("Notes:** Line one - not a new item Line three");
  });

  it("renders nothing for an unassigned club", () => {
    expect(clubAssignmentEmailBlock(emptyClubAssignmentFields)).toBe("");
  });
});
