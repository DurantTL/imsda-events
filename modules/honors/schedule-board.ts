/**
 * Honors Weekend schedule board (#834): pure rules and layout, shared by the
 * server (which re-checks every move) and the screen (which only uses them to
 * disable destinations and explain why). Nothing here reads the database.
 */

/** How full a class is: full at or above its seats, "nearly full" from 80% of them. */
export const nearlyFullFraction = 0.8;

export type SeatStatus = "OPEN" | "NEARLY_FULL" | "FULL";

export function seatStatus(seatsTaken: number, capacity: number): SeatStatus {
  if (seatsTaken >= capacity) return "FULL";
  if (seatsTaken >= capacity * nearlyFullFraction) return "NEARLY_FULL";
  return "OPEN";
}

export const seatStatusLabels: Record<SeatStatus, string> = {
  OPEN: "Seats open",
  NEARLY_FULL: "Nearly full",
  FULL: "Full",
};

/** An instructor assigned to a class. Comes from the instructor assignments (#833); see `loadOfferingInstructors`. */
export type BoardInstructor = { id: string; name: string };

export type BoardCard = {
  id: string;
  /** The class's honors joined with " + ". */
  title: string;
  span: "SINGLE_SESSION" | "ALL_SESSIONS";
  sessionId: string | null;
  /** The class's site: its session's, or its own for an all-sessions class. */
  siteId: string | null;
  roomId: string | null;
  capacity: number;
  seatsTaken: number;
  /** Everyone enrolled, staff and adults included (they take no seat). */
  enrolled: number;
  isActive: boolean;
  /** The free-text teacher on the class (the legacy field); shown only when no instructor is assigned. */
  teacherName: string;
  /** Assigned instructors (#833). Empty when the instructor assignments don't exist yet. */
  instructors: BoardInstructor[];
};

export type BoardSession = { id: string; name: string; locationId: string | null; sortOrder: number };
export type BoardRoom = { id: string; name: string; capacity: number; locationId: string | null; sortOrder: number };
export type BoardSite = { id: string; name: string; isActive: boolean; sortOrder: number };

export type ScheduleBoardData = {
  sites: BoardSite[];
  sessions: BoardSession[];
  rooms: BoardRoom[];
  cards: BoardCard[];
};

/** The column of "all sessions" classes in each site's grid. */
export const ALL_SESSIONS_COLUMN = "ALL";

export type BoardRow = { room: BoardRoom | null; cells: Map<string, BoardCard[]> };
export type BoardSection = {
  siteId: string | null;
  name: string;
  sessions: BoardSession[];
  rows: BoardRow[];
};

const bySort = <T extends { sortOrder: number; name: string }>(a: T, b: T) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);

/**
 * One section per site (or one for an event with no sites): sessions across
 * the top, then "All sessions"; rooms down the side, then a "No room" row that
 * holds classes not yet placed.
 */
export function buildBoardSections(data: ScheduleBoardData): BoardSection[] {
  const siteIds: Array<string | null> = [...data.sites].sort(bySort).map((site) => site.id);
  const usesNoSite = data.sessions.some((s) => s.locationId === null)
    || data.rooms.some((r) => r.locationId === null)
    || data.cards.some((c) => c.siteId === null);
  if (usesNoSite || siteIds.length === 0) siteIds.push(null);
  return siteIds.map((siteId) => {
    const sessions = data.sessions.filter((s) => s.locationId === siteId).sort(bySort);
    const rooms = data.rooms.filter((r) => r.locationId === siteId).sort(bySort);
    const cards = data.cards.filter((c) => c.siteId === siteId);
    const rows: BoardRow[] = [...rooms, null].map((room) => {
      const cells = new Map<string, BoardCard[]>();
      for (const card of cards.filter((c) => c.roomId === (room?.id ?? null))) {
        const column = card.span === "ALL_SESSIONS" ? ALL_SESSIONS_COLUMN : card.sessionId ?? "";
        cells.set(column, [...(cells.get(column) ?? []), card]);
      }
      return { room, cells };
    });
    return { siteId, name: data.sites.find((s) => s.id === siteId)?.name ?? "Event", sessions, rows };
  });
}

