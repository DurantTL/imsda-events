import { beforeEach, describe, expect, it, vi } from "vitest";

/** Monthly Records attendance (#653). Synthetic names and ids only. */

const mocks = vi.hoisted(() => ({
  writeAuditLog: vi.fn(),
  orgFindUnique: vi.fn(),
  noteFindUnique: vi.fn(),
  noteFindMany: vi.fn(),
  noteCreate: vi.fn(),
  noteUpdate: vi.fn(),
  rosterFindMany: vi.fn(),
  getCurrentAttendee: vi.fn(),
  listDirectedClubs: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
}));

const client = {
  organization: { findUnique: mocks.orgFindUnique },
  clubMeetingNote: {
    findUnique: mocks.noteFindUnique,
    findMany: mocks.noteFindMany,
    create: mocks.noteCreate,
    update: mocks.noteUpdate,
  },
  clubRosterMember: { findMany: mocks.rosterFindMany },
};

vi.mock("server-only", () => ({}));
vi.mock("@/modules/attendee-accounts/sign-in-gate", () => ({ accountNeedsSecondStep: async () => "OK" }));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => client }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: mocks.getCurrentAttendee }));
vi.mock("@/modules/organizations/staff-act-as", () => ({ currentStaffActingContext: async () => null }));
vi.mock("@/modules/organizations/director-access", () => ({ listDirectedClubs: mocks.listDirectedClubs }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));

import { GET as EXPORT } from "@/app/api/attendee/clubs/[organizationId]/exports/attendance/route";
import {
  attendanceExportCsv,
  attendanceGroupOf,
  attendanceMarkKey,
  countsFromAttendance,
  groupAttendanceRoster,
} from "@/modules/club-meeting-notes/attendance";
import { defaultMeetingDate, recordsMonth } from "@/modules/club-meeting-notes/domain";
import { createClubMeetingNote, updateClubMeetingNote } from "@/modules/club-meeting-notes/repository";
import { meetingNoteInputSchema } from "@/modules/club-meeting-notes/schemas";

const member = (id: string, attendeeType: string, classLevel: string | null, firstName: string, lastName: string) =>
  ({ id, attendeeType, classLevel, firstName, lastName });

const roster = [
  member("m-1", "YOUTH", "FRIEND", "Ana", "Zed"),
  member("m-2", "YOUTH", "TLT", "Ben", "Yarrow"),
  member("m-3", "STAFF", null, "Cy", "Xu"),
  member("m-4", "UNDERAGE", null, "Di", "Ames"),
  member("m-5", "ADULT", null, "Ed", "Bell"),
];

describe("attendance groups and derived counts", () => {
  it("puts TLTs in TLT, staff and adults in Staff, and everyone else in Pathfinders", () => {
    expect(roster.map(attendanceGroupOf)).toEqual(["PATHFINDER", "TLT", "STAFF", "PATHFINDER", "STAFF"]);
  });

  it("groups the roster by name within Pathfinders / TLT / Staff and leaves empty groups out", () => {
    const groups = groupAttendanceRoster(roster);
    expect(groups.map((group) => group.label)).toEqual(["Pathfinders", "TLT", "Staff"]);
    expect(groups[0].members.map((entry) => entry.lastName)).toEqual(["Ames", "Zed"]);
    expect(groupAttendanceRoster([roster[0]]).map((group) => group.label)).toEqual(["Pathfinders"]);
  });

  it("counts each present member once, in one group", () => {
    const counts = countsFromAttendance(roster.map((entry, index) => ({ ...entry, present: index !== 3 })));
    expect(counts).toEqual({ pathfinderCount: 1, tltCount: 1, staffCount: 2 });
    expect(countsFromAttendance(roster.map((entry) => ({ ...entry, present: false })))).toEqual({ pathfinderCount: 0, tltCount: 0, staffCount: 0 });
  });
});

