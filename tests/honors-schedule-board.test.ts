import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALL_SESSIONS_COLUMN,
  buildBoardSections,
  instructorClashes,
  moveTargetProblem,
  seatStatus,
  type BoardCard,
  type BoardRoom,
  type ScheduleBoardData,
} from "@/modules/honors/schedule-board";
import { honorMoveSchema, honorRoomInputSchema, honorRoomUpdateSchema } from "@/modules/honors/schedule-schemas";

const card = (over: Partial<BoardCard> & { id: string }): BoardCard => ({
  title: over.id, span: "SINGLE_SESSION", sessionId: "s1", siteId: "a", roomId: null, capacity: 10, seatsTaken: 0, enrolled: 0,
  isActive: true, teacherName: "", instructors: [], ...over,
});
const room = (id: string, capacity: number, locationId: string | null = "a", sortOrder = 0): BoardRoom => ({ id, name: id, capacity, locationId, sortOrder });

describe("seatStatus", () => {
  it("is open, nearly full from 80%, and full at capacity", () => {
    expect(seatStatus(0, 10)).toBe("OPEN");
    expect(seatStatus(7, 10)).toBe("OPEN");
    expect(seatStatus(8, 10)).toBe("NEARLY_FULL");
    expect(seatStatus(9, 10)).toBe("NEARLY_FULL");
    expect(seatStatus(10, 10)).toBe("FULL");
    expect(seatStatus(11, 10)).toBe("FULL");
    expect(seatStatus(0, 0)).toBe("FULL");
  });
});

