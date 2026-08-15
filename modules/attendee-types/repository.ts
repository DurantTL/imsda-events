import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import {
  attendeeClassificationInputSchema,
  attendeeClassificationUpdateSchema,
  attendeeTypeInputSchema,
  attendeeTypeUpdateSchema,
  attendeeTypeReference,
  planAttendeeTypeBackfill,
} from "@/modules/attendee-types/domain";

export class AttendeeConfigurationError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "CODE_CONFLICT" | "INACTIVE_REFERENCE" | "CROSS_EVENT_REFERENCE",
    message: string,
  ) {
    super(message);
    this.name = "AttendeeConfigurationError";
  }
}

const typeOrder = [{ sortOrder: "asc" as const }, { label: "asc" as const }];
const classificationOrder = [{ kind: "asc" as const }, { sortOrder: "asc" as const }, { label: "asc" as const }];

function conflict(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    throw new AttendeeConfigurationError("CODE_CONFLICT", "That code is already configured for this event and dimension.");
  }
  throw error;
}

export async function listAttendeeConfiguration(eventId: string) {
  const prisma = getPrisma();
  const [attendeeTypes, classifications] = await Promise.all([
    prisma.eventAttendeeType.findMany({ where: { eventId }, orderBy: typeOrder }),
    prisma.eventAttendeeClassification.findMany({ where: { eventId }, orderBy: classificationOrder }),
  ]);
  return { attendeeTypes, classifications };
}

export async function listActiveAttendeeTypes(eventId: string) {
  return getPrisma().eventAttendeeType.findMany({
    where: { eventId, isActive: true },
    orderBy: typeOrder,
  });
}

export async function createAttendeeType(eventId: string, actorUserId: string, rawInput: unknown) {
  const input = attendeeTypeInputSchema.parse(rawInput);
  try {
    return await getPrisma().$transaction(async (tx) => {
      const created = await tx.eventAttendeeType.create({ data: { eventId, ...input } });
      await tx.auditLog.create({ data: {
        eventId, actorUserId, action: "ATTENDEE_TYPE_CREATED", entityType: "EventAttendeeType", entityId: created.id,
        correlationId: randomUUID(), summary: `Created attendee type ${created.code}.`, metadata: { productionWrite: false },
      } });
      return created;
    });
  } catch (error) { return conflict(error); }
}

export async function updateAttendeeType(eventId: string, typeId: string, actorUserId: string, rawInput: unknown) {
  const input = attendeeTypeUpdateSchema.parse(rawInput);
  const existing = await getPrisma().eventAttendeeType.findFirst({ where: { id: typeId, eventId } });
  if (!existing) throw new AttendeeConfigurationError("NOT_FOUND", "That attendee type was not found for this event.");
  return getPrisma().$transaction(async (tx) => {
    const updated = await tx.eventAttendeeType.update({ where: { id: typeId }, data: input });
    await tx.auditLog.create({ data: {
      eventId, actorUserId, action: "ATTENDEE_TYPE_UPDATED", entityType: "EventAttendeeType", entityId: typeId,
      correlationId: randomUUID(), summary: `Updated attendee type ${existing.code}.`,
      metadata: { labelChanged: existing.label !== updated.label, activeChanged: existing.isActive !== updated.isActive, productionWrite: false },
    } });
    return updated;
  });
}

export async function createAttendeeClassification(eventId: string, actorUserId: string, rawInput: unknown) {
  const input = attendeeClassificationInputSchema.parse(rawInput);
  try {
    return await getPrisma().$transaction(async (tx) => {
      const created = await tx.eventAttendeeClassification.create({ data: { eventId, ...input } });
      await tx.auditLog.create({ data: {
        eventId, actorUserId, action: "ATTENDEE_CLASSIFICATION_CREATED", entityType: "EventAttendeeClassification", entityId: created.id,
        correlationId: randomUUID(), summary: `Created ${created.kind.toLowerCase()} ${created.code}.`, metadata: { productionWrite: false },
      } });
      return created;
    });
  } catch (error) { return conflict(error); }
}