describe("saving a meeting note with attendance", () => {
  const actor = { accountId: "account-1" };
  const stored = (data: Record<string, unknown>) => ({
    id: "note-1",
    organizationId: "club-1",
    honors: [],
    notes: "",
    attendance: [],
    createdAt: new Date("2026-10-07T15:00:00Z"),
    updatedAt: new Date("2026-10-07T15:00:00Z"),
    ...data,
  });
  const input = (overrides: Record<string, unknown> = {}) => meetingNoteInputSchema.parse({ meetingDate: "2026-10-07", ...overrides });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.orgFindUnique.mockResolvedValue({ type: "CLUB", name: "Test Pathfinders" });
    mocks.noteFindUnique.mockResolvedValue({ id: "note-1", organizationId: "club-1" });
    mocks.noteCreate.mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve(stored(data)));
    mocks.noteUpdate.mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve(stored(data)));
    mocks.rosterFindMany.mockImplementation(({ where }: { where: { id: { in: string[] } } }) =>
      Promise.resolve(roster.filter((entry) => where.id.in.includes(entry.id)).map(({ id, attendeeType, classLevel }) => ({ id, attendeeType, classLevel }))));
  });

  it("stores the check-off and fills blank head counts from it", async () => {
    await createClubMeetingNote("club-1", input({
      attendance: roster.map((entry) => ({ rosterMemberId: entry.id, present: entry.id !== "m-4" })),
    }), actor);
    const data = mocks.noteCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({ pathfinderCount: 1, tltCount: 1, staffCount: 2 });
    expect(data.attendance.create).toHaveLength(5);
    expect(data.attendance.create).toContainEqual({ rosterMemberId: "m-4", present: false });
    // The roster lookup is scoped to this club and the meeting's club year.
    expect(mocks.rosterFindMany.mock.calls[0][0].where).toMatchObject({ organizationId: "club-1", clubYear: "2026-27" });
    // The audit row carries a count, never a name.
    expect(JSON.stringify(mocks.writeAuditLog.mock.calls[0][0])).not.toContain("Zed");
    expect(mocks.writeAuditLog.mock.calls[0][0].metadata).toMatchObject({ attendanceRecorded: 5 });
  });

  it("keeps typed head counts over the derived ones", async () => {
    await createClubMeetingNote("club-1", input({
      pathfinderCount: 20,
      attendance: [{ rosterMemberId: "m-1", present: true }],
    }), actor);
    expect(mocks.noteCreate.mock.calls[0][0].data).toMatchObject({ pathfinderCount: 20, tltCount: 0, staffCount: 0 });
  });

  it("is optional: a note with no attendance saves as before and touches no check-off", async () => {
    await createClubMeetingNote("club-1", input({ pathfinderCount: 9 }), actor);
    const data = mocks.noteCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({ pathfinderCount: 9, tltCount: null, staffCount: null });
    expect(data).not.toHaveProperty("attendance");
    expect(mocks.rosterFindMany).not.toHaveBeenCalled();

    await updateClubMeetingNote("club-1", "note-1", input({ pathfinderCount: 9 }), actor);
    expect(mocks.noteUpdate.mock.calls[0][0].data).not.toHaveProperty("attendance");
  });

  it("replaces the check-off on edit, and an empty list clears it", async () => {
    await updateClubMeetingNote("club-1", "note-1", input({ attendance: [{ rosterMemberId: "m-1", present: true }] }), actor);
    expect(mocks.noteUpdate.mock.calls[0][0].data.attendance).toEqual({ deleteMany: {}, create: [{ rosterMemberId: "m-1", present: true }] });
    await updateClubMeetingNote("club-1", "note-1", input({ pathfinderCount: 3, attendance: [] }), actor);
    expect(mocks.noteUpdate.mock.calls[1][0].data.attendance).toEqual({ deleteMany: {}, create: [] });
    expect(mocks.noteUpdate.mock.calls[1][0].data.pathfinderCount).toBe(3);
  });

  it("refuses members who are not on this club's roster for the meeting's year, or repeated", async () => {
    mocks.rosterFindMany.mockResolvedValue([{ id: "m-1", attendeeType: "YOUTH", classLevel: null }]);
    await expect(createClubMeetingNote("club-1", input({
      attendance: [{ rosterMemberId: "m-1", present: true }, { rosterMemberId: "other-club-member", present: true }],
    }), actor)).rejects.toMatchObject({ code: "INVALID_ATTENDANCE" });
    await expect(createClubMeetingNote("club-1", input({
      attendance: [{ rosterMemberId: "m-1", present: true }, { rosterMemberId: "m-1", present: false }],
    }), actor)).rejects.toMatchObject({ code: "INVALID_ATTENDANCE" });
    expect(mocks.noteCreate).not.toHaveBeenCalled();
  });

  it("rejects unknown attendance fields", () => {
    expect(meetingNoteInputSchema.safeParse({ meetingDate: "2026-10-07", attendance: [{ rosterMemberId: "m-1", present: true, birthDate: "2015-01-01" }] }).success).toBe(false);
  });
});

