import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `/api/events/[eventId]/locations` (#413): permission, cross-origin, input,
 * and refusal handling for staff location setup. The repository is stubbed
 * (its real error class is kept) and the session is synthetic.
 */
const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  getCurrentSession: vi.fn(),
  findActiveMembership: vi.fn(),
  listEventLocations: vi.fn(),
  createEventLocation: vi.fn(),
  updateEventLocation: vi.fn(),
  deleteEventLocation: vi.fn(),
  reorderEventLocations: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/authorization", async () => {
  const actual = await vi.importActual<typeof import("@/modules/access/authorization")>("@/modules/access/authorization");
  return { ...actual, requirePermission: mocks.requirePermission };
});
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/modules/events/repository", () => ({ findActiveMembership: mocks.findActiveMembership }));
vi.mock("@/lib/logger", async () => {
  const actual = await vi.importActual<typeof import("@/lib/logger")>("@/lib/logger");
  return { ...actual, logError: mocks.logError };
});
vi.mock("@/modules/event-locations/repository", () => ({
  listEventLocations: mocks.listEventLocations,
  createEventLocation: mocks.createEventLocation,
  updateEventLocation: mocks.updateEventLocation,
  deleteEventLocation: mocks.deleteEventLocation,
  reorderEventLocations: mocks.reorderEventLocations,
}));

import { GET, POST } from "@/app/api/events/[eventId]/locations/route";
import { DELETE, PATCH } from "@/app/api/events/[eventId]/locations/[locationId]/route";
import { PUT } from "@/app/api/events/[eventId]/locations/order/route";
import { AccessDeniedError } from "@/modules/access/authorization";
import { EventLocationError } from "@/modules/event-locations/errors";
import { eventLocationInputSchema } from "@/modules/event-locations/domain";

const origin = "https://events.imsda.test";
const eventContext = { params: Promise.resolve({ eventId: "event-1" }) };
const locationContext = { params: Promise.resolve({ eventId: "event-1", locationId: "loc-1" }) };

