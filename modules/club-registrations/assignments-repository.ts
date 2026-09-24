import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import {
  type ClubAssignmentFields,
  type ClubAssignmentPreferences,
  clubAssignmentChangedSinceSent,
  clubAssignmentStatus,
  type ClubAssignmentStatus,
  emptyClubAssignmentFields,
  readClubAssignmentPreferences,
} from "@/modules/club-registrations/assignments";
import { currentRegistrationAnswers } from "@/modules/registrations/amendments-repository";

/**
 * Repository for club event assignments (#410). Pure domain rules live in
 * `assignments.ts`; this module is the only place that touches Prisma.
 */

const FIELD_MAX = 200;
const NOTES_MAX = 2000;

export const clubAssignmentInputSchema = z.object({
  campsiteLocation: z.string().trim().max(FIELD_MAX).default(""),
  campsiteNotes: z.string().trim().max(NOTES_MAX).default(""),
  dutyLabel: z.string().trim().max(FIELD_MAX).default(""),
  dutyDay: z.string().trim().max(FIELD_MAX).default(""),
  dutyTime: z.string().trim().max(FIELD_MAX).default(""),
  activityLabel: z.string().trim().max(FIELD_MAX).default(""),
  notes: z.string().trim().max(NOTES_MAX).default(""),
}).strict();

export type ClubAssignmentInput = z.infer<typeof clubAssignmentInputSchema>;

export class ClubAssignmentError extends Error {
  code: "NOT_FOUND";
  constructor(code: "NOT_FOUND", message: string) {
    super(message);
    this.code = code;
  }
}

export type ClubAssignmentRow = {
  organizationId: string;
  organizationName: string;
  sponsoringChurch: string | null;
  clubEventRegistrationId: string;
  registrationId: string;
  confirmationCode: string;
  attendeeCount: number;
  fields: ClubAssignmentFields;
  status: ClubAssignmentStatus;
  version: number;
  lastEmailSentAt: string | null;
  lastEmailedVersion: number | null;
  changedSinceSent: boolean;
  preferences: ClubAssignmentPreferences;
};

function fieldsFromRow(row: ClubAssignmentFields | null): ClubAssignmentFields {
  return row ?? emptyClubAssignmentFields;
}

/** Every active club registration for this event, staff's assignments, and each club's submitted preferences. */
export async function listClubAssignments(eventId: string): Promise<ClubAssignmentRow[]> {
  const registrations = await getPrisma().clubEventRegistration.findMany({
    where: { eventId, registration: { status: { in: ["SUBMITTED", "CONFIRMED"] } } },
    orderBy: { organization: { name: "asc" } },
    select: {
      id: true,
      organizationId: true,
      registrationId: true,
      organization: { select: { name: true, parentOrganization: { select: { name: true } } } },
      registration: { select: { confirmationCode: true, _count: { select: { attendees: true } } } },
      assignment: true,
    },
  });
  return Promise.all(registrations.map(async (row) => {
    const answers = await currentRegistrationAnswers(eventId, row.registrationId);
    const preferences = readClubAssignmentPreferences(answers?.responses);
    const fields = fieldsFromRow(row.assignment);
    return {
      organizationId: row.organizationId,
      organizationName: row.organization.name,
      sponsoringChurch: row.organization.parentOrganization?.name ?? null,
      clubEventRegistrationId: row.id,
      registrationId: row.registrationId,
      confirmationCode: row.registration.confirmationCode,
      attendeeCount: row.registration._count.attendees,
      fields,
      status: clubAssignmentStatus(fields),
      version: row.assignment?.version ?? 1,
      lastEmailSentAt: row.assignment?.lastEmailSentAt?.toISOString() ?? null,
      lastEmailedVersion: row.assignment?.lastEmailedVersion ?? null,
      changedSinceSent: row.assignment
        ? clubAssignmentChangedSinceSent({
          version: row.assignment.version,
          lastEmailedVersion: row.assignment.lastEmailedVersion,
        })
        : false,
      preferences,
    };
  }));
}