describe("attendance export CSV", () => {
  const members = roster.map((entry) => ({ id: entry.id, firstName: entry.firstName, lastName: entry.lastName, group: attendanceGroupOf(entry) }));
  const meetings = [{ id: "n-2", meetingDate: "2026-10-14" }, { id: "n-1", meetingDate: "2026-10-07" }];
  const marks = new Map<string, boolean>([
    [attendanceMarkKey("n-1", "m-1"), true],
    [attendanceMarkKey("n-2", "m-1"), false],
    [attendanceMarkKey("n-1", "m-2"), true],
    [attendanceMarkKey("n-2", "m-2"), true],
    [attendanceMarkKey("n-1", "m-3"), true],
  ]);
  const csv = attendanceExportCsv({ clubName: "Test Pathfinders", clubYear: "2026-27" }, meetings, members, marks);
  const lines = csv.trim().split("\r\n");

  it("names the club and year, then one column per meeting in date order", () => {
    expect(lines[0]).toBe('"Club","Test Pathfinders"');
    expect(lines[1]).toBe('"Club year","2026-27"');
    expect(lines[3]).toBe('"Dates","Whole club year"');
    expect(lines[5]).toBe('"Last name","First name","Group","2026-10-07","2026-10-14","Meetings attended","Meetings recorded","Percent attended"');
  });

  it("marks Present / Absent with totals and percentage per member", () => {
    expect(lines).toContain('"Zed","Ana","Pathfinders","Present","Absent","1","2","50%"');
    expect(lines).toContain('"Yarrow","Ben","TLT","Present","Present","2","2","100%"');
    // Recorded at one meeting only: blank where nothing was recorded, percent over recorded meetings.
    expect(lines).toContain('"Xu","Cy","Staff","Present","","1","1","100%"');
    // Nothing recorded for this person at all: no percentage.
    expect(lines).toContain('"Ames","Di","Pathfinders","","","0","0",""');
  });

  it("ends with how many were present at each meeting", () => {
    expect(lines.at(-1)).toBe('"Total present","","","3","1","4","",""');
  });

  it("neutralises spreadsheet formulas in names", () => {
    const out = attendanceExportCsv(
      { clubName: "=HYPERLINK(\"x\")", clubYear: "2026-27", from: "2026-10-01", to: "2026-10-31" },
      [{ id: "n-1", meetingDate: "2026-10-07" }],
      [{ id: "m-1", firstName: "+Ana", lastName: "@Zed", group: "PATHFINDER" }],
      new Map([[attendanceMarkKey("n-1", "m-1"), true]]),
    );
    expect(out).toContain(`"'=HYPERLINK(""x"")"`);
    expect(out).toContain('"\'@Zed","\'+Ana"');
    expect(out).toContain('"Dates","2026-10-01 to 2026-10-31"');
  });

  it("says so when no meeting took attendance", () => {
    const out = attendanceExportCsv({ clubName: "Test Pathfinders", clubYear: "2026-27" }, [], members, new Map());
    expect(out).toContain("No meetings with attendance recorded");
  });
});

