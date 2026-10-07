import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Team rules for a club event (#809): the route's permission, and the guards that keep an event from holding
 * registrations its own rules cannot describe. Session, membership and database are stubbed; the permission check and
 * the repository are real.
 */
const mocks = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  findActiveMembership: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
  getPrisma: vi.fn(),
  writeAuditLog: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/modules/events/repository", () => ({ findActiveMembership: mocks.findActiveMembership }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));

import { GET, PUT } from "@/app/api/events/[eventId]/team-settings/route";

const staff = { id: "staff-1", email: "staff@example.test", displayName: "Staff Member" };
const membership = (role: string) => ({ eventId: "event-1", userId: "staff-1", role, status: "ACTIVE", permissions: [] });
const context = { params: Promise.resolve({ eventId: "event-1" }) };
const pbe = {
  allowMultipleTeams: true, minTeamMembers: 2, maxTeamMembers: 7, maxAlternates: 1,
  ageAsOf: "2026-01-01", maxMemberAge: 19, booksLine: "Synthetic books line",
  levelInfo: [{ level: "UNION", date: "2027-03-27", place: "Lincoln, NE" }],
};

function put(body: unknown) {
  return new Request("https://events.imsda.test/api/events/event-1/team-settings", {
    method: "PUT",
    headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function database(overrides: { event?: unknown; existing?: unknown; unnamed?: number; named?: number; classes?: number; drafts?: number } = {}) {
  const tx = {
    event: { findUnique: vi.fn().mockResolvedValue("event" in overrides ? overrides.event : { id: "event-1", audience: "CLUB", name: "Synthetic PBE" }) },
    eventTeamSettings: {
      findUnique: vi.fn().mockResolvedValue(overrides.existing ?? null),
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => ({ ...create })),
      delete: vi.fn(),
    },
    clubEventRegistration: {
      count: vi.fn(async ({ where }: { where: { teamKey: unknown } }) => (typeof where.teamKey === "string" ? overrides.unnamed ?? 0 : overrides.named ?? 0)),
    },
    honorOffering: { count: vi.fn().mockResolvedValue(overrides.classes ?? 0) },
    clubRegistrationDraft: { count: vi.fn().mockResolvedValue(overrides.drafts ?? 0) },
    $queryRaw: vi.fn().mockResolvedValue([{ id: "event-1" }]),
  };
  const prisma = { ...tx, $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)) };
  mocks.getPrisma.mockReturnValue(prisma);
  return { prisma, tx };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.getCurrentSession.mockResolvedValue({ user: staff });
  mocks.findActiveMembership.mockResolvedValue(membership("EVENT_ADMIN"));
});

describe("PUT /api/events/[eventId]/team-settings", () => {
  it("lets an event administrator set the Pathfinder Bible Experience rules, and audits the change", async () => {
    const { tx } = database();
    const response = await PUT(put(pbe), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ teamSettings: { allowMultipleTeams: true, minTeamMembers: 2, maxTeamMembers: 7, maxAlternates: 1, ageAsOf: "2026-01-01", maxMemberAge: 19 } });
    expect(tx.eventTeamSettings.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { eventId: "event-1" } }));
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "event-1", actorUserId: "staff-1", action: "EVENT_TEAM_SETTINGS_UPDATED", entityType: "EventTeamSettings" }),
      tx,
    );
  });

  it.each(["REGISTRATION_MANAGER", "FINANCE_MANAGER", "COMMUNICATIONS_MANAGER", "CHECK_IN_STAFF", "READ_ONLY_STAFF"])("refuses %s, who cannot configure the event", async (role) => {
    mocks.findActiveMembership.mockResolvedValue(membership(role));
    const { prisma } = database();
    const response = await PUT(put(pbe), context);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "PERMISSION_DENIED" });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses a signed-out request and a cross-origin one", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: null });
    database();
    expect((await PUT(put(pbe), context)).status).toBe(401);
    mocks.rejectCrossOriginRequest.mockReturnValue(Response.json({}, { status: 403 }));
    expect((await PUT(put(pbe), context)).status).toBe(403);
  });

  it("refuses rules that contradict each other, naming the problem", async () => {
    database();
    const response = await PUT(put({ ...pbe, minTeamMembers: 8 }), context);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "INVALID_TEAM_SETTINGS", message: "The fewest team members cannot be more than the most." });
  });

  it("is only for a club event", async () => {
    database({ event: { id: "event-1", audience: "GENERAL", name: "Synthetic Retreat" } });
    const response = await PUT(put(pbe), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "NOT_A_CLUB_EVENT" });
  });

  it("will not switch to named teams while clubs have registered without a team name", async () => {
    const { tx } = database({ unnamed: 3 });
    const response = await PUT(put(pbe), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "REGISTRATIONS_WITHOUT_TEAM" });
    expect(tx.eventTeamSettings.upsert).not.toHaveBeenCalled();
  });

  it("will not switch to named teams while clubs have unsubmitted drafts, and does not delete them", async () => {
    const { tx } = database({ drafts: 2 });
    const response = await PUT(put(pbe), context);
    expect(response.status).toBe(409);
    const body = await response.json() as { error: string; message: string };
    expect(body.error).toBe("DRAFTS_IN_PROGRESS");
    expect(body.message).toContain("2 clubs have started a registration");
    expect(tx.eventTeamSettings.upsert).not.toHaveBeenCalled();
    expect("deleteMany" in tx.clubRegistrationDraft).toBe(false);
  });

  it("saves under the event lock, as one Serializable transaction", async () => {
    const { prisma, tx } = database();
    await PUT(put(pbe), context);
    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: "Serializable" }));
  });

  it("will not allow several teams on an event with classes, which are picked once per club", async () => {
    database({ classes: 2 });
    const response = await PUT(put(pbe), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "CLASSES_NOT_SUPPORTED" });
  });

  it("will not turn several teams off once teams have registered", async () => {
    const { tx } = database({ existing: { ...pbe, eventId: "event-1" }, named: 2 });
    const response = await PUT(put({ ...pbe, allowMultipleTeams: false }), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "TEAMS_IN_USE" });
    expect(tx.eventTeamSettings.upsert).not.toHaveBeenCalled();
  });

  it("lets limits change on an event whose teams already registered", async () => {
    const { tx } = database({ existing: { ...pbe, eventId: "event-1" }, named: 2 });
    const response = await PUT(put({ ...pbe, maxTeamMembers: 6 }), context);
    expect(response.status).toBe(200);
    expect(tx.eventTeamSettings.upsert).toHaveBeenCalled();
  });
});

describe("GET /api/events/[eventId]/team-settings", () => {
  it("shows the rules to an event administrator, and null for an event without any", async () => {
    database();
    const response = await GET(new Request("https://events.imsda.test/api/events/event-1/team-settings"), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ teamSettings: null });
  });

  it("is refused to staff who cannot configure the event", async () => {
    mocks.findActiveMembership.mockResolvedValue(membership("REGISTRATION_MANAGER"));
    database();
    expect((await GET(new Request("https://events.imsda.test/api/events/event-1/team-settings"), context)).status).toBe(403);
  });
});