function request(method: string, body?: unknown, requestOrigin = origin) {
  return new Request(`${origin}/api/events/event-1/locations`, {
    method,
    headers: { "content-type": "application/json", origin: requestOrigin },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentSession.mockResolvedValue({ user: { id: "usr_admin" } });
  mocks.requirePermission.mockResolvedValue({ user: { id: "usr_admin" }, membership: null });
  mocks.listEventLocations.mockResolvedValue([{ id: "loc-1", name: "Des Moines" }]);
  mocks.createEventLocation.mockResolvedValue({ id: "loc-1", name: "Des Moines" });
  mocks.updateEventLocation.mockResolvedValue({ id: "loc-1", name: "Des Moines" });
  mocks.deleteEventLocation.mockResolvedValue([]);
  mocks.reorderEventLocations.mockResolvedValue([]);
});

type Call = { label: string; call: (requestOrigin?: string) => Promise<Response>; repository: ReturnType<typeof vi.fn>; writes: boolean };
const calls: Call[] = [
  { label: "GET locations", call: () => GET(request("GET"), eventContext), repository: mocks.listEventLocations, writes: false },
  { label: "POST locations", call: (o) => POST(request("POST", { name: "Des Moines" }, o), eventContext), repository: mocks.createEventLocation, writes: true },
  { label: "PATCH a location", call: (o) => PATCH(request("PATCH", { isActive: false }, o), locationContext), repository: mocks.updateEventLocation, writes: true },
  { label: "DELETE a location", call: (o) => DELETE(request("DELETE", undefined, o), locationContext), repository: mocks.deleteEventLocation, writes: true },
  { label: "PUT the order", call: (o) => PUT(request("PUT", { orderedIds: ["loc-1"] }, o), eventContext), repository: mocks.reorderEventLocations, writes: true },
];

describe("staff location routes (#413)", () => {
  it.each(calls)("$label needs event configuration permission, checked on the server", async ({ call, repository }) => {
    mocks.requirePermission.mockRejectedValue(new AccessDeniedError("Not allowed.", 403, "PERMISSION_DENIED"));
    const response = await call();
    expect(response.status).toBe(403);
    expect(repository).not.toHaveBeenCalled();
    expect(mocks.requirePermission).toHaveBeenCalledWith(expect.anything(), "event-1", "CONFIGURE_EVENT", mocks.findActiveMembership);
  });

  it.each(calls.filter((entry) => entry.writes))("$label refuses a cross-origin request before anything else", async ({ call, repository }) => {
    const response = await call("https://evil.example");
    expect(response.status).toBe(403);
    expect(mocks.requirePermission).not.toHaveBeenCalled();
    expect(repository).not.toHaveBeenCalled();
  });

  it("lists, creates, edits, deletes and reorders for an event administrator", async () => {
    expect(await (await GET(request("GET"), eventContext)).json()).toEqual({ locations: [{ id: "loc-1", name: "Des Moines" }] });
    const created = await POST(request("POST", { name: "Des Moines", capacity: 40 }), eventContext);
    expect(created.status).toBe(201);
    expect(mocks.createEventLocation).toHaveBeenCalledWith("event-1", "usr_admin", { name: "Des Moines", capacity: 40 });
    expect((await PATCH(request("PATCH", { capacity: 50 }), locationContext)).status).toBe(200);
    expect(mocks.updateEventLocation).toHaveBeenCalledWith("event-1", "loc-1", "usr_admin", { capacity: 50 });
    expect((await DELETE(request("DELETE"), locationContext)).status).toBe(200);
    expect(mocks.deleteEventLocation).toHaveBeenCalledWith("event-1", "loc-1", "usr_admin");
    expect((await PUT(request("PUT", { orderedIds: ["loc-1"] }), eventContext)).status).toBe(200);
  });

  it.each([
    ["LOCATION_IN_USE", 409],
    ["LOCATION_NAME_TAKEN", 409],
    ["LOCATION_CAPACITY_BELOW_USAGE", 409],
    ["LOCATION_LIMIT_REACHED", 409],
    ["LOCATION_NOT_FOUND", 404],
    ["EVENT_NOT_FOUND", 404],
    ["LOCATION_ORDER_MISMATCH", 422],
    ["LOCATION_BUSY", 503],
  ] as const)("maps a %s refusal to %i with its own message", async (code, status) => {
    mocks.deleteEventLocation.mockRejectedValue(new EventLocationError(code, "Readable message."));
    const response = await DELETE(request("DELETE"), locationContext);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: code, message: "Readable message." });
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it("maps a lock wait that gave up, or an expired transaction, to a retryable 503, and a serialization failure to 409", async () => {
    const lockTimeout = new Prisma.PrismaClientKnownRequestError("lock", { code: "P2010", clientVersion: "test", meta: { code: "55P03" } });
    mocks.updateEventLocation.mockRejectedValueOnce(lockTimeout);
    const busy = await PATCH(request("PATCH", { capacity: 3 }), locationContext);
    expect(busy.status).toBe(503);
    expect((await busy.json()).error).toBe("LOCATION_BUSY");
    // A plain lock wait is just busy; an expired transaction is real slowness, so it is logged too.
    expect(mocks.logError).not.toHaveBeenCalled();
    mocks.updateEventLocation.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("expired", { code: "P2028", clientVersion: "test" }));
    expect((await PATCH(request("PATCH", { capacity: 3 }), locationContext)).status).toBe(503);
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    mocks.updateEventLocation.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("conflict", { code: "P2034", clientVersion: "test" }));
    expect((await PATCH(request("PATCH", { capacity: 3 }), locationContext)).status).toBe(409);
    expect(mocks.logError).toHaveBeenCalledTimes(1);
  });

  it("answers invalid JSON and invalid input with 400, and logs an unexpected fault as a 500 without details", async () => {
    expect((await POST(request("POST", "{not json"), eventContext)).status).toBe(400);
    mocks.createEventLocation.mockRejectedValueOnce(eventLocationInputSchema.safeParse({ name: "" }).error);
    const invalid = await POST(request("POST", { name: "" }), eventContext);
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error).toBe("INVALID_LOCATION");
    mocks.deleteEventLocation.mockRejectedValueOnce(new Error("database exploded with secret detail"));
    const failed = await DELETE(request("DELETE"), locationContext);
    expect(failed.status).toBe(500);
    expect(JSON.stringify(await failed.json())).not.toContain("secret detail");
    expect(mocks.logError).toHaveBeenCalledTimes(1);
  });
});
