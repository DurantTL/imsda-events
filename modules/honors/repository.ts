import "server-only";

import { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import type { HonorImportStep } from "@/modules/honors/catalog-csv";
import { eventHasActiveLocations, offeringSiteId } from "@/modules/honors/locations";
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
  | "LOCATION_NOT_FOUND"
  | "LOCATION_REQUIRED"
  | "SESSION_HAS_PICKS"
  | "OFFERING_HAS_PICKS"
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
  catalogNumber: true,
  category: true,
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
    catalogNumber: honor.catalogNumber,
    category: honor.category,
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
  const [sessions, offerings, enrollmentCounts, locations] = await Promise.all([
    client.honorSession.findMany({
      where: { eventId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { name: "asc" }],
      select: { id: true, name: true, locationId: true, sortOrder: true, createdAt: true, _count: { select: { offerings: true } } },
    }),
    client.honorOffering.findMany({
      where: { eventId },
      orderBy: [{ honor: { name: "asc" } }],
      select: {
        id: true,
        honorId: true,
        sessionId: true,
        locationId: true,
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
    client.eventLocation.findMany({
      where: { eventId },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true, sortOrder: true, isActive: true },
    }),
  ]);
  const seatsTaken = new Map<string, number>();
  const enrolled = new Map<string, number>();
  for (const row of enrollmentCounts) {
    enrolled.set(row.offeringId, (enrolled.get(row.offeringId) ?? 0) + row._count._all);
    if (row.consumesSeat) seatsTaken.set(row.offeringId, row._count._all);
  }
  return {
    locations,
    sessions: sessions.map((session) => ({
      id: session.id,
      name: session.name,
      locationId: session.locationId,
      sortOrder: session.sortOrder,
      createdAt: session.createdAt,
      offeringCount: session._count.offerings,
      activeOfferingCount: offerings.filter((offering) => offering.sessionId === session.id && offering.isActive).length,
    })),
    offerings: offerings.map((offering) => ({
      id: offering.id,
      honorId: offering.honorId,
      honorCode: offering.honor.code,
      honorName: offering.honor.name,
      honorIsActive: offering.honor.isActive,
      sessionId: offering.sessionId,
      locationId: offering.locationId,
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

/** The site must belong to this event (#589). Null is always allowed: a session no site owns. */
async function requireSessionLocation(tx: Prisma.TransactionClient, eventId: string, locationId: string | null | undefined) {
  if (!locationId) return;
  const location = await tx.eventLocation.findFirst({ where: { id: locationId, eventId }, select: { id: true } });
  if (!location) throw new HonorConfigurationError("LOCATION_NOT_FOUND", "That site could not be found for this event.");
}

/** With active locations, a session or all-sessions class must say which site it is at (#589). */
const siteRequired = (what: "session" | "all-sessions class") => new HonorConfigurationError(
  "LOCATION_REQUIRED",
  `Choose the site for this ${what}.`,
);

const sessionNameConflict = () => new HonorConfigurationError(
  "SESSION_NAME_CONFLICT",
  "This site already has a session with that name.",
);

export async function createHonorSession(eventId: string, input: HonorSessionInput, actorUserId: string) {
  try {
    await getPrisma().$transaction(async (tx) => {
      await requireEvent(tx, eventId);
      await requireSessionLocation(tx, eventId, input.locationId);
      if (!input.locationId && await eventHasActiveLocations(tx, eventId)) throw siteRequired("session");
      const session = await tx.honorSession.create({
        data: {
          eventId,
          locationId: input.locationId,
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
    // Serializable, so a class pick saved at the same moment can't slip past the count below (#589).
    await serializable(async (tx) => {
      const existing = await tx.honorSession.findFirst({ where: { id: sessionId, eventId }, select: { id: true, locationId: true } });
      if (!existing) throw new HonorConfigurationError("SESSION_NOT_FOUND", "That session could not be found.");
      if (input.locationId !== undefined && input.locationId !== existing.locationId) {
        await requireSessionLocation(tx, eventId, input.locationId);
        if (!input.locationId && await eventHasActiveLocations(tx, eventId)) throw siteRequired("session");
        // Moving a session to another site would strand clubs that picked its
        // classes at the old one; nothing is removed silently (#589).
        const picks = await tx.honorEnrollment.count({ where: { offering: { sessionId } } });
        if (picks > 0) {
          throw new HonorConfigurationError(
            "SESSION_HAS_PICKS",
            "Clubs have already picked classes in this session, so it can't move to another site.",
          );
        }
      }
      const session = await tx.honorSession.update({
        where: { id: sessionId },
        data: {
          ...(input.locationId === undefined ? {} : { locationId: input.locationId }),
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
      let sessionSite: string | null = null;
      if (input.sessionId) {
        const session = await tx.honorSession.findFirst({
          where: { id: input.sessionId, eventId },
          select: { id: true, locationId: true },
        });
        if (!session) throw new HonorConfigurationError("SESSION_NOT_FOUND", "That session could not be found.");
        sessionSite = session.locationId;
      }
      // An all-sessions class has its own site; a single-session class takes its session's (#589).
      let locationId: string | null = null;
      if (input.span === "ALL_SESSIONS") {
        await requireSessionLocation(tx, eventId, input.locationId);
        if (!input.locationId && await eventHasActiveLocations(tx, eventId)) throw siteRequired("all-sessions class");
        locationId = input.locationId;
      }
      const existing = await tx.honorOffering.findMany({
        where: { eventId, honorId: input.honorId },
        select: { honorId: true, span: true, sessionId: true, locationId: true, session: { select: { locationId: true } } },
      });
      const conflict = offeringSlotConflict(
        { ...input, locationId: input.span === "ALL_SESSIONS" ? locationId : sessionSite },
        existing.map((offering) => ({ ...offering, locationId: offeringSiteId(offering) })),
      );
      if (conflict) throw new HonorConfigurationError("OFFERING_CONFLICT", conflict);

      const offering = await tx.honorOffering.create({
        data: {
          eventId,
          honorId: input.honorId,
          sessionId: input.sessionId,
          locationId,
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
  // Serializable, so a class pick saved at the same moment can't slip past the pick count on a site move (#589).
  await serializable(async (tx) => {
    const existing = await tx.honorOffering.findFirst({
      where: { id: offeringId, eventId },
      select: { id: true, honorId: true, span: true, locationId: true, honor: { select: { name: true } } },
    });
    if (!existing) throw new HonorConfigurationError("OFFERING_NOT_FOUND", "That honor offering could not be found.");
    if (input.locationId !== undefined && input.locationId !== existing.locationId) {
      if (existing.span !== "ALL_SESSIONS") {
        throw new HonorConfigurationError("OFFERING_CONFLICT", "A single-session class is at its session's site. Move the session instead.");
      }
      await requireSessionLocation(tx, eventId, input.locationId);
      if (!input.locationId && await eventHasActiveLocations(tx, eventId)) throw siteRequired("all-sessions class");
      // Clubs that picked this class at its site would be stranded; nothing is removed silently.
      if (await tx.honorEnrollment.count({ where: { offeringId } }) > 0) {
        throw new HonorConfigurationError("OFFERING_HAS_PICKS", "Clubs have already picked this class, so it can't move to another site.");
      }
      const others = await tx.honorOffering.findMany({
        where: { eventId, honorId: existing.honorId, id: { not: offeringId } },
        select: { honorId: true, span: true, sessionId: true, locationId: true, session: { select: { locationId: true } } },
      });
      const conflict = offeringSlotConflict(
        { honorId: existing.honorId, span: "ALL_SESSIONS", sessionId: null, locationId: input.locationId },
        others.map((offering) => ({ ...offering, locationId: offeringSiteId(offering) })),
      );
      if (conflict) throw new HonorConfigurationError("OFFERING_CONFLICT", conflict);
    }
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

/**
 * Applies a planned honor CSV import (#385) in one transaction: the catalog
 * is shared by every site, so it changes all at once or not at all.
 * Audited with counts.
 */
export async function applyHonorImport(steps: readonly HonorImportStep[], actorUserId: string) {
  const adds = steps.filter((step) => step.action === "ADD");
  const updates = steps.filter((step) => step.action === "UPDATE" && step.honorId);
  try {
    await getPrisma().$transaction(async (tx) => {
      if (adds.length > 0) {
        await tx.honor.createMany({
          data: adds.map(({ row }) => ({
            code: row.code,
            name: row.name,
            normalizedName: normalizeHonorText(row.name),
            description: row.description ?? "",
            isActive: row.isActive ?? true,
            catalogNumber: row.catalogNumber ?? null,
            category: row.category ?? null,
          })),
        });
      }
      for (const { row, honorId } of updates) {
        await tx.honor.update({
          where: { id: honorId! },
          data: {
            name: row.name,
            normalizedName: normalizeHonorText(row.name),
            ...(row.description === undefined ? {} : { description: row.description }),
            ...(row.isActive === undefined ? {} : { isActive: row.isActive }),
            ...(row.catalogNumber === undefined ? {} : { catalogNumber: row.catalogNumber }),
            ...(row.category === undefined ? {} : { category: row.category }),
          },
        });
      }
      await writeAuditLog({
        actorUserId,
        action: "HONOR_CATALOG_IMPORTED",
        entityType: "Honor",
        summary: `Imported the honor catalog: ${adds.length} added, ${updates.length} updated.`,
        metadata: { rows: steps.length, added: adds.length, updated: updates.length, skipped: steps.length - adds.length - updates.length },
      }, tx);
    });
  } catch (error) {
    if (isUniqueConstraint(error)) throw codeConflict();
    throw error;
  }
  return { added: adds.length, updated: updates.length, honors: await listHonors() };
}
