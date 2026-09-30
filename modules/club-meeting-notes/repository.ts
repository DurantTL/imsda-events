import "server-only";

import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { clubYearFor } from "@/modules/club-rosters/domain";
import { attendanceGroupOf, compareByName, countsFromAttendance, type AttendanceGroup } from "@/modules/club-meeting-notes/attendance";
import { notesMonthlySummary } from "@/modules/club-meeting-notes/domain";
import type { MeetingNoteInput } from "@/modules/club-meeting-notes/schemas";
import type { ReportHonor } from "@/modules/club-reports/domain";

/**
 * Club meeting note storage (#426). Every write is scoped to one club's
 * `organizationId`; a note id from another club never matches.
 */

export type ClubMeetingNoteErrorCode = "CLUB_NOT_FOUND" | "NOTE_NOT_FOUND" | "INVALID_ATTENDANCE";

/** Never an attendee account credited for a staff action (#442): `userId` (with `actAsId`) for a staff "act as" director. */
export type ClubMeetingNoteActor = { accountId: string } | { userId: string; actAsId: string };

export class ClubMeetingNoteError extends Error {
  constructor(public readonly code: ClubMeetingNoteErrorCode, message: string) {
    super(message);
    this.name = "ClubMeetingNoteError";
  }
}

const noteSelect = {
  id: true,
  organizationId: true,
  meetingDate: true,
  pathfinderCount: true,
  tltCount: true,
  staffCount: true,
  honors: true,
  notes: true,
  attendance: { select: { rosterMemberId: true, present: true } },
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ClubMeetingNoteSelect;

type StoredNote = Prisma.ClubMeetingNoteGetPayload<{ select: typeof noteSelect }>;

function serializeNote(note: StoredNote) {
  return {
    ...note,
    attendance: note.attendance ?? [],
    honors: (Array.isArray(note.honors) ? note.honors : []) as ReportHonor[],
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString(),
  };
}

export type ClubMeetingNoteRecord = ReturnType<typeof serializeNote>;

/** A club's notes, newest first; `month` ("2026-10") narrows to that month's meetings. */
export async function listClubMeetingNotes(organizationId: string, month?: string) {
  const notes = await getPrisma().clubMeetingNote.findMany({
    where: { organizationId, ...(month ? { meetingDate: { startsWith: month } } : {}) },
    select: noteSelect,
    orderBy: { meetingDate: "desc" },
  });
  return notes.map(serializeNote);
}

export async function createClubMeetingNote(organizationId: string, input: MeetingNoteInput, actor: ClubMeetingNoteActor) {
  const prisma = getPrisma();
  const club = await prisma.organization.findUnique({ where: { id: organizationId }, select: { type: true } });
  if (!club || club.type !== "CLUB") throw new ClubMeetingNoteError("CLUB_NOT_FOUND", "That club could not be found.");
  const honors = input.honors.filter((honor) => honor.name.trim() || honor.participants !== null);
  const attendance = await checkedAttendance(organizationId, input);
  const counts = filledCounts(input, attendance);
  const note = await prisma.clubMeetingNote.create({
    data: {
      organizationId,
      meetingDate: input.meetingDate,
      ...counts,
      honors,
      notes: input.notes,
      ...(attendance ? { attendance: { create: attendance.rows } } : {}),
      ...("accountId" in actor
        ? { createdByAccountId: actor.accountId, updatedByAccountId: actor.accountId }
        : { createdByUserId: actor.userId, updatedByUserId: actor.userId }),
    },
    select: noteSelect,
  });
  await writeAuditLog({
    ...("userId" in actor ? { actorUserId: actor.userId } : {}),
    action: "CLUB_MEETING_NOTE_CREATED",
    entityType: "ClubMeetingNote",
    entityId: note.id,
    summary: "Added a club meeting note.",
    metadata: {
      organizationId,
      noteId: note.id,
      ...(attendance ? { attendanceRecorded: attendance.total } : {}),
      ...("accountId" in actor ? { actorAttendeeAccountId: actor.accountId } : { actAsId: actor.actAsId }),
    },
  });
  return serializeNote(note);
}

type ExistingMark = { rosterMemberId: string; present: boolean };
type CheckedAttendance = {
  /** Replace everything first (a clear, or a meeting moved to another club year). */
  replace: boolean;
  rows: Array<{ rosterMemberId: string; present: boolean }>;
  /** Head counts over the marks the meeting will end up with. */
  counts: { pathfinderCount: number; tltCount: number; staffCount: number };
  /** Marks that will exist after the save, for the audit count. */
  total: number;
};

function clubYearOfDate(meetingDate: string) {
  return clubYearFor(new Date(`${meetingDate}T12:00:00Z`));
}

/**
 * The check-off a note is saved with (#653), or null when the request leaves
 * attendance alone. Everyone listed must be an active, named member of this
 * club's roster for the club year of the meeting date, so an id from another
 * club or year, or an erased member, never matches. A list merges into the
 * marks already on the meeting (ids not listed keep their mark); an empty list
 * clears them; a meeting moved to another club year starts over.
 */
async function checkedAttendance(
  organizationId: string,
  input: MeetingNoteInput,
  existing: readonly ExistingMark[] = [],
  movedYear = false,
): Promise<CheckedAttendance | null> {
  if (input.attendance === undefined) return null;
  const ids = input.attendance.map((entry) => entry.rosterMemberId);
  if (new Set(ids).size !== ids.length) throw new ClubMeetingNoteError("INVALID_ATTENDANCE", "Each person can be checked off once per meeting.");
  if (ids.length === 0) return { replace: true, rows: [], counts: { pathfinderCount: 0, tltCount: 0, staffCount: 0 }, total: 0 };
  const prisma = getPrisma();
  const members = await prisma.clubRosterMember.findMany({
    where: { id: { in: ids }, organizationId, clubYear: clubYearOfDate(input.meetingDate), status: { not: "REMOVED" }, personId: { not: null } },
    select: { id: true, attendeeType: true, classLevel: true },
  });
  if (members.length !== ids.length) {
    throw new ClubMeetingNoteError("INVALID_ATTENDANCE", "Attendance can only list people on this club's roster for the meeting's club year.");
  }
  const kept = movedYear ? [] : existing.filter((mark) => !ids.includes(mark.rosterMemberId));
  const keptKinds = kept.length === 0 ? [] : await prisma.clubRosterMember.findMany({
    where: { id: { in: kept.map((mark) => mark.rosterMemberId) }, organizationId },
    select: { id: true, attendeeType: true, classLevel: true },
  });
  const kindById = new Map([...members, ...keptKinds].map((member) => [member.id, member]));
  const merged = [...kept, ...input.attendance.map((entry) => ({ rosterMemberId: entry.rosterMemberId, present: entry.present }))];
  return {
    replace: movedYear,
    rows: input.attendance.map((entry) => ({ rosterMemberId: entry.rosterMemberId, present: entry.present })),
    counts: countsFromAttendance(merged.flatMap((mark) => {
      const kind = kindById.get(mark.rosterMemberId);
      return kind ? [{ ...kind, present: mark.present }] : [];
    })),
    total: merged.length,
  };
}

/** Typed head counts stay as typed; a blank count is filled from the check-off when there is one. */
function filledCounts(input: MeetingNoteInput, attendance: CheckedAttendance | null) {
  const derived = attendance && (attendance.rows.length > 0 || attendance.total > 0) ? attendance.counts : null;
  return {
    pathfinderCount: input.pathfinderCount ?? derived?.pathfinderCount ?? null,
    tltCount: input.tltCount ?? derived?.tltCount ?? null,
    staffCount: input.staffCount ?? derived?.staffCount ?? null,
  };
}

export type AttendanceRosterEntry = {
  id: string;
  firstName: string;
  lastName: string;
  attendeeType: string;
  classLevel: string | null;
  group: AttendanceGroup;
};

/** Who can be checked off for a club year: the active roster, by name. */
export async function listAttendanceRoster(organizationId: string, clubYear: string): Promise<AttendanceRosterEntry[]> {
  const members = await getPrisma().clubRosterMember.findMany({
    where: { organizationId, clubYear, status: "ACTIVE", personId: { not: null } },
    select: { id: true, attendeeType: true, classLevel: true, person: { select: { firstName: true, lastName: true } } },
  });
  return members
    .flatMap((member) => (member.person ? [{
      id: member.id,
      firstName: member.person.firstName,
      lastName: member.person.lastName,
      attendeeType: member.attendeeType,
      classLevel: member.classLevel,
      group: attendanceGroupOf(member),
    }] : []))
    .sort(compareByName);
}

/** The attendance export's rows: meetings with a check-off in range, and the members and marks on them. */
export async function loadAttendanceExport(organizationId: string, clubYear: string, range: { from?: string; to?: string }) {
  const prisma = getPrisma();
  const [club, notes, active] = await Promise.all([
    prisma.organization.findUnique({ where: { id: organizationId }, select: { name: true } }),
    prisma.clubMeetingNote.findMany({
      where: {
        organizationId,
        attendance: { some: {} },
        meetingDate: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) },
      },
      select: { id: true, meetingDate: true, attendance: { select: { rosterMemberId: true, present: true } } },
      orderBy: { meetingDate: "asc" },
    }),
    listAttendanceRoster(organizationId, clubYear),
  ]);
  // The club year's meetings, unless the caller chose dates.
  const inScope = notes.filter((note) => range.from || range.to || clubYearFor(new Date(`${note.meetingDate}T12:00:00Z`)) === clubYear);
  const marks = new Map<string, boolean>();
  const markedIds = new Set<string>();
  for (const note of inScope) {
    for (const entry of note.attendance) {
      marks.set(`${note.id}:${entry.rosterMemberId}`, entry.present);
      markedIds.add(entry.rosterMemberId);
    }
  }
  const known = new Set(active.map((member) => member.id));
  const extraIds = [...markedIds].filter((id) => !known.has(id));
  const extra = extraIds.length === 0 ? [] : await prisma.clubRosterMember.findMany({
    where: { id: { in: extraIds }, organizationId, status: { not: "REMOVED" } },
    select: { id: true, attendeeType: true, classLevel: true, person: { select: { firstName: true, lastName: true } } },
  });
  const members = [
    ...active,
    ...extra.map((member) => ({
      id: member.id,
      firstName: member.person?.firstName ?? "Unknown",
      lastName: member.person?.lastName ?? "",
      attendeeType: member.attendeeType,
      classLevel: member.classLevel,
      group: attendanceGroupOf(member),
    })),
  ];
  return {
    clubName: club?.name ?? "",
    meetings: inScope.map((note) => ({ id: note.id, meetingDate: note.meetingDate })),
    members,
    marks,
  };
}

