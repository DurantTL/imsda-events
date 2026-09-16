import "server-only";

import { randomUUID } from "node:crypto";
import { getPrisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import {
  canReadNote,
  noteInputSchema,
  noteRevisionInputSchema,
  type NoteRecord,
  type NoteSubject,
} from "@/modules/notes/domain";

export class NoteError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "FORBIDDEN" | "SUBJECT_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "NoteError";
  }
}

const noteInclude = {
  author: { select: { id: true, displayName: true } },
  revisions: {
    orderBy: { sequence: "asc" as const },
    include: { author: { select: { id: true, displayName: true } } },
  },
};

type NoteRow = Prisma.StaffNoteGetPayload<{ include: typeof noteInclude }>;

function serializeNote(row: NoteRow): NoteRecord {
  const latest = row.revisions.at(-1) ?? null;
  return {
    id: row.id,
    visibility: row.visibility,
    restrictedPermission: row.restrictedPermission,
    author: row.author,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    body: latest?.body ?? "",
    revisionCount: row.revisions.length,
    revisions: row.revisions.map((revision) => ({
      id: revision.id,
      sequence: revision.sequence,
      body: revision.body,
      author: revision.author,
      createdAt: revision.createdAt.toISOString(),
    })),
  };
}

async function assertSubjectExists(eventId: string, subject: NoteSubject) {
  const prisma = getPrisma();
  if (subject.registrationId) {
    const found = await prisma.registration.findFirst({ where: { id: subject.registrationId, eventId }, select: { id: true } });
    if (!found) throw new NoteError("SUBJECT_NOT_FOUND", "That registration was not found for this event.");
  } else if (subject.attendeeId) {
    const found = await prisma.registrationAttendee.findFirst({ where: { id: subject.attendeeId, eventId }, select: { id: true } });
    if (!found) throw new NoteError("SUBJECT_NOT_FOUND", "That attendee was not found for this event.");
  } else {
    const found = await prisma.person.findUnique({ where: { id: subject.personId }, select: { id: true } });
    if (!found) throw new NoteError("SUBJECT_NOT_FOUND", "That person was not found.");
  }
}

function subjectAuditMetadata(subject: NoteSubject) {
  if (subject.registrationId) return { registrationId: subject.registrationId };
  if (subject.attendeeId) return { attendeeId: subject.attendeeId };
  return { personId: subject.personId };
}

export async function createNote(
  eventId: string,
  subject: NoteSubject,
  actorUserId: string,
  rawInput: unknown,
) {
  const input = noteInputSchema.parse(rawInput);
  await assertSubjectExists(eventId, subject);

  return getPrisma().$transaction(async (tx) => {
    const note = await tx.staffNote.create({
      data: {
        eventId,
        ...subject,
        visibility: input.visibility,
        restrictedPermission: input.restrictedPermission ?? null,
        authorUserId: actorUserId,
        revisions: {
          create: { sequence: 1, body: input.body, authorUserId: actorUserId },
        },
      },
      include: noteInclude,
    });
    await tx.auditLog.create({
      data: {
        eventId, actorUserId, action: "STAFF_NOTE_CREATED", entityType: "StaffNote", entityId: note.id,
        correlationId: randomUUID(), summary: "Created a staff note.",
        metadata: { visibility: input.visibility, ...subjectAuditMetadata(subject) },
      },
    });
    return serializeNote(note);
  });
}

export async function addNoteRevision(
  eventId: string,
  noteId: string,
  actorUserId: string,
  rawInput: unknown,
) {
  const input = noteRevisionInputSchema.parse(rawInput);
  const existing = await getPrisma().staffNote.findFirst({
    where: { id: noteId, eventId },
    include: { revisions: { orderBy: { sequence: "desc" }, take: 1 } },
  });
  if (!existing) throw new NoteError("NOT_FOUND", "That note was not found for this event.");
  const nextSequence = (existing.revisions[0]?.sequence ?? 0) + 1;

  return getPrisma().$transaction(async (tx) => {
    await tx.staffNoteRevision.create({
      data: { noteId, sequence: nextSequence, body: input.body, authorUserId: actorUserId },
    });
    const note = await tx.staffNote.update({
      where: { id: noteId },
      data: { updatedAt: new Date() },
      include: noteInclude,
    });
    await tx.auditLog.create({
      data: {
        eventId, actorUserId, action: "STAFF_NOTE_REVISED", entityType: "StaffNote", entityId: noteId,
        correlationId: randomUUID(), summary: `Revised a staff note (revision ${nextSequence}).`,
        metadata: { revisionSequence: nextSequence },
      },
    });
    return serializeNote(note);
  });
}

/**
 * Every read path funnels through here: a restricted note the caller lacks
 * permission for is left out entirely, not returned redacted. That is what
 * keeps a general export from ever showing a restricted note.
 */
function visibleOnly(notes: NoteRow[], actorPermissions: ReadonlySet<string>) {
  return notes.filter((note) => canReadNote(note, actorPermissions)).map(serializeNote);
}

export async function listNotesForRegistration(eventId: string, registrationId: string, actorPermissions: ReadonlySet<string>) {
  const notes = await getPrisma().staffNote.findMany({
    where: { eventId, registrationId },
    orderBy: { createdAt: "desc" },
    include: noteInclude,
  });
  return visibleOnly(notes, actorPermissions);
}

export async function listNotesForAttendee(eventId: string, attendeeId: string, actorPermissions: ReadonlySet<string>) {
  const notes = await getPrisma().staffNote.findMany({
    where: { eventId, attendeeId },
    orderBy: { createdAt: "desc" },
    include: noteInclude,
  });
  return visibleOnly(notes, actorPermissions);
}

export async function listNotesForPerson(eventId: string, personId: string, actorPermissions: ReadonlySet<string>) {
  const notes = await getPrisma().staffNote.findMany({
    where: { eventId, personId },
    orderBy: { createdAt: "desc" },
    include: noteInclude,
  });
  return visibleOnly(notes, actorPermissions);
}

export async function getNoteIfVisible(eventId: string, noteId: string, actorPermissions: ReadonlySet<string>) {
  const note = await getPrisma().staffNote.findFirst({ where: { id: noteId, eventId }, include: noteInclude });
  if (!note) throw new NoteError("NOT_FOUND", "That note was not found for this event.");
  if (!canReadNote(note, actorPermissions)) throw new NoteError("FORBIDDEN", "This note is restricted to a permission you do not hold.");
  return serializeNote(note);
}
