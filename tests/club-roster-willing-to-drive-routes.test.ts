import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Willing to drive" (#491) over HTTP: the roster's add and edit routes
 * answer 400 WILLING_TO_DRIVE_NOT_ALLOWED for a youth row. The real
 * repository runs against a small fake database, so the refusal is the
 * repository's own, and nothing is written.
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
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/club-rosters/access", async () => {
  const actual = await vi.importActual<typeof import("@/modules/club-rosters/access")>("@/modules/club-rosters/access");
  return { ...actual, requireRosterAccess: mocks.requireRosterAccess };
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
  willingToDrive: false,
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
  mocks.requireRosterAccess.mockResolvedValue({ state: "OPEN", actor: { kind: "ATTENDEE", accountId: "director-1", sessionId: "session-1" } });
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

describe("the roster routes refuse 'Willing to drive' on a youth row (#491)", () => {
  it("answers 400 when adding a youth marked willing to drive", async () => {
    const response = await addMember(
      jsonRequest("POST", "https://events.imsda.test/api/attendee/clubs/club-1/roster", {
        firstName: "Test", lastName: "Youth", birthDate: "2014-12-06", attendeeType: "YOUTH",
        gender: "FEMALE", willingToDrive: true,
      }),
      { params: Promise.resolve({ organizationId: "club-1" }) },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "WILLING_TO_DRIVE_NOT_ALLOWED" });
    expect(mocks.personCreate).not.toHaveBeenCalled();
    expect(mocks.memberCreate).not.toHaveBeenCalled();
  });

  it("answers 400 when editing a stored youth row to willing to drive", async () => {
    const response = await editMember(
      jsonRequest("PATCH", "https://events.imsda.test/api/attendee/clubs/club-1/roster/member-1", { willingToDrive: true }),
      { params: Promise.resolve({ organizationId: "club-1", memberId: "member-1" }) },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "WILLING_TO_DRIVE_NOT_ALLOWED" });
    expect(mocks.memberUpdate).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });
});
