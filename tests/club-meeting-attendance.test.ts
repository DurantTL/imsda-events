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
  mfaEnrollment: vi.fn(),
  sessionFind: vi.fn(),
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
  attendeeMfaEnrollment: { findUnique: mocks.mfaEnrollment },
  attendeePasskey: { count: async () => 0 },
  attendeeSession: { findUnique: mocks.sessionFind },
};

vi.mock("server-only", () => ({}));
vi.mock("@/modules/attendee-accounts/sign-in-gate", () => ({ accountNeedsSecondStep: async () => "OK" }));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => client }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/attendee-accounts/passkeys", () => ({ passkeysConfigured: async () => false }));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: mocks.getCurrentAttendee }));
vi.mock("@/modules/organizations/staff-act-as", () => ({ currentStaffActingContext: async () => null }));
vi.mock("@/modules/organizations/director-access", () => ({ listDirectedClubs: mocks.listDirectedClubs }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));

import { PUT as PUT_NOTE } from "@/app/api/attendee/clubs/[organizationId]/notes/[noteId]/route";
import { POST as POST_NOTE } from "@/app/api/attendee/clubs/[organizationId]/notes/route";
import { GET as EXPORT } from "@/app/api/attendee/clubs/[organizationId]/exports/attendance/route";
import {
  attendanceExportCsv,
  attendanceGroupOf,
  attendanceMarkKey,
  countsFromAttendance,
  countsToSend,
  presentTotal,
  groupAttendanceRoster,
} from "@/modules/club-meeting-notes/attendance";
import { defaultMeetingDate, meetingAttendanceTotal, notesMonthlySummary, recordsMonth } from "@/modules/club-meeting-notes/domain";
import { eraseRosterRow } from "@/modules/club-rosters/repository";
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

  it("counts a present youth TLT as a Pathfinder and a TLT, like the roster prefill", () => {
    const counts = countsFromAttendance(roster.map((entry, index) => ({ ...entry, present: index !== 3 })));
    // Ana (youth) and Ben (youth TLT) are Pathfinders; Di (underage) is absent; Cy and Ed are staff.
    expect(counts).toEqual({ pathfinderCount: 2, tltCount: 1, staffCount: 2 });
    expect(presentTotal(roster.map((entry, index) => ({ present: index !== 3 })))).toBe(4);
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
    mocks.noteFindUnique.mockResolvedValue({ id: "note-1", organizationId: "club-1", meetingDate: "2026-10-07", attendance: [] });
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
    expect(data).toMatchObject({ pathfinderCount: 2, tltCount: 1, staffCount: 2 });
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

  it("merges a partial edit into the marks already on the meeting, and an empty list clears them", async () => {
    mocks.noteFindUnique.mockResolvedValue({
      id: "note-1", organizationId: "club-1", meetingDate: "2026-10-07",
      attendance: [{ rosterMemberId: "m-1", present: true }, { rosterMemberId: "m-3", present: true }],
    });
    await updateClubMeetingNote("club-1", "note-1", input({ attendance: [{ rosterMemberId: "m-2", present: true }] }), actor);
    const data = mocks.noteUpdate.mock.calls[0][0].data;
    // Only the listed member is written; m-1 and m-3 keep their marks (no deleteMany).
    expect(data.attendance).not.toHaveProperty("deleteMany");
    expect(data.attendance.upsert).toHaveLength(1);
    expect(data.attendance.upsert[0]).toMatchObject({ create: { rosterMemberId: "m-2", present: true }, update: { present: true } });
    // Counts derive over the merged marks: m-1 pathfinder, m-2 TLT, m-3 staff.
    // Youth TLT m-2 is a Pathfinder and a TLT.
    expect(data).toMatchObject({ pathfinderCount: 2, tltCount: 1, staffCount: 1 });

    await updateClubMeetingNote("club-1", "note-1", input({ pathfinderCount: 3, attendance: [] }), actor);
    expect(mocks.noteUpdate.mock.calls[1][0].data.attendance).toEqual({ deleteMany: {} });
    expect(mocks.noteUpdate.mock.calls[1][0].data.pathfinderCount).toBe(3);
  });

  it("clears the check-off when an edit moves the meeting into another club year and sends none", async () => {
    mocks.noteFindUnique.mockResolvedValue({
      id: "note-1", organizationId: "club-1", meetingDate: "2026-10-07", attendance: [{ rosterMemberId: "m-1", present: true }],
    });
    await updateClubMeetingNote("club-1", "note-1", input({ meetingDate: "2027-09-15" }), actor);
    expect(mocks.noteUpdate.mock.calls[0][0].data.attendance).toEqual({ deleteMany: {} });
    // Within the same club year it is left alone.
    await updateClubMeetingNote("club-1", "note-1", input({ meetingDate: "2026-11-04" }), actor);
    expect(mocks.noteUpdate.mock.calls[1][0].data).not.toHaveProperty("attendance");
  });

  it("starts over, without keeping old marks, when a moved meeting is sent a new check-off", async () => {
    mocks.noteFindUnique.mockResolvedValue({
      id: "note-1", organizationId: "club-1", meetingDate: "2026-10-07", attendance: [{ rosterMemberId: "m-1", present: true }],
    });
    await updateClubMeetingNote("club-1", "note-1", input({ meetingDate: "2027-09-15", attendance: [{ rosterMemberId: "m-3", present: true }] }), actor);
    expect(mocks.noteUpdate.mock.calls[0][0].data.attendance).toEqual({ deleteMany: {}, create: [{ rosterMemberId: "m-3", present: true }] });
  });

  it("fills counts from the merged marks, including a member the editor's roster doesn't list, and zero when all are absent", async () => {
    // m-3 (staff) has a mark but, say, is inactive so the editor never listed them.
    mocks.noteFindUnique.mockResolvedValue({
      id: "note-1", organizationId: "club-1", meetingDate: "2026-10-07", attendance: [{ rosterMemberId: "m-3", present: true }],
    });
    await updateClubMeetingNote("club-1", "note-1", input({
      attendance: [{ rosterMemberId: "m-1", present: true }, { rosterMemberId: "m-2", present: false }],
    }), actor);
    expect(mocks.noteUpdate.mock.calls[0][0].data).toMatchObject({ pathfinderCount: 1, tltCount: 0, staffCount: 1 });

    mocks.noteFindUnique.mockResolvedValue({ id: "note-1", organizationId: "club-1", meetingDate: "2026-10-07", attendance: [] });
    await updateClubMeetingNote("club-1", "note-1", input({ attendance: [{ rosterMemberId: "m-1", present: false }] }), actor);
    expect(mocks.noteUpdate.mock.calls[1][0].data).toMatchObject({ pathfinderCount: 0, tltCount: 0, staffCount: 0 });
  });

  it("only accepts named members who haven't been removed from the roster", async () => {
    await createClubMeetingNote("club-1", input({ attendance: [{ rosterMemberId: "m-1", present: true }] }), actor);
    expect(mocks.rosterFindMany.mock.calls[0][0].where).toMatchObject({ status: { not: "REMOVED" }, personId: { not: null } });
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

describe("attendance needs roster access (ADR 0005)", () => {
  const ctx = { params: Promise.resolve({ organizationId: "club-1" }) };
  const noteCtx = { params: Promise.resolve({ organizationId: "club-1", noteId: "note-1" }) };
  const request = (query = "") => new Request(`https://events.imsda.test/api/attendee/clubs/club-1/exports/attendance${query}`);
  const role = (value: string, organizationId = "club-1") =>
    mocks.listDirectedClubs.mockResolvedValue([{ organizationId, name: "Test Pathfinders", role: value, sponsoringChurch: null }]);
  const body = (extra: Record<string, unknown>) => JSON.stringify({ meetingDate: "2026-10-07", pathfinderCount: 10, ...extra });
  const write = (method: string, extra: Record<string, unknown>) => new Request("https://events.imsda.test/api/attendee/clubs/club-1/notes", {
    method, headers: { origin: "https://events.imsda.test", "content-type": "application/json" }, body: body(extra),
  });
  const check = [{ rosterMemberId: "m-1", present: true }];

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rejectCrossOriginRequest.mockReturnValue(null);
    mocks.getCurrentAttendee.mockResolvedValue({ account: { id: "account-1", verifiedEmail: "r@example.test", displayName: "R" }, via: "attendee", sessionId: "s-1" });
    // MFA enrolled and the roster unlocked just now.
    mocks.mfaEnrollment.mockResolvedValue({ status: "ACTIVE" });
    mocks.sessionFind.mockResolvedValue({ secondFactorVerifiedAt: new Date() });
    mocks.orgFindUnique.mockResolvedValue({ type: "CLUB", name: "Test Pathfinders" });
    mocks.noteFindUnique.mockResolvedValue({ id: "note-1", organizationId: "club-1", meetingDate: "2026-10-07", attendance: [] });
    mocks.noteCreate.mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: "note-1", organizationId: "club-1", honors: [], notes: "", attendance: [], createdAt: new Date(), updatedAt: new Date(), meetingDate: "2026-10-07", ...data }));
    mocks.noteUpdate.mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: "note-1", organizationId: "club-1", honors: [], notes: "", attendance: [], createdAt: new Date(), updatedAt: new Date(), meetingDate: "2026-10-07", ...data }));
    mocks.noteFindMany.mockResolvedValue([
      { id: "n-1", meetingDate: "2026-10-07", attendance: [{ rosterMemberId: "m-1", present: true }] },
    ]);
    mocks.rosterFindMany.mockImplementation((args: { where: { id?: { in: string[] } } }) =>
      Promise.resolve(args.where.id
        ? args.where.id.in.map((id) => ({ id, attendeeType: "YOUTH", classLevel: null, person: { firstName: "Ana", lastName: "Zed" } }))
        : [{ id: "m-1", attendeeType: "YOUTH", classLevel: null, person: { firstName: "Ana", lastName: "Zed" } }]));
  });

  it("rejects a reporter's attendance on save (403) but still saves their head counts", async () => {
    role("REPORTER");
    expect((await POST_NOTE(write("POST", { attendance: check }), ctx)).status).toBe(403);
    expect((await PUT_NOTE(write("PUT", { attendance: check }), noteCtx)).status).toBe(403);
    expect((await PUT_NOTE(write("PUT", { attendance: [] }), noteCtx)).status).toBe(403);
    expect(mocks.noteCreate).not.toHaveBeenCalled();
    expect(mocks.noteUpdate).not.toHaveBeenCalled();
    expect((await POST_NOTE(write("POST", {}), ctx)).status).toBe(201);
    expect((await PUT_NOTE(write("PUT", {}), noteCtx)).status).toBe(200);
  });

  it("rejects attendance once the roster unlock has expired, and allows it for a director with roster access", async () => {
    role("DIRECTOR");
    mocks.sessionFind.mockResolvedValue({ secondFactorVerifiedAt: new Date(Date.now() - 13 * 3_600_000) });
    expect((await POST_NOTE(write("POST", { attendance: check }), ctx)).status).toBe(403);
    mocks.sessionFind.mockResolvedValue({ secondFactorVerifiedAt: new Date() });
    expect((await POST_NOTE(write("POST", { attendance: check }), ctx)).status).toBe(201);
  });

  it("keeps a reporter from wiping marks by moving a meeting into another club year", async () => {
    role("REPORTER");
    mocks.noteFindUnique.mockResolvedValue({ id: "note-1", organizationId: "club-1", meetingDate: "2026-10-07", attendance: [{ rosterMemberId: "m-1", present: true }] });
    expect((await PUT_NOTE(write("PUT", { meetingDate: "2027-09-15" }), noteCtx)).status).toBe(403);
    expect(mocks.noteUpdate).not.toHaveBeenCalled();
    // Same club year, or a note with no marks, is an ordinary head-count edit.
    expect((await PUT_NOTE(write("PUT", { meetingDate: "2026-11-04" }), noteCtx)).status).toBe(200);
    mocks.noteFindUnique.mockResolvedValue({ id: "note-1", organizationId: "club-1", meetingDate: "2026-10-07", attendance: [] });
    expect((await PUT_NOTE(write("PUT", { meetingDate: "2027-09-15" }), noteCtx)).status).toBe(200);
    // A director with an open roster may move it.
    role("DIRECTOR");
    mocks.noteFindUnique.mockResolvedValue({ id: "note-1", organizationId: "club-1", meetingDate: "2026-10-07", attendance: [{ rosterMemberId: "m-1", present: true }] });
    expect((await PUT_NOTE(write("PUT", { meetingDate: "2027-09-15" }), noteCtx)).status).toBe(200);
  });

  it("downloads the CSV for a director with roster access, with an audit row that has no names", async () => {
    role("DIRECTOR");
    const response = await EXPORT(request("?year=2026-27"), ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/csv");
    expect(response.headers.get("Content-Disposition")).toContain("meeting-attendance-2026-27.csv");
    const csv = await response.text();
    expect(csv).toContain('"Club","Test Pathfinders"');
    expect(csv).toContain('"Zed","Ana","Pathfinders","Present","1","1","100%"');
    expect(mocks.writeAuditLog).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.writeAuditLog.mock.calls[0][0])).not.toContain("Zed");
    expect(mocks.noteFindMany.mock.calls[0][0].where).toMatchObject({ organizationId: "club-1" });
  });

  it("lets a registrar, who has the roster, download it", async () => {
    role("REGISTRAR");
    expect((await EXPORT(request(), ctx)).status).toBe(200);
  });

  it("keeps a reporter out of the export (403)", async () => {
    role("REPORTER");
    expect((await EXPORT(request(), ctx)).status).toBe(403);
    expect(mocks.noteFindMany).not.toHaveBeenCalled();
  });

  it("refuses another club's director", async () => {
    role("DIRECTOR", "club-2");
    expect((await EXPORT(request(), ctx)).status).toBe(404);
    expect(mocks.noteFindMany).not.toHaveBeenCalled();
  });

  it("applies a date range, rejects a bad one, and leaves out removed members' extras", async () => {
    role("DIRECTOR");
    mocks.noteFindMany.mockResolvedValue([{ id: "n-1", meetingDate: "2026-10-07", attendance: [{ rosterMemberId: "m-9", present: true }] }]);
    expect((await EXPORT(request("?from=2026-10-01&to=2026-10-31"), ctx)).status).toBe(200);
    expect(mocks.noteFindMany.mock.calls[0][0].where.meetingDate).toEqual({ gte: "2026-10-01", lte: "2026-10-31" });
    const extras = mocks.rosterFindMany.mock.calls.find(([args]) => args.where.id)?.[0];
    expect(extras.where.status).toEqual({ not: "REMOVED" });
    expect((await EXPORT(request("?from=2026-02-31"), ctx)).status).toBe(400);
    expect((await EXPORT(request("?from=2026-11-01&to=2026-10-01"), ctx)).status).toBe(400);
  });
});

