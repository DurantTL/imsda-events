import "server-only";

import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { notesMonthlySummary } from "@/modules/club-meeting-notes/domain";
import type { MeetingNoteInput } from "@/modules/club-meeting-notes/schemas";
import type { ReportHonor } from "@/modules/club-reports/domain";

/**
 * Club meeting note storage (#426). Every write is scoped to one club's
 * `organizationId`; a note id from another club never matches.
 */

export type ClubMeetingNoteErrorCode = "CLUB_NOT_FOUND" | "NOTE_NOT_FOUND";

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
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ClubMeetingNoteSelect;

type StoredNote = Prisma.ClubMeetingNoteGetPayload<{ select: typeof noteSelect }>;

function serializeNote(note: StoredNote) {
  return {
    ...note,
    honors: (Array.isArray(note.honors) ? note.honors : []) as ReportHonor[],
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString(),
  };
}

export type ClubMeetingNoteRecord = ReturnType<typeof serializeNote>;

export async function listClubMeetingNotes(organizationId: string) {
  const notes = await getPrisma().clubMeetingNote.findMany({
    where: { organizationId },
    select: noteSelect,
    orderBy: { meetingDate: "desc" },
  });
  return notes.map(serializeNote);
}

export async function createClubMeetingNote(organizationId: string, input: MeetingNoteInput, accountId: string) {
  const prisma = getPrisma();
  const club = await prisma.organization.findUnique({ where: { id: organizationId }, select: { type: true } });
  if (!club || club.type !== "CLUB") throw new ClubMeetingNoteError("CLUB_NOT_FOUND", "That club could not be found.");
  const honors = input.honors.filter((honor) => honor.name.trim() || honor.participants !== null);
  const note = await prisma.clubMeetingNote.create({
    data: {
      organizationId,
      meetingDate: input.meetingDate,
      pathfinderCount: input.pathfinderCount,
      tltCount: input.tltCount,
      staffCount: input.staffCount,
      honors,
      notes: input.notes,
      createdByAccountId: accountId,
      updatedByAccountId: accountId,
    },
    select: noteSelect,
  });
  await writeAuditLog({
    action: "CLUB_MEETING_NOTE_CREATED",
    entityType: "ClubMeetingNote",
    entityId: note.id,
    summary: "Added a club meeting note.",
    metadata: { organizationId, noteId: note.id, actorAttendeeAccountId: accountId },
  });
  return serializeNote(note);
}

async function findOwnNote(organizationId: string, noteId: string) {
  const prisma = getPrisma();
  const note = await prisma.clubMeetingNote.findUnique({ where: { id: noteId }, select: { id: true, organizationId: true } });
  if (!note || note.organizationId !== organizationId) throw new ClubMeetingNoteError("NOTE_NOT_FOUND", "That meeting note could not be found.");
  return prisma;
}

export async function updateClubMeetingNote(organizationId: string, noteId: string, input: MeetingNoteInput, accountId: string) {
  const prisma = await findOwnNote(organizationId, noteId);
  const honors = input.honors.filter((honor) => honor.name.trim() || honor.participants !== null);
  const note = await prisma.clubMeetingNote.update({
    where: { id: noteId },
    data: {
      meetingDate: input.meetingDate,
      pathfinderCount: input.pathfinderCount,
      tltCount: input.tltCount,
      staffCount: input.staffCount,
      honors,
      notes: input.notes,
      updatedByAccountId: accountId,
    },
    select: noteSelect,
  });
  await writeAuditLog({
    action: "CLUB_MEETING_NOTE_UPDATED",
    entityType: "ClubMeetingNote",
    entityId: note.id,
    summary: "Edited a club meeting note.",
    metadata: { organizationId, noteId: note.id, actorAttendeeAccountId: accountId },
  });
  return serializeNote(note);
}

export async function deleteClubMeetingNote(organizationId: string, noteId: string, accountId: string) {
  const prisma = await findOwnNote(organizationId, noteId);
  await prisma.clubMeetingNote.delete({ where: { id: noteId } });
  await writeAuditLog({
    action: "CLUB_MEETING_NOTE_DELETED",
    entityType: "ClubMeetingNote",
    entityId: noteId,
    summary: "Deleted a club meeting note.",
    metadata: { organizationId, noteId, actorAttendeeAccountId: accountId },
  });
}

/** What a NEW monthly report prefills from that month's meeting notes (#426), or null with none. */
export async function monthlyNotesSummary(organizationId: string, reportMonth: string) {
  const notes = await getPrisma().clubMeetingNote.findMany({
    where: { organizationId, meetingDate: { startsWith: reportMonth } },
    select: { pathfinderCount: true, tltCount: true, staffCount: true, honors: true },
  });
  return notesMonthlySummary(notes.map((note) => ({ ...note, honors: (Array.isArray(note.honors) ? note.honors : []) as ReportHonor[] })));
}
