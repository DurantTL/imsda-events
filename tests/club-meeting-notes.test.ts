import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  writeAuditLog: vi.fn(),
  orgFindUnique: vi.fn(),
  noteFindUnique: vi.fn(),
  noteFindMany: vi.fn(),
  noteCreate: vi.fn(),
  noteUpdate: vi.fn(),
  noteDelete: vi.fn(),
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
    delete: mocks.noteDelete,
  },
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => client }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: mocks.getCurrentAttendee }));
vi.mock("@/modules/organizations/director-access", () => ({ listDirectedClubs: mocks.listDirectedClubs }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));

import { DELETE, PUT } from "@/app/api/attendee/clubs/[organizationId]/notes/[noteId]/route";
import { GET, POST } from "@/app/api/attendee/clubs/[organizationId]/notes/route";
import { notesMonthlySummary } from "@/modules/club-meeting-notes/domain";
import {
  createClubMeetingNote,
  deleteClubMeetingNote,
  monthlyNotesSummary,
  updateClubMeetingNote,
} from "@/modules/club-meeting-notes/repository";
import { meetingNoteInputSchema } from "@/modules/club-meeting-notes/schemas";

const noteInput = (overrides: Record<string, unknown> = {}) => meetingNoteInputSchema.parse({
  meetingDate: "2026-10-07",
  pathfinderCount: 12,
  tltCount: 3,
  staffCount: 4,
  honors: [{ name: "Knot Tying", participants: 8 }],
  notes: "Great turnout this week.",
  ...overrides,
});

const storedNote = (data: Record<string, unknown> = {}) => ({
  id: "note-1",
  organizationId: "club-1",
  meetingDate: "2026-10-07",
  pathfinderCount: 12,
  tltCount: 3,
  staffCount: 4,
  honors: [],
  notes: "",
  createdAt: new Date("2026-10-07T15:00:00Z"),
  updatedAt: new Date("2026-10-07T15:00:00Z"),
  ...data,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.orgFindUnique.mockResolvedValue({ type: "CLUB", name: "Test Pathfinders" });
  mocks.noteFindUnique.mockResolvedValue({ id: "note-1", organizationId: "club-1" });
  mocks.noteFindMany.mockResolvedValue([]);
  mocks.noteCreate.mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve(storedNote(data)));
  mocks.noteUpdate.mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve(storedNote(data)));
  mocks.noteDelete.mockResolvedValue(undefined);
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.getCurrentAttendee.mockResolvedValue({ account: { id: "account-1", verifiedEmail: "r@example.test", displayName: "R" }, via: "attendee", sessionId: "s-1" });
});

describe("no names, counts only — averaging a month's meeting notes (#426)", () => {
  it("prefills nothing for a month with no notes", () => {
    expect(notesMonthlySummary([])).toBeNull();
  });

  it("averages attendance and each count, rounded, over the meetings that recorded it", () => {
    const summary = notesMonthlySummary([
      { pathfinderCount: 10, tltCount: 2, staffCount: 3, honors: [] },
      { pathfinderCount: 13, tltCount: 3, staffCount: 4, honors: [] },
      { pathfinderCount: null, tltCount: null, staffCount: null, honors: [] },
    ]);
    // Pathfinder average: (10+13)/2 = 11.5 -> 12. TLT: 2.5 -> 3 (round half up). Staff: 3.5 -> 4.
    expect(summary).toMatchObject({ pathfinderCount: 12, tltCount: 3, staffCount: 4 });
    // Attendance per meeting: 15 and 20 -> average 17.5 -> 18. The count-free meeting is excluded.
    expect(summary?.averageAttendance).toBe(18);
  });

  it("dedupes honors by name, keeping the highest recorded participant count, and leaves it for the director when none was recorded", () => {
    const summary = notesMonthlySummary([
      { pathfinderCount: null, tltCount: null, staffCount: null, honors: [{ name: "Knot Tying", participants: 5 }, { name: "First Aid", participants: null }] },
      { pathfinderCount: null, tltCount: null, staffCount: null, honors: [{ name: "Knot Tying", participants: 9 }, { name: "  ", participants: 2 }] },
    ]);
    expect(summary?.honors).toEqual(expect.arrayContaining([
      { name: "Knot Tying", participants: 9 },
      { name: "First Aid", participants: null },
    ]));
    expect(summary?.honors).toHaveLength(2);
  });
});

describe("what a new report may pull from meeting notes", () => {
  it("returns null for a month with no notes", async () => {
    mocks.noteFindMany.mockResolvedValue([]);
    expect(await monthlyNotesSummary("club-1", "2026-10")).toBeNull();
  });

  it("only looks at notes for that month", async () => {
    mocks.noteFindMany.mockResolvedValue([{ pathfinderCount: 10, tltCount: 2, staffCount: 3, honors: [] }]);
    await monthlyNotesSummary("club-1", "2026-10");
    expect(mocks.noteFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { organizationId: "club-1", meetingDate: { startsWith: "2026-10" } },
    }));
  });
});

