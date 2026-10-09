import "server-only";

import { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { classSlotConflict, normalizeHonorText } from "@/modules/honors/domain";
import { eventHasActiveLocations, offeringSiteId } from "@/modules/honors/locations";
import { joinHonorNames, offeringHonorsSelect, summarizeOfferingHonors } from "@/modules/honors/offering-honors";
import { HonorConfigurationError, assertRoomPlacement, getEventHonorSetup, serializable } from "@/modules/honors/repository";
import { type BoardCard, type BoardInstructor, type ScheduleBoardData, moveConflictMessage } from "@/modules/honors/schedule-board";
import { isRoomBookedIndex, isRoomCapacityRefusal, isSerializationFailure } from "@/modules/honors/room-errors";
import type { HonorMoveInput, HonorRoomInput, HonorRoomUpdate } from "@/modules/honors/schedule-schemas";

/**
 * Honors Weekend schedule board (#834): rooms inside a site, and moving a class
 * to another room or session. Event configuration (CONFIGURE_EVENT) only; the
 * routes check that before calling in here.
 */

type Tx = Prisma.TransactionClient;

/**
 * EXTENSION POINT (#833): the instructors assigned to each class, keyed by class id.
 *
 * Instructor assignments are built on a separate branch (#833). Until its tables exist on
 * this base this returns no instructors, so cards fall back to the class's free-text
 * `teacherName` and no instructor clash is ever flagged. When #833 lands, read its
 * assignment table here and return `{ id, name }` per class (the person's id and display
 * name only); the board, the card and `instructorClashes` need no other change.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function loadOfferingInstructors(_client: Tx | ReturnType<typeof getPrisma>, _eventId: string): Promise<Map<string, BoardInstructor[]>> {
  return new Map();
}

export async function getScheduleBoard(eventId: string): Promise<ScheduleBoardData> {
  const prisma = getPrisma();
  const [setup, rooms, instructors] = await Promise.all([
    getEventHonorSetup(eventId),
    prisma.honorRoom.findMany({ where: { eventId }, select: { id: true, name: true, capacity: true, locationId: true, sortOrder: true } }),
    loadOfferingInstructors(prisma, eventId),
  ]);
  const sessionSite = new Map(setup.sessions.map((session) => [session.id, session.locationId]));
  const cards: BoardCard[] = setup.offerings.map((offering) => ({
    id: offering.id,
    title: offering.honorName,
    span: offering.span,
    sessionId: offering.sessionId,
    siteId: offeringSiteId({ span: offering.span, locationId: offering.locationId, session: offering.sessionId ? { locationId: sessionSite.get(offering.sessionId) ?? null } : null }),
    roomId: offering.roomId,
    capacity: offering.capacity,
    seatsTaken: offering.seatsTaken,
    enrolled: offering.enrolled,
    isActive: offering.isActive,
    teacherName: offering.teacherName,
    instructors: instructors.get(offering.id) ?? [],
  }));
  return {
    sites: setup.locations.map((site) => ({ id: site.id, name: site.name, isActive: site.isActive, sortOrder: site.sortOrder })),
    sessions: setup.sessions.map((session) => ({ id: session.id, name: session.name, locationId: session.locationId, sortOrder: session.sortOrder })),
    rooms,
    cards,
  };
}

const roomNameConflict = () => new HonorConfigurationError("ROOM_NAME_CONFLICT", "This site already has a room with that name.");

/** Retries ran out because someone changed the same rows at the same moment (a pick, another move): ask to try again. */
function busy(error: unknown) {
  return isSerializationFailure(error)
    ? new HonorConfigurationError("SCHEDULE_BUSY", "Someone changed the schedule or the class picks at the same moment. Nothing was changed; please try again.")
    : error;
}

function isUniqueConstraint(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export async function createHonorRoom(eventId: string, input: HonorRoomInput, actorUserId: string) {
  try {
    await serializable(async (tx) => {
      const event = await tx.event.findUnique({ where: { id: eventId }, select: { id: true } });
      if (!event) throw new HonorConfigurationError("EVENT_NOT_FOUND", "That event could not be found.");
      if (input.locationId) {
        const site = await tx.eventLocation.findFirst({ where: { id: input.locationId, eventId }, select: { id: true } });
        if (!site) throw new HonorConfigurationError("LOCATION_NOT_FOUND", "That site could not be found for this event.");
      } else if (await eventHasActiveLocations(tx, eventId)) {
        throw new HonorConfigurationError("LOCATION_REQUIRED", "Choose the site for this room.");
      }
      const room = await tx.honorRoom.create({
        data: { eventId, locationId: input.locationId, name: input.name, normalizedName: normalizeHonorText(input.name), capacity: input.capacity, sortOrder: input.sortOrder },
      });
      await writeAuditLog({
        eventId, actorUserId, action: "HONOR_ROOM_CREATED", entityType: "HonorRoom", entityId: room.id,
        summary: `Added room ${room.name} seating ${room.capacity}.`,
      }, tx);
    });
  } catch (error) {
    if (isUniqueConstraint(error)) throw roomNameConflict();
    throw error;
  }
  return getScheduleBoard(eventId);
}

export async function updateHonorRoom(eventId: string, roomId: string, input: HonorRoomUpdate, actorUserId: string) {
  try {
    await serializable(async (tx) => {
      const room = await tx.honorRoom.findFirst({ where: { id: roomId, eventId }, select: { id: true, name: true, capacity: true } });
      if (!room) throw new HonorConfigurationError("ROOM_NOT_FOUND", "That room could not be found.");
      if (input.capacity !== undefined && input.capacity < room.capacity) {
        const over = await tx.honorOffering.count({ where: { roomId, capacity: { gt: input.capacity } } });
        if (over > 0) {
          throw new HonorConfigurationError(
            "ROOM_TOO_SMALL",
            `${over === 1 ? "A class in" : `${over} classes in`} ${room.name} ${over === 1 ? "has" : "have"} more than ${input.capacity} seats. Lower the class seats first.`,
            over,
          );
        }
      }
      const name = input.name ?? room.name;
      await tx.honorRoom.update({
        where: { id: roomId },
        data: {
          ...(input.name === undefined ? {} : { name: input.name, normalizedName: normalizeHonorText(input.name) }),
          ...(input.capacity === undefined ? {} : { capacity: input.capacity }),
          ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
        },
      });
      // The class's free-text room mirrors the room's name while it is placed there.
      if (input.name !== undefined && input.name !== room.name) {
        // Only text that is empty or is the old room name follows the rename; a different note staff wrote stays.
        await tx.honorOffering.updateMany({ where: { roomId, location: { in: ["", room.name] } }, data: { location: name } });
      }
      await writeAuditLog({
        eventId, actorUserId, action: "HONOR_ROOM_UPDATED", entityType: "HonorRoom", entityId: roomId,
        summary: `Updated room ${name}.`, metadata: { changes: input },
      }, tx);
    });
  } catch (error) {
    if (isUniqueConstraint(error)) throw roomNameConflict();
    if (isRoomCapacityRefusal(error)) throw new HonorConfigurationError("ROOM_TOO_SMALL", "A class placed in this room has more seats than that. Lower the class seats first.");
    throw busy(error);
  }
  return getScheduleBoard(eventId);
}

export async function deleteHonorRoom(eventId: string, roomId: string, actorUserId: string) {
  await serializable(async (tx) => {
    const room = await tx.honorRoom.findFirst({ where: { id: roomId, eventId }, select: { id: true, name: true } });
    if (!room) throw new HonorConfigurationError("ROOM_NOT_FOUND", "That room could not be found.");
    const classes = await tx.honorOffering.count({ where: { roomId } });
    if (classes > 0) {
      throw new HonorConfigurationError(
        "ROOM_IN_USE",
        `${room.name} has ${classes} ${classes === 1 ? "class" : "classes"} placed in it. Move ${classes === 1 ? "it" : "them"} to another room first.`,
        classes,
      );
    }
    await tx.honorRoom.delete({ where: { id: roomId } });
    await writeAuditLog({
      eventId, actorUserId, action: "HONOR_ROOM_DELETED", entityType: "HonorRoom", entityId: roomId,
      summary: `Removed room ${room.name}.`,
    }, tx);
  });
  return getScheduleBoard(eventId);
}

/**
 * Moves a class to another room and/or session (#834). A room-only move leaves
 * `sessionId` out. Everything is decided inside one serializable transaction
 * that first locks the class row (the same row a club's class pick locks), so a
 * move and a pick at the same moment run one after the other or one retries:
 *
 *  - an all-sessions class only changes room, within its own site;
 *  - a class people are enrolled in never changes site (clubs picked it for
 *    their site), and never moves into a session where an enrolled person
 *    already holds another class: the move is BLOCKED (not confirmable) with
 *    the number of people in conflict, so nobody is double-booked or dropped;
 *  - the room must be at the class's site, seat at least the class's seats, and
 *    be free then (one active class per room and session);
 *  - a move never changes seats or enrollments, so it can't overfill a class;
 *  - the honor uniqueness rules (docs/MULTI-HONOR-CLASSES.md) hold: no honor of
 *    the class twice in the destination session.
 */
export async function moveHonorOffering(eventId: string, offeringId: string, input: HonorMoveInput, actorUserId: string) {
  try {
    await serializable(async (tx) => {
      // Lock the class like a club's pick does, then read it.
      await tx.$queryRaw`SELECT id FROM "HonorOffering" WHERE id = ${offeringId} AND "eventId" = ${eventId} FOR UPDATE`;
      const existing = await tx.honorOffering.findFirst({
        where: { id: offeringId, eventId },
        select: {
          id: true, span: true, sessionId: true, locationId: true, roomId: true, capacity: true, isActive: true, location: true,
          room: { select: { name: true } },
          honors: offeringHonorsSelect,
          session: { select: { name: true, locationId: true } },
        },
      });
      if (!existing) throw new HonorConfigurationError("OFFERING_NOT_FOUND", "That honor offering could not be found.");
      const taught = summarizeOfferingHonors(existing.honors);

      let sessionId = existing.sessionId;
      let sessionName = existing.session?.name ?? "";
      let siteId = offeringSiteId(existing);
      if (existing.span === "ALL_SESSIONS") {
        if (input.sessionId) throw new HonorConfigurationError("MOVE_INVALID", "An all-sessions class isn't tied to one session. Move it to another room instead.");
      } else if (input.sessionId !== undefined) {
        if (!input.sessionId) throw new HonorConfigurationError("MOVE_INVALID", "Choose the session to move the class to.");
        const session = await tx.honorSession.findFirst({ where: { id: input.sessionId, eventId }, select: { id: true, name: true, locationId: true } });
        if (!session) throw new HonorConfigurationError("SESSION_NOT_FOUND", "That session could not be found.");
        sessionId = session.id;
        sessionName = session.name;
        siteId = session.locationId;
      }
      const sessionChanged = sessionId !== existing.sessionId;
      const siteChanged = siteId !== offeringSiteId(existing);
      const roomChanged = input.roomId !== existing.roomId;
      if (!sessionChanged && !roomChanged) return;

      const enrolled = sessionChanged ? await tx.honorEnrollment.count({ where: { offeringId } }) : 0;
      if (siteChanged && enrolled > 0) {
        throw new HonorConfigurationError("OFFERING_HAS_PICKS", "Clubs have already picked this class, so it can't move to another site.", enrolled);
      }
      if (input.roomId) {
        await assertRoomPlacement(tx, {
          eventId, roomId: input.roomId, offeringId, span: existing.span, sessionId, siteId,
          capacity: existing.capacity, isActive: existing.isActive,
        });
      }
      if (sessionChanged) {
        const others = await tx.honorOffering.findMany({
          where: { eventId, id: { not: offeringId }, honors: { some: { honorId: { in: taught.honorIds } } } },
          select: { span: true, sessionId: true, locationId: true, session: { select: { locationId: true } }, honors: { select: { honorId: true } } },
        });
        const honorNames = new Map(taught.honors.map((honor) => [honor.id, honor.name]));
        const conflict = classSlotConflict(
          { honorIds: taught.honorIds, span: existing.span, sessionId, locationId: siteId },
          others.map((other) => ({ honorIds: other.honors.map((row) => row.honorId), span: other.span, sessionId: other.sessionId, locationId: offeringSiteId(other) })),
          (honorId) => honorNames.get(honorId) ?? "",
        );
        if (conflict) throw new HonorConfigurationError("OFFERING_CONFLICT", conflict);

        if (enrolled > 0) {
          // People who hold a live pick in this class and another class in the destination session. Cancelled registrations hold nothing.
          const people = await tx.honorEnrollment.findMany({
            where: { offeringId, registration: { status: { in: ["SUBMITTED", "CONFIRMED"] } } },
            select: { registrationAttendeeId: true },
          });
          const clashing = await tx.honorEnrollment.findMany({
            where: {
              registrationAttendeeId: { in: people.map((row) => row.registrationAttendeeId) },
              offeringId: { not: offeringId },
              registration: { status: { in: ["SUBMITTED", "CONFIRMED"] } },
              offering: { sessionId },
            },
            select: { registrationAttendeeId: true },
          });
          const conflicts = new Set(clashing.map((row) => row.registrationAttendeeId)).size;
          if (conflicts > 0) {
            throw new HonorConfigurationError("MOVE_HAS_CONFLICTS", moveConflictMessage(taught.honorName, sessionName, conflicts), undefined, { conflicts });
          }
        }
      }

      const room = input.roomId ? await tx.honorRoom.findUnique({ where: { id: input.roomId }, select: { name: true } }) : null;
      // The free-text room mirrors the room's name, but only text that is empty or was the old room's name is rewritten:
      // a note staff wrote there ("Back door") is never lost.
      const mirrored = existing.location === "" || existing.location === (existing.room?.name ?? null);
      const nextLocation = !mirrored ? existing.location : room?.name ?? "";
      await tx.honorOffering.update({
        where: { id: offeringId },
        data: {
          ...(sessionChanged ? { sessionId } : {}),
          ...(roomChanged
            ? { roomId: input.roomId, location: nextLocation }
            : {}),
        },
      });
      await writeAuditLog({
        eventId, actorUserId, action: "HONOR_OFFERING_MOVED", entityType: "HonorOffering", entityId: offeringId,
        summary: `Moved ${joinHonorNames(taught.honors.map((honor) => honor.name))}${sessionChanged ? ` to ${sessionName}` : ""}${roomChanged ? (room ? ` into ${room.name}` : " out of its room") : ""}.`,
        metadata: { previousLocation: existing.location, fromSessionId: existing.sessionId, toSessionId: sessionId, fromRoomId: existing.roomId, toRoomId: input.roomId, enrolled },
      }, tx);
    });
  } catch (error) {
    if (isRoomBookedIndex(error)) throw new HonorConfigurationError("ROOM_BOOKED", "That room already has a class then. Choose another room or session.");
    if (isUniqueConstraint(error)) {
      throw new HonorConfigurationError("OFFERING_CONFLICT", "One of this class's honors is already offered in that session.");
    }
    if (isRoomCapacityRefusal(error)) throw new HonorConfigurationError("ROOM_TOO_SMALL", "That room has fewer seats than this class.");
    throw busy(error);
  }
  return getScheduleBoard(eventId);
}