/**
 * Staff sets or edits one club's assignment. `version` always increments on a
 * real change, which is what "changed since sent" is derived from; it is left
 * unchanged when the saved fields are identical to what is already stored, so
 * clicking save twice with no edit doesn't manufacture a resend (and writes
 * neither a row update nor an audit entry).
 */
export async function upsertClubAssignment(
  eventId: string,
  organizationId: string,
  input: ClubAssignmentInput,
  actorUserId: string,
) {
  const prisma = getPrisma();
  // Read, compare, write, and audit as one serializable unit: two staff
  // saving at once must not both see "unchanged" or both bump from the same
  // version, and an audit row must never describe a write that lost the race.
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const clubRegistration = await tx.clubEventRegistration.findUnique({
          where: { eventId_organizationId: { eventId, organizationId } },
          select: { id: true, registration: { select: { status: true } } },
        });
        if (!clubRegistration || !["SUBMITTED", "CONFIRMED"].includes(clubRegistration.registration.status)) {
          throw new ClubAssignmentError("NOT_FOUND", "That club has no active registration for this event.");
        }
        const existing = await tx.clubEventAssignment.findUnique({
          where: { clubEventRegistrationId: clubRegistration.id },
        });
        const changed = !existing
          || existing.campsiteLocation !== input.campsiteLocation
          || existing.campsiteNotes !== input.campsiteNotes
          || existing.dutyLabel !== input.dutyLabel
          || existing.dutyDay !== input.dutyDay
          || existing.dutyTime !== input.dutyTime
          || existing.activityLabel !== input.activityLabel
          || existing.notes !== input.notes;
        if (!changed) return existing;
        const saved = await tx.clubEventAssignment.upsert({
          where: { clubEventRegistrationId: clubRegistration.id },
          create: {
            eventId,
            organizationId,
            clubEventRegistrationId: clubRegistration.id,
            ...input,
            updatedByUserId: actorUserId,
          },
          update: { ...input, version: { increment: 1 }, updatedByUserId: actorUserId },
        });
        // No attendee names, ages, or free text beyond the assignment fields
        // themselves — this is staff's own words about campsite/duty/activity,
        // never roster or medical data.
        await writeAuditLog({
          eventId,
          actorUserId,
          action: "CLUB_ASSIGNMENT_UPDATED",
          entityType: "ClubEventAssignment",
          entityId: saved.id,
          summary: `Updated the club assignment for organization ${organizationId}.`,
          metadata: { organizationId, version: saved.version },
        }, tx);
        return saved;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      const retryable = error instanceof Prisma.PrismaClientKnownRequestError
        && (error.code === "P2002" || error.code === "P2034");
      if (!retryable || attempt >= 2) throw error;
    }
  }
}

function assignmentPublicFields(row: {
  campsiteLocation: string;
  campsiteNotes: string;
  dutyLabel: string;
  dutyDay: string;
  dutyTime: string;
  activityLabel: string;
  notes: string;
}): ClubAssignmentFields {
  return {
    campsiteLocation: row.campsiteLocation,
    campsiteNotes: row.campsiteNotes,
    dutyLabel: row.dutyLabel,
    dutyDay: row.dutyDay,
    dutyTime: row.dutyTime,
    activityLabel: row.activityLabel,
    notes: row.notes,
  };
}

/**
 * The read-only view for a club director on their own event page, and for
 * the club packet (#411) print helper. Returns null when staff haven't set
 * anything yet, so an empty section is never shown.
 */
export async function getClubAssignmentForClub(eventId: string, organizationId: string) {
  const row = await getPrisma().clubEventAssignment.findUnique({
    where: { eventId_organizationId: { eventId, organizationId } },
  });
  if (!row) return null;
  const fields = assignmentPublicFields(row);
  const status = clubAssignmentStatus(fields);
  if (status === "UNASSIGNED") return null;
  return { fields, status };
}
