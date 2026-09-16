import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import {
  normalizedTagName,
  tagInputSchema,
  tagUpdateSchema,
} from "@/modules/tags/domain";

export class TagConfigurationError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "NAME_CONFLICT" | "INACTIVE_TAG" | "CROSS_EVENT_REFERENCE",
    message: string,
  ) {
    super(message);
    this.name = "TagConfigurationError";
  }
}

const tagOrder = [{ name: "asc" as const }];

function conflict(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    throw new TagConfigurationError("NAME_CONFLICT", "A tag with that name already exists for this event.");
  }
  throw error;
}

function serializeTag(tag: { id: string; name: string; color: string; description: string; isActive: boolean }) {
  return { id: tag.id, name: tag.name, color: tag.color, description: tag.description, isActive: tag.isActive };
}

export async function listTags(eventId: string) {
  const tags = await getPrisma().eventTag.findMany({ where: { eventId }, orderBy: tagOrder });
  return tags.map(serializeTag);
}

export async function listActiveTags(eventId: string) {
  const tags = await getPrisma().eventTag.findMany({ where: { eventId, isActive: true }, orderBy: tagOrder });
  return tags.map(serializeTag);
}

export async function createTag(eventId: string, actorUserId: string, rawInput: unknown) {
  const input = tagInputSchema.parse(rawInput);
  try {
    return await getPrisma().$transaction(async (tx) => {
      const created = await tx.eventTag.create({
        data: { eventId, ...input, normalizedName: normalizedTagName(input.name) },
      });
      await tx.auditLog.create({
        data: {
          eventId, actorUserId, action: "TAG_CREATED", entityType: "EventTag", entityId: created.id,
          correlationId: randomUUID(), summary: `Created tag ${created.name}.`,
        },
      });
      return serializeTag(created);
    });
  } catch (error) { return conflict(error); }
}

export async function updateTag(eventId: string, tagId: string, actorUserId: string, rawInput: unknown) {
  const input = tagUpdateSchema.parse(rawInput);
  const existing = await getPrisma().eventTag.findFirst({ where: { id: tagId, eventId } });
  if (!existing) throw new TagConfigurationError("NOT_FOUND", "That tag was not found for this event.");
  try {
    return await getPrisma().$transaction(async (tx) => {
      const updated = await tx.eventTag.update({
        where: { id: tagId },
        data: { ...input, normalizedName: normalizedTagName(input.name) },
      });
      await tx.auditLog.create({
        data: {
          eventId, actorUserId, action: "TAG_UPDATED", entityType: "EventTag", entityId: tagId,
          correlationId: randomUUID(), summary: `Updated tag ${existing.name}.`,
          metadata: {
            nameChanged: existing.name !== updated.name,
            activeChanged: existing.isActive !== updated.isActive,
          },
        },
      });
      return serializeTag(updated);
    });
  } catch (error) { return conflict(error); }
}

async function activeTag(eventId: string, tagId: string) {
  const tag = await getPrisma().eventTag.findFirst({ where: { id: tagId, eventId } });
  if (!tag) throw new TagConfigurationError("NOT_FOUND", "That tag was not found for this event.");
  if (!tag.isActive) throw new TagConfigurationError("INACTIVE_TAG", "That tag is no longer active and cannot be applied.");
  return tag;
}

function serializeAssignment(row: {
  id: string;
  tag: { id: string; name: string; color: string; description: string; isActive: boolean };
  appliedBy: { id: string; displayName: string };
  appliedAt: Date;
  removedBy: { id: string; displayName: string } | null;
  removedAt: Date | null;
}) {
  return {
    id: row.id,
    tag: serializeTag(row.tag),
    appliedBy: row.appliedBy,
    appliedAt: row.appliedAt.toISOString(),
    removedBy: row.removedBy,
    removedAt: row.removedAt?.toISOString() ?? null,
  };
}

const assignmentInclude = {
  tag: true,
  appliedBy: { select: { id: true, displayName: true } },
  removedBy: { select: { id: true, displayName: true } },
} as const;

export async function listRegistrationTagAssignments(eventId: string, registrationId: string, activeOnly = true) {
  const rows = await getPrisma().registrationTagAssignment.findMany({
    where: { eventId, registrationId, ...(activeOnly ? { removedAt: null } : {}) },
    orderBy: { appliedAt: "desc" },
    include: assignmentInclude,
  });
  return rows.map(serializeAssignment);
}

export async function listAttendeeTagAssignments(eventId: string, attendeeId: string, activeOnly = true) {
  const rows = await getPrisma().attendeeTagAssignment.findMany({
    where: { eventId, attendeeId, ...(activeOnly ? { removedAt: null } : {}) },
    orderBy: { appliedAt: "desc" },
    include: assignmentInclude,
  });
  return rows.map(serializeAssignment);
}

