import "server-only";

import { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import {
  normalizeHonorCode,
  normalizeHonorText,
  offeringSlotConflict,
} from "@/modules/honors/domain";
import type {
  HonorInput,
  HonorOfferingInput,
  HonorOfferingUpdate,
  HonorSessionInput,
  HonorSessionUpdate,
  HonorUpdate,
} from "@/modules/honors/schemas";

export type HonorErrorCode =
  | "EVENT_NOT_FOUND"
  | "HONOR_NOT_FOUND"
  | "SESSION_NOT_FOUND"
  | "OFFERING_NOT_FOUND"
  | "HONOR_CODE_CONFLICT"
  | "HONOR_INACTIVE"
  | "SESSION_NAME_CONFLICT"
  | "SESSION_IN_USE"
  | "OFFERING_CONFLICT"
  | "COPY_SAME_EVENT"
  | "COPY_SOURCE_CHANGED";

export class HonorConfigurationError extends Error {
  constructor(public readonly code: HonorErrorCode, message: string) {
    super(message);
    this.name = "HonorConfigurationError";
  }
}

function isUniqueConstraint(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function isSerializationFailure(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
}

/** Serializable so two staff members can't both pass the same conflict check. */
export async function serializable<T>(work: (tx: Prisma.TransactionClient) => Promise<T>) {
  const prisma = getPrisma();
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await prisma.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (!isSerializationFailure(error) || attempt === 2) throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Catalog (global; system administrators)

const honorSelect = {
  id: true,
  code: true,
  name: true,
  description: true,
  isActive: true,
  updatedAt: true,
  _count: { select: { offerings: true } },
} satisfies Prisma.HonorSelect;

function serializeHonor(honor: Prisma.HonorGetPayload<{ select: typeof honorSelect }>) {
  return {
    id: honor.id,
    code: honor.code,
    name: honor.name,
    description: honor.description,
    isActive: honor.isActive,
    offeringCount: honor._count.offerings,
    updatedAt: honor.updatedAt.toISOString(),
  };
}

export type HonorRecord = ReturnType<typeof serializeHonor>;

export async function listHonors() {
  const honors = await getPrisma().honor.findMany({
    select: honorSelect,
    orderBy: [{ name: "asc" }, { code: "asc" }],
  });
  return honors.map(serializeHonor);
}

const codeConflict = () => new HonorConfigurationError(
  "HONOR_CODE_CONFLICT",
  "Another honor already uses that code.",
);

export async function createHonor(input: HonorInput, actorUserId: string) {
  try {
    await getPrisma().$transaction(async (tx) => {
      const honor = await tx.honor.create({
        data: {
          code: normalizeHonorCode(input.code),
          name: input.name,
          normalizedName: normalizeHonorText(input.name),
          description: input.description,
          isActive: input.isActive,
        },
      });
      await writeAuditLog({
        actorUserId,
        action: "HONOR_CREATED",
        entityType: "Honor",
        entityId: honor.id,
        summary: `Added ${honor.name} (${honor.code}) to the honor catalog.`,
      }, tx);
    });
  } catch (error) {
    if (isUniqueConstraint(error)) throw codeConflict();
    throw error;
  }
  return listHonors();
}

export async function updateHonor(honorId: string, input: HonorUpdate, actorUserId: string) {
  try {
    await getPrisma().$transaction(async (tx) => {
      const existing = await tx.honor.findUnique({ where: { id: honorId }, select: { id: true } });
      if (!existing) {
        throw new HonorConfigurationError("HONOR_NOT_FOUND", "That honor could not be found.");
      }
      const honor = await tx.honor.update({
        where: { id: honorId },
        data: {
          ...(input.code === undefined ? {} : { code: normalizeHonorCode(input.code) }),
          ...(input.name === undefined ? {} : { name: input.name, normalizedName: normalizeHonorText(input.name) }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
        },
      });
      await writeAuditLog({
        actorUserId,
        action: "HONOR_UPDATED",
        entityType: "Honor",
        entityId: honor.id,
        summary: `Updated ${honor.name} (${honor.code}) in the honor catalog.`,
        metadata: { fields: Object.keys(input) },
      }, tx);
    });
  } catch (error) {
    if (isUniqueConstraint(error)) throw codeConflict();
    throw error;
  }
  return listHonors();
}

// ---------------------------------------------------------------------------
// Sessions and offerings (per event; CONFIGURE_EVENT)

async function loadEventHonorSetup(client: Prisma.TransactionClient, eventId: string) {
  const [sessions, offerings, enrollmentCounts] = await Promise.all([
    client.honorSession.findMany({
      where: { eventId },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true, sortOrder: true, _count: { select: { offerings: true } } },
    }),
    client.honorOffering.findMany({
      where: { eventId },
      orderBy: [{ honor: { name: "asc" } }],
      select: {
        id: true,
        honorId: true,
        sessionId: true,
        span: true,
        capacity: true,
        minimumAge: true,
        perClubLimit: true,
        teacherName: true,
        location: true,
        isActive: true,
        honor: { select: { code: true, name: true, isActive: true } },
      },
    }),
    client.honorEnrollment.groupBy({
      by: ["offeringId", "consumesSeat"],
      // Cancelled club registrations give their seats back (see seatHoldingEnrollment).
      where: { eventId, registration: { status: { in: ["SUBMITTED", "CONFIRMED"] } } },
      _count: { _all: true },
    }),
  ]);
  const seatsTaken = new Map<string, number>();
  const enrolled = new Map<string, number>();
  for (const row of enrollmentCounts) {
    enrolled.set(row.offeringId, (enrolled.get(row.offeringId) ?? 0) + row._count._all);
    if (row.consumesSeat) seatsTaken.set(row.offeringId, row._count._all);
  }
  return {
    sessions: sessions.map((session) => ({
      id: session.id,
      name: session.name,
      sortOrder: session.sortOrder,
      offeringCount: session._count.offerings,
    })),
    offerings: offerings.map((offering) => ({
      id: offering.id,
      honorId: offering.honorId,
      honorCode: offering.honor.code,
      honorName: offering.honor.name,
      honorIsActive: offering.honor.isActive,
      sessionId: offering.sessionId,
      span: offering.span,
      capacity: offering.capacity,
      minimumAge: offering.minimumAge,
      perClubLimit: offering.perClubLimit,
      teacherName: offering.teacherName,
      location: offering.location,
      isActive: offering.isActive,
      seatsTaken: seatsTaken.get(offering.id) ?? 0,
      enrolled: enrolled.get(offering.id) ?? 0,
    })),
  };
}

export type EventHonorSetup = Awaited<ReturnType<typeof loadEventHonorSetup>>;

export async function getEventHonorSetup(eventId: string) {
  return loadEventHonorSetup(getPrisma(), eventId);
}

async function requireEvent(tx: Prisma.TransactionClient, eventId: string) {
  const event = await tx.event.findUnique({ where: { id: eventId }, select: { id: true, name: true } });
  if (!event) throw new HonorConfigurationError("EVENT_NOT_FOUND", "That event could not be found.");
  return event;
}

const sessionNameConflict = () => new HonorConfigurationError(
  "SESSION_NAME_CONFLICT",
  "This site already has a session with that name.",
);

export async function createHonorSession(eventId: string, input: HonorSessionInput, actorUserId: string) {
  try {
    await getPrisma().$transaction(async (tx) => {
      await requireEvent(tx, eventId);
      const session = await tx.honorSession.create({
        data: {
          eventId,
          name: input.name,
          normalizedName: normalizeHonorText(input.name),
          sortOrder: input.sortOrder,
        },
      });
      await writeAuditLog({
        eventId,
        actorUserId,
        action: "HONOR_SESSION_CREATED",
        entityType: "HonorSession",
        entityId: session.id,
        summary: `Added honors session ${session.name}.`,
      }, tx);
    });
  } catch (error) {
    if (isUniqueConstraint(error)) throw sessionNameConflict();
    throw error;
  }
  return getEventHonorSetup(eventId);
}

export async function updateHonorSession(
  eventId: string,
  sessionId: string,
  input: HonorSessionUpdate,
  actorUserId: string,
) {
  try {
    await getPrisma().$transaction(async (tx) => {
      const existing = await tx.honorSession.findFirst({ where: { id: sessionId, eventId }, select: { id: true } });
      if (!existing) throw new HonorConfigurationError("SESSION_NOT_FOUND", "That session could not be found.");
      const session = await tx.honorSession.update({
        where: { id: sessionId },
        data: {
          ...(input.name === undefined ? {} : { name: input.name, normalizedName: normalizeHonorText(input.name) }),
          ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
        },
      });
      await writeAuditLog({
        eventId,
        actorUserId,
        action: "HONOR_SESSION_UPDATED",
        entityType: "HonorSession",
        entityId: session.id,
        summary: `Updated honors session ${session.name}.`,
      }, tx);
    });
  } catch (error) {
    if (isUniqueConstraint(error)) throw sessionNameConflict();
    throw error;
  }
  return getEventHonorSetup(eventId);
}

export async function deleteHonorSession(eventId: string, sessionId: string, actorUserId: string) {
  await getPrisma().$transaction(async (tx) => {
    const session = await tx.honorSession.findFirst({
      where: { id: sessionId, eventId },
      select: { id: true, name: true, _count: { select: { offerings: true } } },
    });
    if (!session) throw new HonorConfigurationError("SESSION_NOT_FOUND", "That session could not be found.");
    if (session._count.offerings > 0) {
      throw new HonorConfigurationError(
        "SESSION_IN_USE",
        "This session still has honors in it. Move or deactivate them before removing the session.",
      );
    }
    await tx.honorSession.delete({ where: { id: sessionId } });
    await writeAuditLog({
      eventId,
      actorUserId,
      action: "HONOR_SESSION_DELETED",
      entityType: "HonorSession",
      entityId: sessionId,
      summary: `Removed empty honors session ${session.name}.`,
    }, tx);
  });
  return getEventHonorSetup(eventId);
}

export async function createHonorOffering(eventId: string, input: HonorOfferingInput, actorUserId: string) {
  try {
    await serializable(async (tx) => {
      await requireEvent(tx, eventId);
      const honor = await tx.honor.findUnique({
        where: { id: input.honorId },
        select: { id: true, name: true, isActive: true },
      });
      if (!honor) throw new HonorConfigurationError("HONOR_NOT_FOUND", "That honor could not be found.");
      if (!honor.isActive) {
        throw new HonorConfigurationError("HONOR_INACTIVE", "That honor is inactive in the catalog.");
      }
      if (input.sessionId) {
        const session = await tx.honorSession.findFirst({
          where: { id: input.sessionId, eventId },
          select: { id: true },
        });
        if (!session) throw new HonorConfigurationError("SESSION_NOT_FOUND", "That session could not be found.");
      }
      const existing = await tx.honorOffering.findMany({
        where: { eventId, honorId: input.honorId },
        select: { honorId: true, span: true, sessionId: true },
      });
      const conflict = offeringSlotConflict(input, existing);
      if (conflict) throw new HonorConfigurationError("OFFERING_CONFLICT", conflict);

      const offering = await tx.honorOffering.create({
        data: {
          eventId,
          honorId: input.honorId,
          sessionId: input.sessionId,
          span: input.span,
          capacity: input.capacity,
          minimumAge: input.minimumAge,
          perClubLimit: input.perClubLimit,
          teacherName: input.teacherName,
          location: input.location,
          isActive: input.isActive,
        },
      });
      await writeAuditLog({
        eventId,
        actorUserId,
        action: "HONOR_OFFERING_CREATED",
        entityType: "HonorOffering",
        entityId: offering.id,
        summary: `Offered ${honor.name} with ${offering.capacity} youth seats.`,
        metadata: {
          honorId: honor.id,
          span: offering.span,
          sessionId: offering.sessionId,
          capacity: offering.capacity,
          minimumAge: offering.minimumAge,
          perClubLimit: offering.perClubLimit,
        },
      }, tx);
    });
  } catch (error) {
    if (isUniqueConstraint(error)) {
      throw new HonorConfigurationError("OFFERING_CONFLICT", "This honor is already offered in that session.");
    }
    throw error;
  }
  return getEventHonorSetup(eventId);
}

export async function updateHonorOffering(
  eventId: string,
  offeringId: string,
  input: HonorOfferingUpdate,
  actorUserId: string,
) {
  await getPrisma().$transaction(async (tx) => {
    const existing = await tx.honorOffering.findFirst({
      where: { id: offeringId, eventId },
      select: { id: true, honor: { select: { name: true } } },
    });
    if (!existing) throw new HonorConfigurationError("OFFERING_NOT_FOUND", "That honor offering could not be found.");
    await tx.honorOffering.update({ where: { id: offeringId }, data: input });
    await writeAuditLog({
      eventId,
      actorUserId,
      action: "HONOR_OFFERING_UPDATED",
      entityType: "HonorOffering",
      entityId: offeringId,
      summary: `Updated the ${existing.honor.name} offering.`,
      metadata: { changes: input },
    }, tx);
  });
  return getEventHonorSetup(eventId);
}