/**
 * Instructors in two classes in the same session (#834). Only classes with
 * assigned instructors (#833) take part, so with no instructor data nothing is
 * flagged. An all-sessions class counts as being in every session of its site
 * (every session when it has no site). Returns, per class, one sentence per
 * clash, never a person's contact details.
 */
export function instructorClashes(cards: readonly BoardCard[], sessions: ReadonlyArray<{ id: string; locationId: string | null }>) {
  const siteOfSession = new Map(sessions.map((session) => [session.id, session.locationId]));
  const sessionsOf = (card: BoardCard): string[] => {
    if (card.span === "SINGLE_SESSION") return card.sessionId ? [card.sessionId] : [];
    return sessions.filter((session) => card.siteId === null || siteOfSession.get(session.id) === card.siteId || siteOfSession.get(session.id) === null).map((session) => session.id);
  };
  const bySessionAndInstructor = new Map<string, BoardCard[]>();
  for (const card of cards) {
    if (!card.isActive) continue;
    for (const sessionId of sessionsOf(card)) {
      for (const instructor of card.instructors) {
        const key = `${sessionId}\u0000${instructor.id}`;
        bySessionAndInstructor.set(key, [...(bySessionAndInstructor.get(key) ?? []), card]);
      }
    }
  }
  const clashes = new Map<string, string[]>();
  for (const [key, group] of bySessionAndInstructor) {
    if (group.length < 2) continue;
    const instructorId = key.split("\u0000")[1];
    for (const card of group) {
      const name = card.instructors.find((instructor) => instructor.id === instructorId)?.name ?? "An instructor";
      const others = group.filter((other) => other.id !== card.id).map((other) => other.title);
      const message = `${name} is also teaching ${others.join(", ")} in the same session.`;
      const list = clashes.get(card.id) ?? [];
      if (!list.includes(message)) clashes.set(card.id, [...list, message]);
    }
  }
  return clashes;
}

export type MoveTarget = {
  /** The site section the cell is in; a class can't change site while anyone is enrolled. */
  siteId: string | null;
  roomId: string | null;
  /** A session id, or `ALL_SESSIONS_COLUMN`. */
  column: string;
};

/**
 * Why a class can't go in this cell, or null. The screen disables the cell and
 * shows the reason; the server runs the full set of rules again (including the
 * enrolled-people conflict check, which needs the enrollments).
 */
export function moveTargetProblem(card: BoardCard, target: MoveTarget, rooms: readonly BoardRoom[], cards: readonly BoardCard[]): string | null {
  const toAll = target.column === ALL_SESSIONS_COLUMN;
  if (card.span === "ALL_SESSIONS" && !toAll) return "An all-sessions class stays in the All sessions column.";
  if (card.span === "SINGLE_SESSION" && toAll) return "A single-session class can't move into All sessions.";
  const sameSession = toAll || target.column === card.sessionId;
  if (target.siteId !== card.siteId && card.enrolled > 0) {
    return "Clubs have already picked this class, so it can't move to another site.";
  }
  if (target.roomId === card.roomId && sameSession) return "It is already here.";
  if (target.roomId) {
    const room = rooms.find((candidate) => candidate.id === target.roomId);
    if (!room) return "That room could not be found.";
    if (card.capacity > room.capacity) {
      return `${room.name} seats ${room.capacity}, and this class has ${card.capacity} seats. Lower the class seats first.`;
    }
    const taken = cards.some((other) => other.id !== card.id && other.isActive && other.roomId === room.id
      && (toAll || other.span === "ALL_SESSIONS" || other.sessionId === target.column));
    if (taken && card.isActive) return `${room.name} already has a class then.`;
  }
  return null;
}

export const moveConflictMessage = (className: string, sessionName: string, people: number) =>
  `${className} can't move to ${sessionName}: ${people} enrolled ${people === 1 ? "person already holds" : "people already hold"} another class in that session. Move or remove those picks first.`;

export const roomTooSmallMessage = (roomName: string, roomCapacity: number, classCapacity: number) =>
  `${roomName} seats ${roomCapacity}, and this class has ${classCapacity} seats. Lower the class seats or choose a bigger room.`;
