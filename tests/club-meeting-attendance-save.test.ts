import { describe, expect, it } from "vitest";
import { attendanceForSave } from "@/modules/club-meeting-notes/attendance-save";

/** What a meeting-note save sends for the optional check-off (#653, #810). Synthetic ids only. */

const roster = [{ id: "m1" }, { id: "m2" }];
const base = { available: true, touched: true, on: true, rosterMatchesDate: true, hadAttendance: false, roster, present: { m1: true } };

describe("attendanceForSave", () => {
  it("sends every roster member with their mark when the check-off is on and touched", () => {
    expect(attendanceForSave(base)).toEqual({ attendance: [{ rosterMemberId: "m1", present: true }, { rosterMemberId: "m2", present: false }] });
  });

  it("leaves the check-off alone when it was not touched or is unavailable", () => {
    expect(attendanceForSave({ ...base, touched: false })).toEqual({});
    expect(attendanceForSave({ ...base, available: false })).toEqual({});
  });

  it("clears a check-off that is on file when attendance is skipped", () => {
    expect(attendanceForSave({ ...base, on: false, hadAttendance: true })).toEqual({ attendance: [] });
    expect(attendanceForSave({ ...base, on: false, hadAttendance: false })).toEqual({});
  });

  it("clears from the saved note's own flag, so a note dated outside the viewed month still clears", () => {
    // The month's list no longer holds that note after a refresh; the flag came from the save response.
    const outsideMonth = { ...base, on: false, rosterMatchesDate: false, hadAttendance: true };
    expect(attendanceForSave(outsideMonth)).toEqual({ attendance: [] });
  });

  it("sends nothing for a date the roster's club year does not cover", () => {
    expect(attendanceForSave({ ...base, rosterMatchesDate: false })).toEqual({});
  });
});