describe("buildBoardSections", () => {
  const data: ScheduleBoardData = {
    sites: [{ id: "b", name: "Site B", isActive: true, sortOrder: 1 }, { id: "a", name: "Site A", isActive: true, sortOrder: 0 }],
    sessions: [
      { id: "s2", name: "Two", locationId: "a", sortOrder: 1 }, { id: "s1", name: "One", locationId: "a", sortOrder: 0 },
      { id: "s3", name: "Three", locationId: "b", sortOrder: 0 },
    ],
    rooms: [room("r2", 5, "a", 1), room("r1", 10, "a", 0), room("rb", 10, "b")],
    cards: [
      card({ id: "c1", sessionId: "s1", roomId: "r1" }),
      card({ id: "c2", sessionId: "s2", roomId: null }),
      card({ id: "c3", span: "ALL_SESSIONS", sessionId: null, roomId: "r2" }),
      card({ id: "c4", sessionId: "s3", siteId: "b", roomId: "rb" }),
    ],
  };

  it("makes one section per site with rooms down the side and a no-room row last", () => {
    const sections = buildBoardSections(data);
    expect(sections.map((s) => s.name)).toEqual(["Site A", "Site B"]);
    const a = sections[0]!;
    expect(a.sessions.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(a.rows.map((r) => r.room?.id ?? null)).toEqual(["r1", "r2", null]);
    expect(a.rows[0]!.cells.get("s1")!.map((c) => c.id)).toEqual(["c1"]);
    expect(a.rows[1]!.cells.get(ALL_SESSIONS_COLUMN)!.map((c) => c.id)).toEqual(["c3"]);
    expect(a.rows[2]!.cells.get("s2")!.map((c) => c.id)).toEqual(["c2"]);
    expect(sections[1]!.rows[0]!.cells.get("s3")!.map((c) => c.id)).toEqual(["c4"]);
  });

  it("shows a card whose room isn't in its section under No room yet", () => {
    const sections = buildBoardSections({ ...data, cards: [card({ id: "lost", sessionId: "s1", roomId: "rb" })] });
    const a = sections[0]!;
    expect(a.rows[a.rows.length - 1]!.cells.get("s1")!.map((c) => c.id)).toEqual(["lost"]);
  });

  it("is one section for an event with no sites", () => {
    const sections = buildBoardSections({
      sites: [], sessions: [{ id: "s1", name: "One", locationId: null, sortOrder: 0 }], rooms: [room("r", 5, null)],
      cards: [card({ id: "c", siteId: null, roomId: "r" })],
    });
    expect(sections).toHaveLength(1);
    expect(sections[0]!.siteId).toBeNull();
  });
});

describe("instructorClashes", () => {
  const sessions = [{ id: "s1", locationId: "a" }, { id: "s2", locationId: "a" }, { id: "s3", locationId: "b" }];
  const ann = { id: "p1", name: "Ann" };

  it("flags one instructor in two classes of the same session, on both cards", () => {
    const clashes = instructorClashes([
      card({ id: "x", title: "Knots", instructors: [ann] }),
      card({ id: "y", title: "Birds", instructors: [ann] }),
      card({ id: "z", title: "Maps", sessionId: "s2", instructors: [ann] }),
    ], sessions);
    expect(clashes.get("x")).toEqual(["Ann is also teaching Birds in the same session."]);
    expect(clashes.get("y")).toEqual(["Ann is also teaching Knots in the same session."]);
    expect(clashes.has("z")).toBe(false);
  });

  it("treats an all-sessions class as being in every session of its site", () => {
    const clashes = instructorClashes([
      card({ id: "all", title: "Camp", span: "ALL_SESSIONS", sessionId: null, instructors: [ann] }),
      card({ id: "one", title: "Birds", sessionId: "s2", instructors: [ann] }),
      card({ id: "other-site", title: "Maps", sessionId: "s3", siteId: "b", instructors: [ann] }),
    ], sessions);
    expect(clashes.has("all")).toBe(true);
    expect(clashes.has("one")).toBe(true);
    expect(clashes.has("other-site")).toBe(false);
  });

  it("flags the same free-text teacher (ignoring case and spacing) until instructor data exists", () => {
    const clashes = instructorClashes([card({ id: "x", title: "Knots", teacherName: "Ann  Lee" }), card({ id: "y", title: "Birds", teacherName: "ann lee" })], sessions);
    expect(clashes.get("x")).toEqual(["Ann  Lee is also teaching Birds in the same session."]);
    expect(clashes.has("y")).toBe(true);
    expect(instructorClashes([card({ id: "x", teacherName: "Ann" }), card({ id: "y", sessionId: "s2", teacherName: "Ann" }), card({ id: "z", teacherName: "" }), card({ id: "w", teacherName: "" })], sessions).size).toBe(0);
  });

  it("uses both sources, never clashes a class with itself, and ignores inactive classes", () => {
    expect(instructorClashes([card({ id: "x", instructors: [ann], teacherName: "Ann" })], sessions).size).toBe(0);
    expect(instructorClashes([card({ id: "x", instructors: [ann] }), card({ id: "y", teacherName: "Zed", instructors: [ann] })], sessions).has("x")).toBe(true);
    expect(instructorClashes([card({ id: "x", instructors: [ann] }), card({ id: "y", isActive: false, instructors: [ann] })], sessions).size).toBe(0);
  });
});

describe("moveTargetProblem", () => {
  const rooms = [room("big", 30), room("small", 5)];
  const target = (roomId: string | null, column = "s1", siteId: string | null = "a") => ({ siteId, roomId, column });

  it("allows a room with enough seats, and refuses one with too few", () => {
    const c = card({ id: "c", capacity: 10 });
    expect(moveTargetProblem(c, target("big"), rooms, [c])).toBeNull();
    expect(moveTargetProblem(c, target("small"), rooms, [c])).toMatch(/seats 5, and this class has 10/);
  });

  it("refuses a room already holding an active class then, including an all-sessions class", () => {
    const c = card({ id: "c", sessionId: "s2" });
    const sitting = card({ id: "o", roomId: "big", sessionId: "s1" });
    expect(moveTargetProblem(c, target("big", "s1"), rooms, [c, sitting])).toMatch(/already has a class/);
    expect(moveTargetProblem(c, target("big", "s2"), rooms, [c, sitting])).toBeNull();
    const all = card({ id: "all", roomId: "big", span: "ALL_SESSIONS", sessionId: null });
    expect(moveTargetProblem(c, target("big", "s2"), rooms, [c, all])).toMatch(/already has a class/);
  });

  it("keeps all-sessions classes in the All sessions column and single-session classes out of it", () => {
    const all = card({ id: "all", span: "ALL_SESSIONS", sessionId: null, roomId: "big" });
    expect(moveTargetProblem(all, target("big", "s1"), rooms, [all])).toMatch(/stays in the All sessions column/);
    const one = card({ id: "one" });
    expect(moveTargetProblem(one, target("big", ALL_SESSIONS_COLUMN), rooms, [one])).toMatch(/can't move into All sessions/);
  });

  it("keeps an all-sessions class at its own site", () => {
    const all = card({ id: "all", span: "ALL_SESSIONS", sessionId: null });
    expect(moveTargetProblem(all, target(null, ALL_SESSIONS_COLUMN, "b"), rooms, [all])).toMatch(/stays at its own site/);
  });

  it("refuses another site once anyone is enrolled", () => {
    const enrolled = card({ id: "e", enrolled: 3 });
    expect(moveTargetProblem(enrolled, target(null, "s3", "b"), rooms, [enrolled])).toMatch(/can't move to another site/);
    const empty = card({ id: "n" });
    expect(moveTargetProblem(empty, target(null, "s3", "b"), rooms, [empty])).toBeNull();
  });
});

describe("move and room schemas", () => {
  it("require a positive whole room capacity and a name", () => {
    expect(honorRoomInputSchema.safeParse({ name: "Hall", capacity: 0 }).success).toBe(false);
    expect(honorRoomInputSchema.safeParse({ name: " ", capacity: 5 }).success).toBe(false);
    expect(honorRoomInputSchema.safeParse({ name: "Hall", capacity: 2.5 }).success).toBe(false);
    expect(honorRoomInputSchema.parse({ name: "Hall", capacity: 5 })).toMatchObject({ locationId: null, sortOrder: 0 });
  });

  it("does not reset unset fields on a partial room update", () => {
    expect(honorRoomUpdateSchema.parse({ capacity: 8 })).toEqual({ capacity: 8 });
  });

  it("takes a room (or null) and an optional session, nothing else", () => {
    expect(honorMoveSchema.parse({ roomId: null })).toEqual({ roomId: null });
    expect(honorMoveSchema.parse({ roomId: "r", sessionId: "s" })).toEqual({ roomId: "r", sessionId: "s" });
    expect(honorMoveSchema.safeParse({ roomId: "r", capacity: 99 }).success).toBe(false);
  });
});

const mocks = vi.hoisted(() => ({
  rejectCrossOriginRequest: vi.fn(),
  requireHonorPermission: vi.fn(),
  moveHonorOffering: vi.fn(),
  createHonorRoom: vi.fn(),
  updateHonorRoom: vi.fn(),
  deleteHonorRoom: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/honors/access", () => ({ requireHonorPermission: mocks.requireHonorPermission }));
vi.mock("@/modules/honors/schedule-repository", () => ({
  moveHonorOffering: mocks.moveHonorOffering,
  createHonorRoom: mocks.createHonorRoom,
  updateHonorRoom: mocks.updateHonorRoom,
  deleteHonorRoom: mocks.deleteHonorRoom,
}));

describe("schedule board routes", () => {
  const board = { sites: [], sessions: [], rooms: [], cards: [] };
  const post = (body: unknown) => new Request("https://events.imsda.test/api/x", {
    method: "POST", headers: { origin: "https://events.imsda.test", "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const ctx = { params: Promise.resolve({ eventId: "e1", offeringId: "o1", roomId: "r1" }) };

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.rejectCrossOriginRequest.mockReturnValue(null);
    mocks.requireHonorPermission.mockResolvedValue({ user: { id: "staff-1" } });
    mocks.moveHonorOffering.mockResolvedValue(board);
    mocks.createHonorRoom.mockResolvedValue(board);
    mocks.updateHonorRoom.mockResolvedValue(board);
    mocks.deleteHonorRoom.mockResolvedValue(board);
  });

  it("refuses every write without event configuration permission, before touching the repository", async () => {
    const { AccessDeniedError } = await import("@/modules/access/authorization");
    const { POST: move } = await import("@/app/api/events/[eventId]/honors/offerings/[offeringId]/move/route");
    const { POST: create } = await import("@/app/api/events/[eventId]/honors/rooms/route");
    const { PATCH, DELETE } = await import("@/app/api/events/[eventId]/honors/rooms/[roomId]/route");
    mocks.requireHonorPermission.mockRejectedValue(new AccessDeniedError("No.", 403, "PERMISSION_DENIED"));
    expect((await move(post({ roomId: null }), ctx)).status).toBe(403);
    expect((await create(post({ name: "Hall", capacity: 5 }), ctx)).status).toBe(403);
    expect((await PATCH(post({ capacity: 5 }), ctx)).status).toBe(403);
    expect((await DELETE(post({}), ctx)).status).toBe(403);
    expect(mocks.moveHonorOffering).not.toHaveBeenCalled();
    expect(mocks.createHonorRoom).not.toHaveBeenCalled();
    expect(mocks.updateHonorRoom).not.toHaveBeenCalled();
    expect(mocks.deleteHonorRoom).not.toHaveBeenCalled();
  });

  it("moves with the signed-in staff user and returns the board, and reports a conflict with its count", async () => {
    const { POST: move } = await import("@/app/api/events/[eventId]/honors/offerings/[offeringId]/move/route");
    const { HonorConfigurationError } = await import("@/modules/honors/repository");
    expect((await move(post({ roomId: "r1", sessionId: "s2" }), ctx)).status).toBe(200);
    expect(mocks.moveHonorOffering).toHaveBeenCalledWith("e1", "o1", { roomId: "r1", sessionId: "s2" }, "staff-1");
    mocks.moveHonorOffering.mockRejectedValue(new HonorConfigurationError("MOVE_HAS_CONFLICTS", "No.", undefined, { conflicts: 3 }));
    const refused = await move(post({ roomId: null, sessionId: "s2" }), ctx);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "MOVE_HAS_CONFLICTS", conflicts: 3 });
  });

  it("answers 404 when the room, class or session belongs to another event", async () => {
    const { POST: move } = await import("@/app/api/events/[eventId]/honors/offerings/[offeringId]/move/route");
    const { PATCH, DELETE } = await import("@/app/api/events/[eventId]/honors/rooms/[roomId]/route");
    const { HonorConfigurationError } = await import("@/modules/honors/repository");
    for (const code of ["ROOM_NOT_FOUND", "OFFERING_NOT_FOUND", "SESSION_NOT_FOUND"] as const) {
      mocks.moveHonorOffering.mockRejectedValueOnce(new HonorConfigurationError(code, "Not here."));
      const response = await move(post({ roomId: "other-event-room", sessionId: "other-event-session" }), ctx);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: code });
    }
    mocks.updateHonorRoom.mockRejectedValueOnce(new HonorConfigurationError("ROOM_NOT_FOUND", "Not here."));
    expect((await PATCH(post({ capacity: 5 }), ctx)).status).toBe(404);
    mocks.deleteHonorRoom.mockRejectedValueOnce(new HonorConfigurationError("ROOM_NOT_FOUND", "Not here."));
    expect((await DELETE(post({}), ctx)).status).toBe(404);
  });

  it("rejects an unknown field", async () => {
    const { POST: move } = await import("@/app/api/events/[eventId]/honors/offerings/[offeringId]/move/route");
    expect((await move(post({ roomId: null, capacity: 500 }), ctx)).status).toBe(400);
    expect(mocks.moveHonorOffering).not.toHaveBeenCalled();
  });
});

describe("database refusal mapping", () => {
  it("recognises the trigger's refusal and the room/session index however Prisma words it", async () => {
    const { Prisma } = await import("@prisma/client");
    const { isRoomBookedIndex, isRoomCapacityRefusal } = await import("@/modules/honors/room-errors");
    const unknown = new Prisma.PrismaClientUnknownRequestError("Raw query failed. Code: `23514`. Message: `HonorOffering capacity 25 exceeds its room capacity 20`", { clientVersion: "x" });
    expect(isRoomCapacityRefusal(unknown)).toBe(true);
    expect(isRoomCapacityRefusal(new Prisma.PrismaClientUnknownRequestError("HonorRoom capacity 3 is below a class placed in it", { clientVersion: "x" }))).toBe(true);
    expect(isRoomCapacityRefusal(new Error("23514"))).toBe(false);
    const p2002 = new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the constraint: `HonorOffering_roomId_sessionId_active_key`", { code: "P2002", clientVersion: "x" });
    expect(isRoomBookedIndex(p2002)).toBe(true);
    expect(isRoomBookedIndex(new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the fields: (`sessionId`,`honorId`)", { code: "P2002", clientVersion: "x" }))).toBe(false);
  });
});
