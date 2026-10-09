import { describe, expect, it } from "vitest";
import {
  GROUP_REGISTRATION_CLUB_LABEL,
  INSTRUCTOR_EDIT_GRACE_DAYS,
  INSTRUCTOR_ROSTER_ROW_KEYS,
  STERLING_REQUIRED_MESSAGE,
  applyBulkMark,
  applyPersonMark,
  instructorEditDeadline,
  instructorInviteEmail,
  instructorMarksOpen,
  instructorMarksStarted,
  instructorStatus,
  markChangeIsLocked,
  normalizeMark,
  resendAvailableAt,
  EMAIL_BELONGS_TO_OTHER_MESSAGE,
  ROSTER_CLOSED_MESSAGE,
  sortInstructorRoster,
  sterlingAllowsRoster,
  toInstructorRosterRow,
} from "@/modules/honors/instructor-domain";

describe("instructor edit window (#833)", () => {
  const endsAt = new Date("2026-10-11T23:00:00Z");

  it("is 14 days after the event ends, inclusive", () => {
    expect(INSTRUCTOR_EDIT_GRACE_DAYS).toBe(14);
    expect(instructorEditDeadline(endsAt).toISOString()).toBe("2026-10-25T23:00:00.000Z");
    expect(instructorMarksOpen(endsAt, new Date("2026-10-11T12:00:00Z"))).toBe(true);
    expect(instructorMarksOpen(endsAt, new Date("2026-10-25T23:00:00Z"))).toBe(true);
    expect(instructorMarksOpen(endsAt, new Date("2026-10-25T23:00:01Z"))).toBe(false);
  });
});

describe("marks open on the event's start (#833)", () => {
  it("opens exactly at the start", () => {
    const startsAt = new Date("2026-10-09T15:00:00Z");
    expect(instructorMarksStarted(startsAt, new Date("2026-10-09T14:59:59Z"))).toBe(false);
    expect(instructorMarksStarted(startsAt, startsAt)).toBe(true);
  });
});

describe("Sterling Volunteers gate (#833)", () => {
  it("lets only a current check see a roster", () => {
    expect(sterlingAllowsRoster("CURRENT")).toBe(true);
    for (const state of ["EXPIRED", "MISSING", "NOT_COMPLIANT", "FLAGGED"] as const) expect(sterlingAllowsRoster(state)).toBe(false);
  });

  it("says Sterling Volunteers, never the old wording", () => {
    expect(STERLING_REQUIRED_MESSAGE).toContain("Sterling Volunteers check");
    expect(STERLING_REQUIRED_MESSAGE.toLowerCase()).not.toContain("background");
  });
});

describe("resend cooldown and messages (#833)", () => {
  it("allows a resend only after the cooldown from the last send", () => {
    const sent = new Date("2026-10-09T12:00:00Z");
    expect(resendAvailableAt(null, 5)).toBeNull();
    expect(resendAvailableAt(sent, 5)?.toISOString()).toBe("2026-10-09T12:05:00.000Z");
  });

  it("has clear staff and instructor messages", () => {
    expect(ROSTER_CLOSED_MESSAGE).toBe("This class roster has closed.");
    expect(EMAIL_BELONGS_TO_OTHER_MESSAGE).toContain("different person");
  });
});