describe("saving a meeting note", () => {
  it("creates a note and audits it with ids only", async () => {
    const note = await createClubMeetingNote("club-1", noteInput(), "account-1");
    expect(note.pathfinderCount).toBe(12);
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "CLUB_MEETING_NOTE_CREATED",
      metadata: { organizationId: "club-1", noteId: "note-1", actorAttendeeAccountId: "account-1" },
    }));
  });

  it("edits and deletes only a note that belongs to this club", async () => {
    await updateClubMeetingNote("club-1", "note-1", noteInput({ notes: "Updated" }), "account-1");
    expect(mocks.noteUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "note-1" } }));
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "CLUB_MEETING_NOTE_UPDATED" }));

    await deleteClubMeetingNote("club-1", "note-1", "account-1");
    expect(mocks.noteDelete).toHaveBeenCalledWith({ where: { id: "note-1" } });
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "CLUB_MEETING_NOTE_DELETED" }));
  });

  it("refuses a note id that belongs to another club", async () => {
    mocks.noteFindUnique.mockResolvedValue({ id: "note-1", organizationId: "club-2" });
    await expect(updateClubMeetingNote("club-1", "note-1", noteInput(), "account-1")).rejects.toMatchObject({ code: "NOTE_NOT_FOUND" });
    await expect(deleteClubMeetingNote("club-1", "note-1", "account-1")).rejects.toMatchObject({ code: "NOTE_NOT_FOUND" });
    expect(mocks.noteUpdate).not.toHaveBeenCalled();
    expect(mocks.noteDelete).not.toHaveBeenCalled();
  });
});

describe("who may keep meeting notes (reuses the report roles gate)", () => {
  const listRequest = () => new Request("https://events.imsda.test/api/attendee/clubs/club-1/notes");
  const postRequest = () => new Request("https://events.imsda.test/api/attendee/clubs/club-1/notes", {
    method: "POST",
    headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
    body: JSON.stringify({ meetingDate: "2026-10-07", pathfinderCount: 10, tltCount: 2, staffCount: 3, honors: [], notes: "" }),
  });
  const ctx = { params: Promise.resolve({ organizationId: "club-1" }) };

  it("lets a reporter keep notes without the roster's second step", async () => {
    mocks.listDirectedClubs.mockResolvedValue([{ organizationId: "club-1", name: "Test Pathfinders", role: "REPORTER", sponsoringChurch: null }]);
    expect((await GET(listRequest(), ctx)).status).toBe(200);
    expect((await POST(postRequest(), ctx)).status).toBe(201);
  });

  it("keeps a registrar out", async () => {
    mocks.listDirectedClubs.mockResolvedValue([{ organizationId: "club-1", name: "Test Pathfinders", role: "REGISTRAR", sponsoringChurch: null }]);
    const response = await POST(postRequest(), ctx);
    expect(response.status).toBe(403);
    expect(mocks.noteCreate).not.toHaveBeenCalled();
  });

  it("refuses another club's own director", async () => {
    mocks.listDirectedClubs.mockResolvedValue([{ organizationId: "club-2", name: "Other Club", role: "DIRECTOR", sponsoringChurch: null }]);
    const response = await POST(postRequest(), ctx);
    expect(response.status).toBe(404);
    expect(mocks.noteCreate).not.toHaveBeenCalled();
  });

  it("refuses editing or deleting another club's note through this club's API path", async () => {
    mocks.listDirectedClubs.mockResolvedValue([{ organizationId: "club-1", name: "Test Pathfinders", role: "DIRECTOR", sponsoringChurch: null }]);
    mocks.noteFindUnique.mockResolvedValue({ id: "note-1", organizationId: "club-2" });
    const noteCtx = { params: Promise.resolve({ organizationId: "club-1", noteId: "note-1" }) };
    const putRequest = new Request("https://events.imsda.test/api/attendee/clubs/club-1/notes/note-1", {
      method: "PUT",
      headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
      body: JSON.stringify({ meetingDate: "2026-10-07", pathfinderCount: 10, tltCount: 2, staffCount: 3, honors: [], notes: "" }),
    });
    expect((await PUT(putRequest, noteCtx)).status).toBe(404);
    const deleteRequest = new Request("https://events.imsda.test/api/attendee/clubs/club-1/notes/note-1", { method: "DELETE", headers: { origin: "https://events.imsda.test" } });
    expect((await DELETE(deleteRequest, noteCtx)).status).toBe(404);
  });
});