describe("attendance export route", () => {
  const ctx = { params: Promise.resolve({ organizationId: "club-1" }) };
  const request = (query = "") => new Request(`https://events.imsda.test/api/attendee/clubs/club-1/exports/attendance${query}`);
  const role = (value: string, organizationId = "club-1") =>
    mocks.listDirectedClubs.mockResolvedValue([{ organizationId, name: "Test Pathfinders", role: value, sponsoringChurch: null }]);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentAttendee.mockResolvedValue({ account: { id: "account-1", verifiedEmail: "r@example.test", displayName: "R" }, via: "attendee", sessionId: "s-1" });
    mocks.orgFindUnique.mockResolvedValue({ name: "Test Pathfinders" });
    mocks.noteFindMany.mockResolvedValue([
      { id: "n-1", meetingDate: "2026-10-07", attendance: [{ rosterMemberId: "m-1", present: true }] },
    ]);
    mocks.rosterFindMany.mockResolvedValue([{ id: "m-1", attendeeType: "YOUTH", classLevel: null, person: { firstName: "Ana", lastName: "Zed" } }]);
  });

  it("downloads the CSV for a reporter, as an attachment, with an audit row that has no names", async () => {
    role("REPORTER");
    const response = await EXPORT(request("?year=2026-27"), ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/csv");
    expect(response.headers.get("Content-Disposition")).toContain("meeting-attendance-2026-27.csv");
    const body = await response.text();
    expect(body).toContain('"Club","Test Pathfinders"');
    expect(body).toContain('"Zed","Ana","Pathfinders","Present","1","1","100%"');
    expect(mocks.writeAuditLog).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.writeAuditLog.mock.calls[0][0])).not.toContain("Zed");
    // Scoped to the club.
    expect(mocks.noteFindMany.mock.calls[0][0].where).toMatchObject({ organizationId: "club-1" });
  });

  it("keeps a registrar out, like the report", async () => {
    role("REGISTRAR");
    expect((await EXPORT(request(), ctx)).status).toBe(403);
    expect(mocks.noteFindMany).not.toHaveBeenCalled();
  });

  it("refuses another club's director", async () => {
    role("DIRECTOR", "club-2");
    expect((await EXPORT(request(), ctx)).status).toBe(404);
    expect(mocks.noteFindMany).not.toHaveBeenCalled();
  });

  it("applies a date range and rejects a bad one", async () => {
    role("DIRECTOR");
    expect((await EXPORT(request("?from=2026-10-01&to=2026-10-31"), ctx)).status).toBe(200);
    expect(mocks.noteFindMany.mock.calls[0][0].where.meetingDate).toEqual({ gte: "2026-10-01", lte: "2026-10-31" });
    expect((await EXPORT(request("?from=2026-02-31"), ctx)).status).toBe(400);
    expect((await EXPORT(request("?from=2026-11-01&to=2026-10-01"), ctx)).status).toBe(400);
  });
});

describe("Monthly Records month handling", () => {
  const now = new Date("2026-10-20T15:00:00Z");

  it("opens on this month unless a real past month is asked for (an old report link)", () => {
    expect(recordsMonth(undefined, now)).toBe("2026-10");
    expect(recordsMonth("2026-09", now)).toBe("2026-09");
    expect(recordsMonth("2026-12", now)).toBe("2026-10");
    expect(recordsMonth("nonsense", now)).toBe("2026-10");
    expect(recordsMonth(["2026-09"], now)).toBe("2026-10");
  });

  it("starts a new meeting today when viewing this month, else on the 1st", () => {
    expect(defaultMeetingDate("2026-10", now)).toBe("2026-10-20");
    expect(defaultMeetingDate("2026-09", now)).toBe("2026-09-01");
  });
});