export async function updateAttendeeClassification(eventId: string, classificationId: string, actorUserId: string, rawInput: unknown) {
  const input = attendeeClassificationUpdateSchema.parse(rawInput);
  const existing = await getPrisma().eventAttendeeClassification.findFirst({ where: { id: classificationId, eventId } });
  if (!existing) throw new AttendeeConfigurationError("NOT_FOUND", "That attendee classification was not found for this event.");
  return getPrisma().$transaction(async (tx) => {
    const updated = await tx.eventAttendeeClassification.update({ where: { id: classificationId }, data: input });
    await tx.auditLog.create({ data: {
      eventId, actorUserId, action: "ATTENDEE_CLASSIFICATION_UPDATED", entityType: "EventAttendeeClassification", entityId: classificationId,
      correlationId: randomUUID(), summary: `Updated ${existing.kind.toLowerCase()} ${existing.code}.`, metadata: { productionWrite: false },
    } });
    return updated;
  });
}

export async function resolveActiveAttendeeType(eventId: string, code: string) {
  return getPrisma().eventAttendeeType.findFirst({ where: { eventId, code, isActive: true } });
}

export async function getAttendeeTypeReference(eventId: string, attendeeId: string) {
  const attendee = await getPrisma().registrationAttendee.findFirst({
    where: { id: attendeeId, eventId },
    select: { attendeeType: true, attendeeTypeDefinition: { select: { id: true, code: true, minimumAge: true, maximumAge: true } } },
  });
  return attendee ? attendeeTypeReference(attendee) : null;
}

export async function assignAttendeeClassifications(eventId: string, attendeeId: string, classificationIds: string[]) {
  const prisma = getPrisma();
  const [attendee, classifications] = await Promise.all([
    prisma.registrationAttendee.findFirst({ where: { id: attendeeId, eventId }, select: { id: true } }),
    prisma.eventAttendeeClassification.findMany({ where: { id: { in: classificationIds }, eventId, isActive: true }, select: { id: true } }),
  ]);
  if (!attendee) throw new AttendeeConfigurationError("NOT_FOUND", "That attendee was not found for this event.");
  if (classifications.length !== new Set(classificationIds).size) {
    throw new AttendeeConfigurationError("CROSS_EVENT_REFERENCE", "Every classification must be active and belong to the attendee's event.");
  }
  await prisma.registrationAttendeeClassification.createMany({
    data: classifications.map(({ id }) => ({ attendeeId, classificationId: id })),
    skipDuplicates: true,
  });
}

export async function backfillAttendeeTypes(eventId: string, apply = false) {
  const prisma = getPrisma();
  const [types, grouped] = await Promise.all([
    prisma.eventAttendeeType.findMany({ where: { eventId }, select: { id: true, code: true, label: true } }),
    prisma.registrationAttendee.groupBy({
      by: ["attendeeType"],
      where: { eventId, attendeeTypeDefinitionId: null },
      _count: { _all: true },
      orderBy: { attendeeType: "asc" },
    }),
  ]);
  const rows = planAttendeeTypeBackfill(types, grouped.map((row) => ({ attendeeType: row.attendeeType, count: row._count._all })));
  let updatedCount = 0;
  if (apply) {
    await prisma.$transaction(async (tx) => {
      const legacyAttendees = await tx.registrationAttendee.findMany({
        where: { eventId, attendeeTypeDefinitionId: null },
        select: { id: true, attendeeType: true },
      });
      for (const row of rows) {
        if (!row.attendeeTypeId) continue;
        const matchingIds = legacyAttendees
          .filter((attendee) => attendee.attendeeType.trim().toLocaleLowerCase("en-US") === row.value.trim().toLocaleLowerCase("en-US"))
          .map((attendee) => attendee.id);
        if (matchingIds.length === 0) continue;
        const result = await tx.registrationAttendee.updateMany({
          where: { id: { in: matchingIds }, eventId, attendeeTypeDefinitionId: null },
          data: { attendeeTypeDefinitionId: row.attendeeTypeId },
        });
        updatedCount += result.count;
      }
    });
  }
  return { eventId, dryRun: !apply, updatedCount, rows };
}