async function findOwnNote(organizationId: string, noteId: string) {
  const prisma = getPrisma();
  const note = await prisma.clubMeetingNote.findUnique({
    where: { id: noteId },
    select: { id: true, organizationId: true, meetingDate: true, attendance: { select: { rosterMemberId: true, present: true } } },
  });
  if (!note || note.organizationId !== organizationId) throw new ClubMeetingNoteError("NOTE_NOT_FOUND", "That meeting note could not be found.");
  return { prisma, note };
}

/**
 * Whether saving `meetingDate` would wipe the stored marks: the note has a
 * check-off and the date moves into another club year (#653). Wiping marks is
 * a roster-gated change, so the route asks before saving.
 */
export async function moveWouldClearAttendance(organizationId: string, noteId: string, meetingDate: string) {
  const { note } = await findOwnNote(organizationId, noteId);
  return (note.attendance ?? []).length > 0 && Boolean(note.meetingDate) && clubYearOfDate(note.meetingDate) !== clubYearOfDate(meetingDate);
}

export async function updateClubMeetingNote(organizationId: string, noteId: string, input: MeetingNoteInput, actor: ClubMeetingNoteActor) {
  const { prisma, note: current } = await findOwnNote(organizationId, noteId);
  const honors = input.honors.filter((honor) => honor.name.trim() || honor.participants !== null);
  // A meeting moved into another club year can't keep marks for that year's other roster (#653).
  const movedYear = Boolean(current.meetingDate) && clubYearOfDate(current.meetingDate) !== clubYearOfDate(input.meetingDate);
  const attendance = await checkedAttendance(organizationId, input, current.attendance ?? [], movedYear);
  const counts = filledCounts(input, attendance);
  const note = await prisma.clubMeetingNote.update({
    where: { id: noteId },
    data: {
      meetingDate: input.meetingDate,
      ...counts,
      honors,
      notes: input.notes,
      ...(attendance
        ? {
            attendance: attendance.replace
              ? { deleteMany: {}, ...(attendance.rows.length > 0 ? { create: attendance.rows } : {}) }
              : {
                  upsert: attendance.rows.map((row) => ({
                    where: { meetingNoteId_rosterMemberId: { meetingNoteId: noteId, rosterMemberId: row.rosterMemberId } },
                    create: row,
                    update: { present: row.present },
                  })),
                },
          }
        : movedYear ? { attendance: { deleteMany: {} } } : {}),
      ...("accountId" in actor ? { updatedByAccountId: actor.accountId } : { updatedByUserId: actor.userId }),
    },
    select: noteSelect,
  });
  await writeAuditLog({
    ...("userId" in actor ? { actorUserId: actor.userId } : {}),
    action: "CLUB_MEETING_NOTE_UPDATED",
    entityType: "ClubMeetingNote",
    entityId: note.id,
    summary: "Edited a club meeting note.",
    metadata: {
      organizationId,
      noteId: note.id,
      ...(attendance ? { attendanceRecorded: attendance.total } : {}),
      ...("accountId" in actor ? { actorAttendeeAccountId: actor.accountId } : { actAsId: actor.actAsId }),
    },
  });
  return serializeNote(note);
}

