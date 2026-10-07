import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Team results (#809): who may enter and read them, what an entry audits, and the report and CSV. Session, membership and
 * database are stubbed; the permission checks and the repository are real.
 */
const mocks = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  findActiveMembership: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
  getPrisma: vi.fn(),
  writeAuditLog: vi.fn(),
  eventFindUnique: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/modules/events/repository", () => ({ findActiveMembership: mocks.findActiveMembership }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));

import { GET } from "@/app/api/events/[eventId]/team-results/route";
import { PUT } from "@/app/api/events/[eventId]/team-results/[registrationId]/route";
import { teamResultInputSchema, resultIsBlank, teamResultsCsvRows, type TeamResultsRow } from "@/modules/club-teams/results-domain";

const staff = { id: "staff-1", email: "staff@example.test", displayName: "Staff Member" };
const membership = (role: string) => ({ eventId: "event-1", userId: "staff-1", role, status: "ACTIVE", permissions: [] });
const ctx = { params: Promise.resolve({ eventId: "event-1", registrationId: "cer-1" }) };
const listCtx = { params: Promise.resolve({ eventId: "event-1" }) };

const put = (body: unknown) => new Request("https://events.imsda.test/api/events/event-1/team-results/cer-1", {
  method: "PUT",
  headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
  body: JSON.stringify(body),
});

const stored = (overrides: Record<string, unknown> = {}) => ({
  id: "result-1", level: "AREA", placement: "2nd place", qualified: true, notes: "", updatedAt: new Date("2027-01-16T20:00:00Z"), ...overrides,
});

function database(options: { team?: unknown; existing?: unknown; listRows?: unknown[]; noTeamRules?: boolean } = {}) {
  const tx = {
    clubTeamMemberPermission: { groupBy: vi.fn().mockResolvedValue([{ clubEventRegistrationId: "cer-1", _count: { _all: 1 } }]) },
    eventTeamSettings: { findUnique: vi.fn().mockResolvedValue(options.noTeamRules ? null : { eventId: "event-1" }) },
    clubEventRegistration: {
      findFirst: vi.fn().mockResolvedValue("team" in options ? options.team : { teamName: "Bible Bees", organization: { name: "Test Pathfinders" }, registration: { status: "CONFIRMED" } }),
      findMany: vi.fn().mockResolvedValue(options.listRows ?? []),
    },
    clubTeamResult: {
      findUnique: vi.fn().mockResolvedValue(options.existing ?? null),
      upsert: vi.fn(async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => stored({ ...create, ...update })),
      delete: vi.fn(),
    },
  };
  const prisma = { ...tx, $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)) };
  mocks.getPrisma.mockReturnValue(prisma);
  return { prisma, tx };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.getCurrentSession.mockResolvedValue({ user: staff });
  mocks.findActiveMembership.mockResolvedValue(membership("REGISTRATION_MANAGER"));
});

describe("team result input", () => {
  it("trims the free text and defaults a level to nothing entered", () => {
    expect(teamResultInputSchema.parse({ level: "AREA", placement: "  1st place  " })).toEqual({ level: "AREA", placement: "1st place", qualified: false, notes: "" });
  });

  it.each([
    [{ level: "REGIONAL" }, "Invalid option"],
    [{ level: "AREA", placement: "x".repeat(201) }, "Keep the placement or score to 200 characters or fewer."],
    [{ level: "AREA", extra: true }, "Unrecognized key"],
  ])("refuses %j", (input, message) => {
    const result = teamResultInputSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]!.message).toContain(message);
  });

  it("calls a result with nothing in it blank", () => {
    expect(resultIsBlank({ placement: "", qualified: false, notes: "" })).toBe(true);
    expect(resultIsBlank({ placement: "", qualified: true, notes: "" })).toBe(false);
  });
});

