import "server-only";

import { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import type { HonorImportStep } from "@/modules/honors/catalog-csv";
import { eventHasActiveLocations, offeringSiteId } from "@/modules/honors/locations";
import {
  classSlotConflict,
  normalizeHonorCode,
  normalizeHonorText,
} from "@/modules/honors/domain";
import {
  compareOfferingRows,
  honorSetChange,
  honorsNeedConfirmationMessage,
  joinHonorNames,
  writtenBackRemovalMessage,
  offeringHonorsSelect,
  summarizeOfferingHonors,
} from "@/modules/honors/offering-honors";
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
  | "PICKS_NEED_CONFIRMATION"
  | "HAS_WRITTEN_BACK_COMPLETIONS"
  | "HONORS_NEED_CONFIRMATION"
  | "COPY_SAME_EVENT"
  | "COPY_SOURCE_CHANGED"
  | "EVENT_HAS_TEAMS";

export class HonorConfigurationError extends Error {
  constructor(
    public readonly code: HonorErrorCode,
    message: string,
    /** For a delete refusal: how many class picks the delete would remove. */
    public readonly picks?: number,
  ) {
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
  // Classes that teach this honor, as one of several or alone (#812).
  _count: { select: { offeringHonors: true } },
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
    offeringCount: honor._count.offeringHonors,
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
      select: {
        id: true,
        honorId: true,
        sessionId: true,
        locationId: true,
        span: true,
        capacity: true,
        minimumAge: true,
        minimumClassLevel: true,
        prerequisites: { select: { honor: { select: { id: true, code: true, name: true, isActive: true } } } },
        perClubLimit: true,
        teacherName: true,
        location: true,
        additionalCostCents: true,
        requirementNote: true,
        isActive: true,
        honor: { select: { code: true, name: true, isActive: true } },
        honors: offeringHonorsSelect,
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
    // By the class's honor names in alphabetical order, so reordering a class's honors never moves it (#812).
    offerings: [...offerings].sort(compareOfferingRows).map((offering) => {
      const taught = summarizeOfferingHonors(offering.honors);
      return {
      id: offering.id,
      /** The primary (first) honor, kept for older readers (#812). */
      honorId: offering.honorId,
      /** Every honor the class teaches, in order (#812). */
      honors: taught.honors,
      honorIds: taught.honorIds,
      /** The names and codes joined, standing in for the single honor's. */
      honorCode: taught.honorCode,
      honorName: taught.honorName,
      honorIsActive: taught.honors.every((honor) => honor.isActive),
      sessionId: offering.sessionId,
      locationId: offering.locationId,
      span: offering.span,
      capacity: offering.capacity,
      minimumAge: offering.minimumAge,
      /** The lowest class level (#832) and the honors a youth must have completed first; every one is required. */
      minimumClassLevel: offering.minimumClassLevel,
      prerequisiteHonors: offering.prerequisites.map((row) => row.honor).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
      prerequisiteHonorIds: offering.prerequisites.map((row) => row.honor.id).sort(),
      perClubLimit: offering.perClubLimit,
      teacherName: offering.teacherName,
      location: offering.location,
      additionalCostCents: offering.additionalCostCents,
      requirementNote: offering.requirementNote,
      isActive: offering.isActive,
      seatsTaken: seatsTaken.get(offering.id) ?? 0,
      enrolled: enrolled.get(offering.id) ?? 0,
      };
    }),
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

/**
 * An event where a club can register several teams has no classes (#809): a class is picked once for a club's one
 * registration, so with teams on, nothing here creates, copies or clones one.
 */
export async function requireNoTeams(tx: Pick<Prisma.TransactionClient, "eventTeamSettings">, eventId: string) {
  const settings = await tx.eventTeamSettings.findUnique({ where: { eventId }, select: { allowMultipleTeams: true } });
  if (settings?.allowMultipleTeams) {
    throw new HonorConfigurationError(
      "EVENT_HAS_TEAMS",
      "This event lets a club register several teams, which can't take classes: classes are chosen once for a club's one registration. Turn off teams in the event settings first.",
    );
  }
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
      await requireNoTeams(tx, eventId);
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

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * Removes classes and, with them, the clubs' picks of them (#615). A pick is
 * only ever removed when the caller confirmed the exact count it was shown
 * (`confirmPicks`); a stale or missing confirmation is refused with the live
 * count so the screen can ask again. Picks already written back into members'
 * honor records are never dropped: that would leave the record without its
 * source, so the delete is refused instead. Runs inside the caller's
 * serializable transaction, so a pick saved at the same moment is counted.
 */
async function removeOfferings(
  tx: Prisma.TransactionClient,
  offerings: Array<{ id: string; honorId: string; honorIds: string[] }>,
  confirmPicks: number | undefined,
  what: string,
  /** What to deactivate instead when written-back picks block the delete. */
  instead: string,
) {
  const offeringIds = offerings.map((offering) => offering.id);
  if (offeringIds.length === 0) return { picks: 0, snapshot: emptyDeleteSnapshot };
  // Read before anything is deleted: ids and counts only, for the audit trail.
  const pickRows = await tx.honorEnrollment.findMany({
    where: { offeringId: { in: offeringIds } },
    select: { offeringId: true, organizationId: true },
  });
  const picks = pickRows.length;
  const perOffering = new Map<string, number>();
  const perOrganization = new Map<string, number>();
  for (const row of pickRows) {
    perOffering.set(row.offeringId, (perOffering.get(row.offeringId) ?? 0) + 1);
    // A "Group" registration's picks (#650) have no club; they are in `picks` but name no organization.
    if (row.organizationId) perOrganization.set(row.organizationId, (perOrganization.get(row.organizationId) ?? 0) + 1);
  }
  const snapshot = {
    offerings: offerings.map((offering) => ({ id: offering.id, honorId: offering.honorId, honorIds: offering.honorIds, picks: perOffering.get(offering.id) ?? 0 })),
    organizations: [...perOrganization].map(([organizationId, count]) => ({ organizationId, picks: count })),
  };
  if (picks > 0) {
    // A voided record (#591) no longer holds the pick: voiding adds a void row and never deletes the link.
    const writtenBack = await tx.honorWeekendCompletionLink.count({
      where: { enrollment: { offeringId: { in: offeringIds } }, memberHonorEntry: { void: null } },
    });
    if (writtenBack > 0) {
      throw new HonorConfigurationError(
        "HAS_WRITTEN_BACK_COMPLETIONS",
        `${what} can't be deleted: ${plural(writtenBack, "pick")} already ${writtenBack === 1 ? "was" : "were"} written back into members' honor records. Deactivate ${instead} instead.`,
        picks,
      );
    }
    if (confirmPicks !== picks) {
      throw new HonorConfigurationError(
        "PICKS_NEED_CONFIRMATION",
        `${plural(picks, "class pick")} will be removed from clubs' registrations if you delete ${what}.`,
        picks,
      );
    }
    await tx.honorEnrollment.deleteMany({ where: { offeringId: { in: offeringIds } } });
  }
  await tx.honorOffering.deleteMany({ where: { id: { in: offeringIds } } });
  return { picks, snapshot };
}

const emptyDeleteSnapshot = { offerings: [] as Array<{ id: string; honorId: string; honorIds: string[]; picks: number }>, organizations: [] as Array<{ organizationId: string; picks: number }> };

export async function deleteHonorSession(eventId: string, sessionId: string, actorUserId: string, confirmPicks?: number) {
  await serializable(async (tx) => {
    const session = await tx.honorSession.findFirst({
      where: { id: sessionId, eventId },
      select: { id: true, name: true },
    });
    if (!session) throw new HonorConfigurationError("SESSION_NOT_FOUND", "That session could not be found.");
    const offerings = (await tx.honorOffering.findMany({
      where: { sessionId, eventId },
      select: { id: true, honorId: true, honors: { select: { honorId: true }, orderBy: { position: "asc" } } },
    })).map((offering) => ({ id: offering.id, honorId: offering.honorId, honorIds: offering.honors.map((row) => row.honorId) }));
    const { picks: removedPicks, snapshot } = await removeOfferings(
      tx,
      offerings,
      confirmPicks,
      `the session "${session.name}" and its ${plural(offerings.length, "class")}`,
      "its classes",
    );
    await tx.honorSession.delete({ where: { id: sessionId } });
    await writeAuditLog({
      eventId,
      actorUserId,
      action: "HONOR_SESSION_DELETED",
      entityType: "HonorSession",
      entityId: sessionId,
      summary: `Removed honors session ${session.name} with ${plural(offerings.length, "class")} and ${plural(removedPicks, "pick")}.`,
      metadata: { classes: offerings.length, picksRemoved: removedPicks, ...snapshot },
    }, tx);
  });
  return getEventHonorSetup(eventId);
}

export async function deleteHonorOffering(eventId: string, offeringId: string, actorUserId: string, confirmPicks?: number) {
  await serializable(async (tx) => {
    const offering = await tx.honorOffering.findFirst({
      where: { id: offeringId, eventId },
      select: { id: true, honorId: true, honors: offeringHonorsSelect },
    });
    if (!offering) throw new HonorConfigurationError("OFFERING_NOT_FOUND", "That honor offering could not be found.");
    const taught = summarizeOfferingHonors(offering.honors);
    const { picks: removedPicks, snapshot } = await removeOfferings(
      tx,
      [{ id: offering.id, honorId: offering.honorId, honorIds: taught.honorIds }],
      confirmPicks,
      `the ${taught.honorName} class`,
      "it",
    );
    await writeAuditLog({
      eventId,
      actorUserId,
      action: "HONOR_OFFERING_DELETED",
      entityType: "HonorOffering",
      entityId: offeringId,
      summary: `Removed the ${taught.honorName} offering and ${plural(removedPicks, "pick")}.`,
      metadata: { picksRemoved: removedPicks, ...snapshot },
    }, tx);
  });
  return getEventHonorSetup(eventId);
}

/**
 * The honors a class teaches (#812), each one a real, active catalog honor, in the order given.
 * Names the honor that isn't, so staff know which choice to fix.
 */
async function requireTeachableHonors(
  tx: Prisma.TransactionClient,
  honorIds: readonly string[],
  /** Honors the class already teaches stay allowed when the catalog has since turned them off. */
  alreadyTeaching: ReadonlySet<string> = new Set(),
) {
  const honors = await tx.honor.findMany({ where: { id: { in: [...honorIds] } }, select: { id: true, code: true, name: true, isActive: true } });
  const byId = new Map(honors.map((honor) => [honor.id, honor]));
  return honorIds.map((id) => {
    const honor = byId.get(id);
    if (!honor) throw new HonorConfigurationError("HONOR_NOT_FOUND", "That honor could not be found.");
    if (!honor.isActive && !alreadyTeaching.has(id)) {
      throw new HonorConfigurationError("HONOR_INACTIVE", `${honor.name} is inactive in the catalog.`);
    }
    return honor;
  });
}

/**
 * The prerequisite honors of a class (#832): real catalog honors, none of which the class teaches itself (that
 * would require what it gives). A prerequisite the catalog has since turned off stays allowed on a class that
 * already requires it.
 */
async function requirePrerequisiteHonors(
  tx: Prisma.TransactionClient,
  honorIds: readonly string[],
  teachesHonorIds: readonly string[],
  alreadyRequired: ReadonlySet<string> = new Set(),
) {
  if (honorIds.length === 0) return [];
  const honors = await tx.honor.findMany({ where: { id: { in: [...honorIds] } }, select: { id: true, name: true, isActive: true } });
  const byId = new Map(honors.map((honor) => [honor.id, honor]));
  return honorIds.map((id) => {
    const honor = byId.get(id);
    if (!honor) throw new HonorConfigurationError("HONOR_NOT_FOUND", "That prerequisite honor could not be found.");
    if (teachesHonorIds.includes(id)) {
      throw new HonorConfigurationError("OFFERING_CONFLICT", `${honor.name} is taught by this class, so it can't also be a prerequisite.`);
    }
    if (!honor.isActive && !alreadyRequired.has(id)) {
      throw new HonorConfigurationError("HONOR_INACTIVE", `${honor.name} is inactive in the catalog.`);
    }
    return honor;
  });
}

/** Makes the class's prerequisite rows exactly `honorIds` (#832). */
async function writePrerequisiteRows(tx: Prisma.TransactionClient, offeringId: string, honorIds: readonly string[]) {
  await tx.honorOfferingPrerequisite.deleteMany({ where: { offeringId, honorId: { notIn: [...honorIds] } } });
  const existing = new Set((await tx.honorOfferingPrerequisite.findMany({ where: { offeringId }, select: { honorId: true } })).map((row) => row.honorId));
  const missing = honorIds.filter((id) => !existing.has(id));
  if (missing.length > 0) await tx.honorOfferingPrerequisite.createMany({ data: missing.map((honorId) => ({ offeringId, honorId })) });
}

/** Every other class of the event that teaches any of these honors, for the slot rules. */
async function otherClassesTeaching(tx: Prisma.TransactionClient, eventId: string, honorIds: readonly string[], exceptOfferingId?: string) {
  const others = await tx.honorOffering.findMany({
    where: { eventId, ...(exceptOfferingId ? { id: { not: exceptOfferingId } } : {}), honors: { some: { honorId: { in: [...honorIds] } } } },
    select: {
      span: true,
      sessionId: true,
      locationId: true,
      session: { select: { locationId: true } },
      honors: { select: { honorId: true } },
    },
  });
  return others.map((offering) => ({
    honorIds: offering.honors.map((row) => row.honorId),
    span: offering.span,
    sessionId: offering.sessionId,
    locationId: offeringSiteId(offering),
  }));
}

/**
 * Deletes the honor rows a class no longer teaches. On an edit this runs BEFORE the class row is updated: a move of
 * the class (its session or site) moves every row it still has, so a dropped honor that the destination already
 * teaches would otherwise collide on the way (#812).
 */
async function dropHonorRows(tx: Prisma.TransactionClient, offeringId: string, honorIds: readonly string[]) {
  await tx.honorOfferingHonor.deleteMany({ where: { offeringId, honorId: { notIn: [...honorIds] } } });
}

/** Writes a class's honors in order. A trigger already gave the class its primary (position 0) row on insert. */
export async function writeHonorRows(tx: Prisma.TransactionClient, offeringId: string, eventId: string, honorIds: readonly string[]) {
  const existing = await tx.honorOfferingHonor.findMany({ where: { offeringId }, select: { id: true, honorId: true, position: true } });
  const byHonor = new Map(existing.map((row) => [row.honorId, row]));
  const wanted = new Set(honorIds);
  const dropped = existing.filter((row) => !wanted.has(row.honorId)).map((row) => row.id);
  if (dropped.length > 0) await tx.honorOfferingHonor.deleteMany({ where: { id: { in: dropped } } });
  for (const [position, honorId] of honorIds.entries()) {
    const row = byHonor.get(honorId);
    if (row && row.position !== position) await tx.honorOfferingHonor.update({ where: { id: row.id }, data: { position } });
    if (!row) await tx.honorOfferingHonor.create({ data: { offeringId, honorId, eventId, position } });
  }
}

/** A new class as the screens send it; a caller that sets no minimum level or prerequisites (an older script) gets none (#832). */
export type NewHonorOffering = Omit<HonorOfferingInput, "minimumClassLevel" | "prerequisiteHonorIds"> & Partial<Pick<HonorOfferingInput, "minimumClassLevel" | "prerequisiteHonorIds">>;

export async function createHonorOffering(eventId: string, rawInput: NewHonorOffering, actorUserId: string) {
  const input: HonorOfferingInput = { ...rawInput, minimumClassLevel: rawInput.minimumClassLevel ?? null, prerequisiteHonorIds: rawInput.prerequisiteHonorIds ?? [] };
  try {
    await serializable(async (tx) => {
      await requireEvent(tx, eventId);
      await requireNoTeams(tx, eventId);
      const honors = await requireTeachableHonors(tx, input.honorIds);
      const honorNames = new Map(honors.map((honor) => [honor.id, honor.name]));
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
      const conflict = classSlotConflict(
        { ...input, locationId: input.span === "ALL_SESSIONS" ? locationId : sessionSite },
        await otherClassesTeaching(tx, eventId, input.honorIds),
        (honorId) => honorNames.get(honorId) ?? "",
      );
      if (conflict) throw new HonorConfigurationError("OFFERING_CONFLICT", conflict);

      const { honorIds, prerequisiteHonorIds, ...details } = input;
      await requirePrerequisiteHonors(tx, prerequisiteHonorIds, honorIds);
      const offering = await tx.honorOffering.create({
        data: {
          eventId,
          // The primary honor; a trigger gives it its position-0 row (#812).
          honorId: honorIds[0]!,
          sessionId: details.sessionId,
          locationId,
          span: details.span,
          capacity: details.capacity,
          minimumAge: details.minimumAge,
          minimumClassLevel: details.minimumClassLevel,
          perClubLimit: details.perClubLimit,
          teacherName: details.teacherName,
          location: details.location,
          additionalCostCents: details.additionalCostCents,
          requirementNote: details.requirementNote,
          isActive: details.isActive,
        },
      });
      await writeHonorRows(tx, offering.id, eventId, honorIds);
      await writePrerequisiteRows(tx, offering.id, prerequisiteHonorIds);
      await writeAuditLog({
        eventId,
        actorUserId,
        action: "HONOR_OFFERING_CREATED",
        entityType: "HonorOffering",
        entityId: offering.id,
        summary: `Offered ${joinHonorNames(honors.map((honor) => honor.name))} with ${offering.capacity} youth seats.`,
        metadata: {
          honorId: honorIds[0],
          honorIds,
          span: offering.span,
          sessionId: offering.sessionId,
          capacity: offering.capacity,
          minimumAge: offering.minimumAge,
          minimumClassLevel: offering.minimumClassLevel,
          prerequisiteHonorIds,
          perClubLimit: offering.perClubLimit,
        },
      }, tx);
    });
  } catch (error) {
    if (isUniqueConstraint(error)) {
      throw new HonorConfigurationError("OFFERING_CONFLICT", "One of these honors is already offered in that session.");
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
  try {
    await serializable(async (tx) => {
      const existing = await tx.honorOffering.findFirst({
        where: { id: offeringId, eventId },
        select: { id: true, honorId: true, sessionId: true, span: true, locationId: true, honors: offeringHonorsSelect, prerequisites: { select: { honorId: true } } },
      });
      if (!existing) throw new HonorConfigurationError("OFFERING_NOT_FOUND", "That honor offering could not be found.");
      const current = summarizeOfferingHonors(existing.honors);

      const { honorIds: nextHonorIds, span: nextSpan, sessionId: nextSessionId, locationId: nextSiteInput, confirmEnrolled, prerequisiteHonorIds: nextPrerequisiteIds, ...details } = input;
      const honorIds = nextHonorIds ?? current.honorIds;
      const span = nextSpan ?? existing.span;
      const honorChange = honorSetChange(current.honorIds, honorIds);
      const honorsChanged = honorChange.changed || honorChange.reordered;
      const spanChanged = span !== existing.span;

      // The final placement: an all-sessions class has its own site and no session; a single-session class has a session and takes its site.
      let sessionId: string | null = null;
      let sessionSite: string | null = null;
      if (span === "SINGLE_SESSION") {
        sessionId = nextSessionId !== undefined ? nextSessionId : existing.sessionId;
        if (!sessionId) throw new HonorConfigurationError("SESSION_NOT_FOUND", "Choose the session for this honor.");
        const session = await tx.honorSession.findFirst({ where: { id: sessionId, eventId }, select: { id: true, locationId: true } });
        if (!session) throw new HonorConfigurationError("SESSION_NOT_FOUND", "That session could not be found.");
        sessionSite = session.locationId;
        if (nextSiteInput) {
          throw new HonorConfigurationError("OFFERING_CONFLICT", "A single-session class is at its session's site. Move the session instead.");
        }
      } else if (nextSessionId) {
        throw new HonorConfigurationError("OFFERING_CONFLICT", "An all-sessions honor isn't tied to one session.");
      }
      const locationId = span === "ALL_SESSIONS"
        ? (nextSiteInput !== undefined ? nextSiteInput : existing.span === "ALL_SESSIONS" ? existing.locationId : null)
        : null;
      const sessionChanged = sessionId !== existing.sessionId;
      const siteChanged = locationId !== existing.locationId;

      // An honor the class already teaches stays allowed if the catalog has since turned it off; a new one must be active.
      const honors = honorsChanged ? await requireTeachableHonors(tx, honorIds, new Set(current.honorIds)) : current.honors;
      const honorNames = new Map([...current.honors, ...honors].map((honor) => [honor.id, honor.name]));
      if (span === "ALL_SESSIONS" && (siteChanged || spanChanged)) {
        await requireSessionLocation(tx, eventId, locationId);
        if (!locationId && await eventHasActiveLocations(tx, eventId)) throw siteRequired("all-sessions class");
      }

      if (honorsChanged || spanChanged || sessionChanged || siteChanged) {
        // Clubs that picked this class would be stranded or hold a different class than they chose; nothing is removed silently.
        // Where and when a class is taught is fixed once anyone is enrolled. Which honors it teaches is not (#812): adding
        // one gives the enrollees that honor, removing one takes it from them.
        if ((spanChanged || sessionChanged || siteChanged) && await tx.honorEnrollment.count({ where: { offeringId } }) > 0) {
          throw new HonorConfigurationError(
            "OFFERING_HAS_PICKS",
            siteChanged && !honorChange.changed && !spanChanged && !sessionChanged
              ? "Clubs have already picked this class, so it can't move to another site."
              : "Clubs have already picked this class, so its session or span can't change. Delete it (which removes those picks) or add a new class.",
          );
        }
        // An honor already written back as completed can't be taken off the class: the records name it.
        if (honorChange.removed.length > 0) {
          // Serialize with the write-back, which takes the same lock for the event: it is either finished (its links are
          // seen below) or starts after this edit commits (and reads the class's new honors).
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`honors-weekend-write-back:${eventId}`}))`;
          // Read with a fresh snapshot, not this transaction's: it was taken before the lock was granted, so a write-back
          // that committed while this edit waited would be invisible to it. Once the lock is held none can start.
          // A voided record is ignored, as the write-back ignores it: staff void records first, then remove the honor.
          const recorded = await getPrisma().honorWeekendCompletionLink.groupBy({
            by: ["honorId"],
            where: { honorId: { in: honorChange.removed }, enrollment: { offeringId }, memberHonorEntry: { void: null } },
            _count: { _all: true },
          });
          const first = recorded[0];
          if (first) {
            throw new HonorConfigurationError(
              "HAS_WRITTEN_BACK_COMPLETIONS",
              writtenBackRemovalMessage(honorNames.get(first.honorId) ?? "That honor", first._count._all),
              first._count._all,
            );
          }
        }
        const conflict = classSlotConflict(
          { honorIds, span, sessionId, locationId: span === "ALL_SESSIONS" ? locationId : sessionSite },
          await otherClassesTeaching(tx, eventId, honorIds, offeringId),
          (honorId) => honorNames.get(honorId) ?? "",
        );
        if (conflict) throw new HonorConfigurationError("OFFERING_CONFLICT", conflict);
        // Changing which honors enrolled students take needs the count staff were shown, like a delete does with picks.
        if (honorChange.changed) {
          const enrolled = await tx.honorEnrollment.count({ where: { offeringId } });
          if (enrolled > 0 && confirmEnrolled !== enrolled) {
            throw new HonorConfigurationError(
              "HONORS_NEED_CONFIRMATION",
              honorsNeedConfirmationMessage(enrolled, honors.map((honor) => honor.name)),
              enrolled,
            );
          }
        }
      }

      // The prerequisite honors (#832): checked against the honors the class will teach, and replaced as a set.
      const currentPrerequisiteIds = existing.prerequisites.map((row) => row.honorId);
      const prerequisiteIds = nextPrerequisiteIds ?? currentPrerequisiteIds;
      if (nextPrerequisiteIds !== undefined || honorsChanged) {
        await requirePrerequisiteHonors(tx, prerequisiteIds, honorIds, new Set(currentPrerequisiteIds));
      }

      // Rows the class drops go first, so moving the class can't collide with them; then the class, which carries its
      // remaining rows to its new session or site; then the new and reordered rows.
      if (honorsChanged) await dropHonorRows(tx, offeringId, honorIds);
      await tx.honorOffering.update({
        where: { id: offeringId },
        data: {
          ...details,
          ...(honorIds[0] !== existing.honorId ? { honorId: honorIds[0] } : {}),
          ...(spanChanged ? { span } : {}),
          ...(sessionChanged ? { sessionId } : {}),
          ...(siteChanged ? { locationId } : {}),
        },
      });
      if (honorsChanged) await writeHonorRows(tx, offeringId, eventId, honorIds);
      if (nextPrerequisiteIds !== undefined) await writePrerequisiteRows(tx, offeringId, prerequisiteIds);
      await writeAuditLog({
        eventId,
        actorUserId,
        action: "HONOR_OFFERING_UPDATED",
        entityType: "HonorOffering",
        entityId: offeringId,
        summary: honorsChanged
          ? `Updated the ${current.honorName} offering and changed its honors to ${joinHonorNames(honors.map((honor) => honor.name))}.`
          : `Updated the ${current.honorName} offering.`,
        metadata: { changes: input },
      }, tx);
    });
  } catch (error) {
    // Two classes can't teach the same honor in the same session (the (sessionId, honorId) unique index on HonorOfferingHonor).
    if (isUniqueConstraint(error)) {
      throw new HonorConfigurationError("OFFERING_CONFLICT", "One of these honors is already offered in that session.");
    }
    throw error;
  }
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