export async function deleteClubMeetingNote(organizationId: string, noteId: string, actor: ClubMeetingNoteActor) {
  const { prisma } = await findOwnNote(organizationId, noteId);
  await prisma.clubMeetingNote.delete({ where: { id: noteId } });
  await writeAuditLog({
    ...("userId" in actor ? { actorUserId: actor.userId } : {}),
    action: "CLUB_MEETING_NOTE_DELETED",
    entityType: "ClubMeetingNote",
    entityId: noteId,
    summary: "Deleted a club meeting note.",
    metadata: {
      organizationId,
      noteId,
      ...("accountId" in actor ? { actorAttendeeAccountId: actor.accountId } : { actAsId: actor.actAsId }),
    },
  });
}

/** What a NEW monthly report prefills from that month's meeting notes (#426), or null with none. */
export async function monthlyNotesSummary(organizationId: string, reportMonth: string) {
  const notes = await getPrisma().clubMeetingNote.findMany({
    where: { organizationId, meetingDate: { startsWith: reportMonth } },
    select: { pathfinderCount: true, tltCount: true, staffCount: true, honors: true, attendance: { select: { present: true } } },
  });
  return notesMonthlySummary(notes.map(({ attendance, ...note }) => ({
    ...note,
    presentPeople: attendance && attendance.length > 0 ? attendance.filter((entry) => entry.present).length : null,
    honors: (Array.isArray(note.honors) ? note.honors : []) as ReportHonor[],
  })));
}