describe("what an instructor sees of a person (#833)", () => {
  it("is exactly name, club and the marks, whatever the source carries", () => {
    const row = toInstructorRosterRow({
      enrollmentId: "enr-1",
      firstName: "Ada",
      lastName: "Sample",
      clubName: "Sample Pathfinders",
      mark: null,
      links: [],
      // Extra source fields must not travel: the builder takes the allowlist only.
      ...({ email: "x@example.test", birthDate: "2012-01-01", guardian: "G", health: "H", profileSnapshot: {} } as object),
    } as Parameters<typeof toInstructorRosterRow>[0]);
    expect(Object.keys(row).sort()).toEqual([...INSTRUCTOR_ROSTER_ROW_KEYS].sort());
    expect(row).toEqual({
      enrollmentId: "enr-1", firstName: "Ada", lastName: "Sample", clubName: "Sample Pathfinders",
      attended: false, completed: false, recorded: false, recordedVoided: false,
    });
  });

  it("names a group registration by a label, never a person", () => {
    const row = toInstructorRosterRow({ enrollmentId: "e", firstName: "B", lastName: "C", clubName: null, mark: null, links: [] });
    expect(row.clubName).toBe(GROUP_REGISTRATION_CLUB_LABEL);
  });

  it("reports recorded and voided completions", () => {
    const base = { enrollmentId: "e", firstName: "B", lastName: "C", clubName: "K", mark: { attended: true, completed: true } };
    expect(toInstructorRosterRow({ ...base, links: [{ voided: false }] })).toMatchObject({ recorded: true, recordedVoided: false });
    expect(toInstructorRosterRow({ ...base, links: [{ voided: true }, { voided: false }] })).toMatchObject({ recorded: true, recordedVoided: false });
    expect(toInstructorRosterRow({ ...base, links: [{ voided: true }] })).toMatchObject({ recorded: true, recordedVoided: true });
  });

  it("sorts by last name, first name, then club", () => {
    const make = (lastName: string, firstName: string, clubName: string) => toInstructorRosterRow({ enrollmentId: `${lastName}${firstName}${clubName}`, firstName, lastName, clubName, mark: null, links: [] });
    const sorted = sortInstructorRoster([make("Zed", "A", "K"), make("Able", "B", "K"), make("Able", "A", "Z"), make("Able", "A", "K")]);
    expect(sorted.map((row) => `${row.lastName} ${row.firstName} ${row.clubName}`)).toEqual(["Able A K", "Able A Z", "Able B K", "Zed A K"]);
  });
});

describe("marks (#833)", () => {
  it("completed always includes attended", () => {
    expect(normalizeMark({ attended: false, completed: true })).toEqual({ attended: true, completed: true });
    expect(applyPersonMark({ attended: false, completed: false }, { completed: true })).toEqual({ attended: true, completed: true });
  });

  it("taking attended away takes completed away", () => {
    expect(applyPersonMark({ attended: true, completed: true }, { attended: false })).toEqual({ attended: false, completed: false });
  });

  it("un-completing keeps attended", () => {
    expect(applyPersonMark({ attended: true, completed: true }, { completed: false })).toEqual({ attended: true, completed: false });
  });

  it("one-click actions", () => {
    expect(applyBulkMark("ALL_COMPLETED", { attended: false, completed: false })).toEqual({ attended: true, completed: true });
    expect(applyBulkMark("ALL_ATTENDED", { attended: false, completed: false })).toEqual({ attended: true, completed: false });
    // "All attended" does not undo a completion already marked.
    expect(applyBulkMark("ALL_ATTENDED", { attended: true, completed: true })).toEqual({ attended: true, completed: true });
    expect(applyBulkMark("CLEAR", { attended: true, completed: true })).toBeNull();
  });

  it("a completion already in the honor record cannot be taken back by an instructor", () => {
    const recorded = { recorded: true, completed: true };
    expect(markChangeIsLocked(recorded, null)).toBe(true);
    expect(markChangeIsLocked(recorded, { attended: true, completed: false })).toBe(true);
    expect(markChangeIsLocked(recorded, { attended: true, completed: true })).toBe(false);
    expect(markChangeIsLocked({ recorded: false, completed: true }, null)).toBe(false);
    expect(markChangeIsLocked({ recorded: true, completed: false }, null)).toBe(false);
  });
});

describe("invites (#833)", () => {
  it("names the event and classes, carries no secret, and uses the Sterling Volunteers wording", () => {
    const content = instructorInviteEmail({
      name: "Ada Sample", email: "ada@example.test", eventName: "Sample Honors Weekend", classNames: ["Knots", "Birds"],
      signUpUrl: "https://events.example.test/account/sign-up", signInUrl: "https://events.example.test/account/sign-in",
    });
    expect(content.subject).toContain("Sample Honors Weekend");
    expect(content.bodyText).toContain("- Knots");
    expect(content.bodyText).toContain("- Birds");
    expect(content.bodyText).toContain("ada@example.test");
    expect(content.bodyText).toContain("Sterling Volunteers check");
    expect(content.bodyText.toLowerCase()).not.toContain("background check");
    expect(content.bodyText).not.toMatch(/token|secret|\?code=/i);
  });

  it("reads status from the accepted and removed dates", () => {
    expect(instructorStatus({ acceptedAt: null, revokedAt: null })).toBe("INVITED");
    expect(instructorStatus({ acceptedAt: new Date(), revokedAt: null })).toBe("ACCEPTED");
    expect(instructorStatus({ acceptedAt: new Date(), revokedAt: new Date() })).toBe("REMOVED");
  });
});