describe("PUT /api/events/[eventId]/team-results/[registrationId]", () => {
  it("lets a registration manager enter a result, and audits it with the values after", async () => {
    const { tx } = database();
    const response = await PUT(put({ level: "AREA", placement: "2nd place", qualified: true }), ctx);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ changed: true, result: { level: "AREA", placement: "2nd place", qualified: true } });
    expect(tx.clubTeamResult.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { clubEventRegistrationId_level: { clubEventRegistrationId: "cer-1", level: "AREA" } },
      create: expect.objectContaining({ updatedByUserId: "staff-1" }),
    }));
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      eventId: "event-1", actorUserId: "staff-1", action: "CLUB_TEAM_RESULT_ENTERED",
      summary: "Entered the area result for Bible Bees (Test Pathfinders).",
      metadata: expect.objectContaining({ before: null, after: { placement: "2nd place", qualified: true, notes: "" } }),
    }), tx);
  });

  it("refuses a result on an event without team rules, and writes nothing", async () => {
    const { tx } = database({ noTeamRules: true });
    const response = await PUT(put({ level: "AREA", placement: "1st place" }), ctx);
    expect(response.status).toBe(422);
    expect(tx.clubTeamResult.upsert).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("audits a change with the values before and after", async () => {
    const { tx } = database({ existing: stored() });
    await PUT(put({ level: "AREA", placement: "1st place", qualified: true }), ctx);
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "CLUB_TEAM_RESULT_UPDATED",
      metadata: expect.objectContaining({ before: { placement: "2nd place", qualified: true, notes: "" }, after: { placement: "1st place", qualified: true, notes: "" } }),
    }), tx);
  });

  it("writes and audits nothing when the result is what is already stored", async () => {
    const { tx } = database({ existing: stored() });
    const response = await PUT(put({ level: "AREA", placement: "2nd place", qualified: true }), ctx);
    await expect(response.json()).resolves.toMatchObject({ changed: false });
    expect(tx.clubTeamResult.upsert).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("clears a level when it is saved blank, and audits the clearing", async () => {
    const { tx } = database({ existing: stored() });
    const response = await PUT(put({ level: "AREA" }), ctx);
    await expect(response.json()).resolves.toMatchObject({ changed: true, result: null });
    expect(tx.clubTeamResult.delete).toHaveBeenCalled();
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "CLUB_TEAM_RESULT_CLEARED" }), tx);
  });

  it.each(["FINANCE_MANAGER", "COMMUNICATIONS_MANAGER", "CHECK_IN_STAFF", "READ_ONLY_STAFF"])("refuses %s, who cannot manage registrations", async (role) => {
    mocks.findActiveMembership.mockResolvedValue(membership(role));
    const { prisma } = database();
    const response = await PUT(put({ level: "AREA", placement: "1st" }), ctx);
    expect(response.status).toBe(403);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("allows an event administrator, and refuses a signed-out or cross-origin request", async () => {
    mocks.findActiveMembership.mockResolvedValue(membership("EVENT_ADMIN"));
    database();
    expect((await PUT(put({ level: "UNION", placement: "3rd" }), ctx)).status).toBe(200);
    mocks.getCurrentSession.mockResolvedValue({ user: null });
    expect((await PUT(put({ level: "UNION", placement: "3rd" }), ctx)).status).toBe(401);
    mocks.rejectCrossOriginRequest.mockReturnValue(Response.json({}, { status: 403 }));
    expect((await PUT(put({ level: "UNION", placement: "3rd" }), ctx)).status).toBe(403);
  });

  it("answers 404 for a team of another event, and 422 for one that is waitlisted", async () => {
    database({ team: null });
    expect((await PUT(put({ level: "AREA", placement: "1st" }), ctx)).status).toBe(404);
    database({ team: { teamName: "Bible Bees", organization: { name: "Test Pathfinders" }, registration: { status: "WAITLISTED" } } });
    const response = await PUT(put({ level: "AREA", placement: "1st" }), ctx);
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: "RESULT_INVALID" });
  });

  it("refuses an invalid level with a 400", async () => {
    database();
    expect((await PUT(put({ level: "REGIONAL" }), ctx)).status).toBe(400);
  });
});

describe("GET /api/events/[eventId]/team-results", () => {
  const listRow = {
    id: "cer-1", teamName: "Bible Bees", organization: { name: "Test Pathfinders", parentOrganization: { name: "Test SDA Church" } },
    registration: { confirmationCode: "PBE-1", status: "CONFIRMED", location: { name: "Iowa" } },
    teamResults: [stored(), stored({ level: "CONFERENCE", placement: "5th", qualified: false, notes: "=SUM(A1)" })],
  };

  it("lists each team with a result for every level, to staff with report access", async () => {
    mocks.findActiveMembership.mockResolvedValue(membership("REGISTRATION_MANAGER"));
    database({ listRows: [listRow] });
    const response = await GET(new Request("https://events.imsda.test/api/events/event-1/team-results"), listCtx);
    expect(response.status).toBe(200);
    const body = await response.json() as { teams: TeamResultsRow[] };
    expect(body.teams).toHaveLength(1);
    expect(body.teams[0]).toMatchObject({ teamName: "Bible Bees", clubName: "Test Pathfinders", church: "Test SDA Church", locationName: "Iowa", permissionsPending: 1 });
    expect(body.teams[0]!.results.AREA).toMatchObject({ placement: "2nd place", qualified: true });
    expect(body.teams[0]!.results.UNION).toBeNull();
  });

  it("downloads a CSV with a column set per level, guarding formulas in free text", async () => {
    mocks.findActiveMembership.mockResolvedValue(membership("REGISTRATION_MANAGER"));
    database({ listRows: [listRow] });
    const response = await GET(new Request("https://events.imsda.test/api/events/event-1/team-results?format=csv"), listCtx);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toContain("event-1-team-results.csv");
    const csv = await response.text();
    expect(csv.split("\r\n")[0]).toBe('"Team","Club","Church","Confirmation","Location","AC permission pending","Area placement","Area qualified","Area notes","Conference placement","Conference qualified","Conference notes","Union placement","Union qualified","Union notes"');
    expect(csv).toContain('"Bible Bees","Test Pathfinders","Test SDA Church","PBE-1","Iowa","1","2nd place","Yes","","5th","No","\'=SUM(A1)","","",""');
  });

  it("is refused to staff without report access", async () => {
    mocks.findActiveMembership.mockResolvedValue(membership("COMMUNICATIONS_MANAGER"));
    database();
    mocks.eventFindUnique.mockResolvedValue({ audience: "GENERAL" });
    expect((await GET(new Request("https://events.imsda.test/api/events/event-1/team-results"), listCtx)).status).toBe(403);
  });
});

describe("results CSV rows", () => {
  it("leaves a level with no result empty rather than saying No", () => {
    const rows = teamResultsCsvRows([{
      clubEventRegistrationId: "cer-1", teamName: "Bible Bees", clubName: "Test Pathfinders", church: null, confirmationCode: "PBE-1", status: "CONFIRMED", locationName: null, permissionsPending: 2,
      results: { AREA: null, CONFERENCE: null, UNION: null },
    }]);
    expect(rows[1]!.slice(5)).toEqual([2, "", "", "", "", "", "", "", "", ""]);
    expect(rows[0]![5]).toBe("AC permission pending");
  });
});