describe("TLTs are inside Pathfinders (director decision)", () => {
  const youth = (id: string, classLevel: string | null) => ({ id, attendeeType: "YOUTH", classLevel, present: true });
  const tenPlusTwo = [
    ...Array.from({ length: 10 }, (_, i) => youth(`y-${i}`, "FRIEND")),
    youth("t-1", "TLT"),
    youth("t-2", "TLT"),
  ];

  it("10 youth + 2 youth TLTs all present: Pathfinders 12, TLT 2, and an average total of 12", () => {
    const counts = countsFromAttendance(tenPlusTwo);
    expect(counts).toEqual({ pathfinderCount: 12, tltCount: 2, staffCount: 0 });
    const summary = notesMonthlySummary([{ ...counts, presentPeople: presentTotal(tenPlusTwo), honors: [] }]);
    expect(summary?.averageAttendance).toBe(12);
  });

  it("totals typed-only meetings as Pathfinders + staff without double-counting TLTs", () => {
    expect(meetingAttendanceTotal({ pathfinderCount: 12, tltCount: 2, staffCount: 3 })).toBe(15);
    expect(meetingAttendanceTotal({ pathfinderCount: null, tltCount: 2, staffCount: 3 })).toBe(5);
    expect(meetingAttendanceTotal({ pathfinderCount: null, tltCount: null, staffCount: null })).toBeNull();
    // A check-off's distinct-people count wins over the overlapping typed counts.
    expect(meetingAttendanceTotal({ pathfinderCount: 12, tltCount: 2, staffCount: 3, presentPeople: 14 })).toBe(14);
  });

  it("a report prefilled from check-offs matches the roster prefill for the same people", () => {
    // reportPrefill's rule, applied to the same roster (modules/club-reports/repository.ts).
    const rosterPrefill = (members: Array<{ attendeeType: string; classLevel: string | null }>) => ({
      pathfinderCount: members.filter((m) => m.attendeeType === "YOUTH" || m.attendeeType === "UNDERAGE").length,
      tltCount: members.filter((m) => m.classLevel === "TLT").length,
      staffCount: members.filter((m) => m.attendeeType === "STAFF" || m.attendeeType === "ADULT").length,
    });
    const everyone = [...tenPlusTwo, { id: "s-1", attendeeType: "STAFF", classLevel: null, present: true }, { id: "a-1", attendeeType: "ADULT", classLevel: "TLT", present: true }, { id: "u-1", attendeeType: "UNDERAGE", classLevel: null, present: true }];
    const counts = countsFromAttendance(everyone);
    expect(counts).toEqual(rosterPrefill(everyone));
    const summary = notesMonthlySummary([{ ...counts, presentPeople: presentTotal(everyone), honors: [] }]);
    expect(summary).toMatchObject({ ...rosterPrefill(everyone), averageAttendance: 15 });
  });
});

describe("counts the editor leaves for the server to fill", () => {
  const derived = { pathfinderCount: 4, tltCount: 1, staffCount: 2 };
  it("sends blank for a count still equal to the editor's own, and keeps what the director changed", () => {
    expect(countsToSend({ pathfinderCount: "4", tltCount: "1", staffCount: "2" }, derived)).toEqual({ pathfinderCount: null, tltCount: null, staffCount: null });
    expect(countsToSend({ pathfinderCount: "5", tltCount: "", staffCount: "2" }, derived)).toEqual({ pathfinderCount: 5, tltCount: null, staffCount: null });
  });
});

describe("erasing a roster member (#653)", () => {
  it("deletes that member's meeting attendance rows", async () => {
    const tx = { clubMeetingAttendance: { deleteMany: vi.fn() }, clubRosterMember: { update: vi.fn() } };
    await eraseRosterRow(tx as never, "m-1", new Date("2026-10-20T15:00:00Z"));
    expect(tx.clubMeetingAttendance.deleteMany).toHaveBeenCalledWith({ where: { rosterMemberId: "m-1" } });
    expect(tx.clubRosterMember.update.mock.calls[0][0].data).toMatchObject({ status: "REMOVED", personId: null });
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