export async function applyRegistrationTag(eventId: string, registrationId: string, tagId: string, actorUserId: string) {
  const prisma = getPrisma();
  const tag = await activeTag(eventId, tagId);
  const registration = await prisma.registration.findFirst({ where: { id: registrationId, eventId }, select: { id: true, confirmationCode: true } });
  if (!registration) throw new TagConfigurationError("NOT_FOUND", "That registration was not found for this event.");

  const existingActive = await prisma.registrationTagAssignment.findFirst({
    where: { eventId, registrationId, tagId, removedAt: null },
  });
  if (existingActive) return serializeAssignment(await prisma.registrationTagAssignment.findUniqueOrThrow({ where: { id: existingActive.id }, include: assignmentInclude }));

  return prisma.$transaction(async (tx) => {
    const created = await tx.registrationTagAssignment.create({
      data: { eventId, registrationId, tagId, appliedByUserId: actorUserId },
      include: assignmentInclude,
    });
    await tx.auditLog.create({
      data: {
        eventId, actorUserId, action: "REGISTRATION_TAG_APPLIED", entityType: "RegistrationTagAssignment", entityId: created.id,
        correlationId: randomUUID(), summary: `Applied tag ${tag.name} to registration ${registration.confirmationCode}.`,
        metadata: { registrationId, tagId },
      },
    });
    return serializeAssignment(created);
  });
}

export async function removeRegistrationTag(eventId: string, registrationId: string, tagId: string, actorUserId: string) {
  const prisma = getPrisma();
  const existingActive = await prisma.registrationTagAssignment.findFirst({
    where: { eventId, registrationId, tagId, removedAt: null },
    include: { tag: true, registration: { select: { confirmationCode: true } } },
  });
  if (!existingActive) throw new TagConfigurationError("NOT_FOUND", "That tag is not currently applied to this registration.");

  return prisma.$transaction(async (tx) => {
    const removed = await tx.registrationTagAssignment.update({
      where: { id: existingActive.id },
      data: { removedAt: new Date(), removedByUserId: actorUserId },
      include: assignmentInclude,
    });
    await tx.auditLog.create({
      data: {
        eventId, actorUserId, action: "REGISTRATION_TAG_REMOVED", entityType: "RegistrationTagAssignment", entityId: removed.id,
        correlationId: randomUUID(), summary: `Removed tag ${existingActive.tag.name} from registration ${existingActive.registration.confirmationCode}.`,
        metadata: { registrationId, tagId },
      },
    });
    return serializeAssignment(removed);
  });
}

export async function applyAttendeeTag(eventId: string, attendeeId: string, tagId: string, actorUserId: string) {
  const prisma = getPrisma();
  const tag = await activeTag(eventId, tagId);
  const attendee = await prisma.registrationAttendee.findFirst({ where: { id: attendeeId, eventId }, select: { id: true } });
  if (!attendee) throw new TagConfigurationError("NOT_FOUND", "That attendee was not found for this event.");

  const existingActive = await prisma.attendeeTagAssignment.findFirst({
    where: { eventId, attendeeId, tagId, removedAt: null },
  });
  if (existingActive) return serializeAssignment(await prisma.attendeeTagAssignment.findUniqueOrThrow({ where: { id: existingActive.id }, include: assignmentInclude }));

  return prisma.$transaction(async (tx) => {
    const created = await tx.attendeeTagAssignment.create({
      data: { eventId, attendeeId, tagId, appliedByUserId: actorUserId },
      include: assignmentInclude,
    });
    await tx.auditLog.create({
      data: {
        eventId, actorUserId, action: "ATTENDEE_TAG_APPLIED", entityType: "AttendeeTagAssignment", entityId: created.id,
        correlationId: randomUUID(), summary: `Applied tag ${tag.name} to an attendee.`,
        metadata: { attendeeId, tagId },
      },
    });
    return serializeAssignment(created);
  });
}

export async function removeAttendeeTag(eventId: string, attendeeId: string, tagId: string, actorUserId: string) {
  const prisma = getPrisma();
  const existingActive = await prisma.attendeeTagAssignment.findFirst({
    where: { eventId, attendeeId, tagId, removedAt: null },
    include: { tag: true },
  });
  if (!existingActive) throw new TagConfigurationError("NOT_FOUND", "That tag is not currently applied to this attendee.");

  return prisma.$transaction(async (tx) => {
    const removed = await tx.attendeeTagAssignment.update({
      where: { id: existingActive.id },
      data: { removedAt: new Date(), removedByUserId: actorUserId },
      include: assignmentInclude,
    });
    await tx.auditLog.create({
      data: {
        eventId, actorUserId, action: "ATTENDEE_TAG_REMOVED", entityType: "AttendeeTagAssignment", entityId: removed.id,
        correlationId: randomUUID(), summary: `Removed tag ${existingActive.tag.name} from an attendee.`,
        metadata: { attendeeId, tagId },
      },
    });
    return serializeAssignment(removed);
  });
}

/** Registration ids currently carrying an active (not removed) tag, for the
 * filter integration in `listRegistrations`. */
export async function listRegistrationIdsByActiveTag(eventId: string, tagIds: string[]) {
  const rows = await getPrisma().registrationTagAssignment.findMany({
    where: { eventId, tagId: { in: tagIds }, removedAt: null },
    select: { registrationId: true },
    distinct: ["registrationId"],
  });
  return rows.map((row) => row.registrationId);
}
