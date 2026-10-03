import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The app has no driving feature any more (#544). An older client may still
 * send `willingToDrive` to the roster's add and edit routes; it is accepted
 * and ignored, so nothing breaks and nothing is stored. The real schema and
 * repository run against a small fake database.
 */

const mocks = vi.hoisted(() => ({
  requireRosterAccess: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
  getPrisma: vi.fn(),
  writeAuditLog: vi.fn(),
  memberUpdate: vi.fn(),
  memberCreate: vi.fn(),
  personCreate: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/lib/env", () => ({ getServerEnv: () => ({ SECRET_ENCRYPTION_KEY: "a-secret-encryption-key-of-adequate-length" }) }));
vi.mock("@/modules/background-checks/refresh-after-write", () => ({ refreshBackgroundCheckMatchesSafely: async () => undefined }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/club-rosters/access", async () => {
  const actual = await vi.importActual<typeof import("@/modules/club-rosters/access")>("@/modules/club-rosters/access");
  return { ...actual, requireRosterAccess: mocks.requireRosterAccess };
});

vi.mock("@/modules/club-rosters/guardians-repository", async () => {
  const actual = await vi.importActual<typeof import("@/modules/club-rosters/guardians-repository")>("@/modules/club-rosters/guardians-repository");
  return { ...actual, listGuardiansByMember: async () => ({}) };
});

import { POST as addMember } from "@/app/api/attendee/clubs/[organizationId]/roster/route";
import { PATCH as editMember } from "@/app/api/attendee/clubs/[organizationId]/roster/[memberId]/route";

const storedYouth = {
  id: "member-1",
  organizationId: "club-1",
  clubYear: "2026-27",
  personId: "person-1",
  attendeeType: "YOUTH",
  role: "Pathfinder",
  classLevel: null,
  reportedAge: null,
  gender: "FEMALE",
  sealedBirthDate: null,
  status: "ACTIVE",
  source: "DIRECTOR",
  sourceRegistrationId: null,
  updatedAt: new Date("2026-09-01T00:00:00Z"),
  person: { firstName: "Test", lastName: "Youth" },
};

const jsonRequest = (method: string, url: string, body: unknown) => new Request(url, {
  method,
  headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.requireRosterAccess.mockResolvedValue({ state: "OPEN", capabilities: { guardians: false }, actor: { kind: "ATTENDEE", accountId: "director-1", sessionId: "session-1" } });
  const client = {
    clubRosterMember: {
      findFirst: vi.fn(async () => storedYouth),
      findMany: vi.fn(async () => []),
      update: mocks.memberUpdate,
      create: mocks.memberCreate,
    },
    person: { create: mocks.personCreate, update: vi.fn() },
  };
  mocks.getPrisma.mockReturnValue({ ...client, $transaction: async (work: (tx: typeof client) => unknown) => work(client) });
});

describe("the roster routes ignore 'willingToDrive' from an older client (#544)", () => {
  beforeEach(() => {
    mocks.personCreate.mockResolvedValue({ id: "person-new" });
    mocks.memberCreate.mockResolvedValue({ id: "member-new" });
  });

  it("accepts it when adding, and never stores it", async () => {
    for (const willingToDrive of [true, false, "yes"]) {
      mocks.memberCreate.mockClear();
      const response = await addMember(
        jsonRequest("POST", "https://events.imsda.test/api/attendee/clubs/club-1/roster", {
          firstName: "Test", lastName: "Adult", birthDate: "1980-05-06", attendeeType: "ADULT",
          gender: "FEMALE", willingToDrive,
        }),
        { params: Promise.resolve({ organizationId: "club-1" }) },
      );
      expect(response.status).toBe(201);
      expect(mocks.memberCreate).toHaveBeenCalledTimes(1);
      expect(mocks.memberCreate.mock.calls[0]![0].data).not.toHaveProperty("willingToDrive");
    }
  });

  it("accepts it on a youth row too, with no 400", async () => {
    const response = await addMember(
      jsonRequest("POST", "https://events.imsda.test/api/attendee/clubs/club-1/roster", {
        firstName: "Test", lastName: "Youth", birthDate: "2014-12-06", attendeeType: "YOUTH",
        gender: "FEMALE", willingToDrive: true,
      }),
      { params: Promise.resolve({ organizationId: "club-1" }) },
    );
    expect(response.status).toBe(201);
    expect(mocks.memberCreate.mock.calls[0]![0].data).not.toHaveProperty("willingToDrive");
  });

  it("accepts it when editing, changes the rest, and never stores it or audits it", async () => {
    const response = await editMember(
      jsonRequest("PATCH", "https://events.imsda.test/api/attendee/clubs/club-1/roster/member-1", { willingToDrive: true, role: "Deputy" }),
      { params: Promise.resolve({ organizationId: "club-1", memberId: "member-1" }) },
    );
    expect(response.status).toBe(200);
    expect(mocks.memberUpdate).toHaveBeenCalledTimes(1);
    const { data } = mocks.memberUpdate.mock.calls[0]![0];
    expect(data).toMatchObject({ role: "Deputy" });
    expect(data).not.toHaveProperty("willingToDrive");
    expect(JSON.stringify(mocks.writeAuditLog.mock.calls)).not.toMatch(/WILLING_TO_DRIVE|willingToDrive/);
  });

  it("an edit with nothing left after stripping it returns the roster without writing or auditing", async () => {
    const response = await editMember(
      jsonRequest("PATCH", "https://events.imsda.test/api/attendee/clubs/club-1/roster/member-1", { willingToDrive: true }),
      { params: Promise.resolve({ organizationId: "club-1", memberId: "member-1" }) },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ clubYear: expect.any(String), members: expect.any(Array) });
    expect(mocks.memberUpdate).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("still rejects any other unknown field", async () => {
    const response = await editMember(
      jsonRequest("PATCH", "https://events.imsda.test/api/attendee/clubs/club-1/roster/member-1", { somethingElse: true }),
      { params: Promise.resolve({ organizationId: "club-1", memberId: "member-1" }) },
    );
    expect(response.status).toBe(400);
    expect(mocks.memberUpdate).not.toHaveBeenCalled();
  });
});
