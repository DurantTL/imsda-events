import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  writeAuditLog: vi.fn(),
  identityFindUnique: vi.fn(),
  identityCreate: vi.fn(),
  orgFindUnique: vi.fn(),
  orgFindFirst: vi.fn(),
  orgCreate: vi.fn(),
  orgUpdate: vi.fn(),
  rosterFindMany: vi.fn(),
  rosterCreate: vi.fn(),
  personCreate: vi.fn(),
  inviteFindFirst: vi.fn(),
  inviteCreate: vi.fn(),
  grantFindFirst: vi.fn(),
}));

const client = {
  externalIdentity: { findUnique: mocks.identityFindUnique, create: mocks.identityCreate },
  organization: { findUnique: mocks.orgFindUnique, findFirst: mocks.orgFindFirst, create: mocks.orgCreate, update: mocks.orgUpdate },
  clubRosterMember: { findMany: mocks.rosterFindMany, create: mocks.rosterCreate },
  person: { create: mocks.personCreate },
  clubInvite: { findFirst: mocks.inviteFindFirst, create: mocks.inviteCreate },
  clubDirectorGrant: { findFirst: mocks.grantFindFirst },
  $transaction: (work: (tx: unknown) => unknown) => work(client),
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => client }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));

import { importClubs } from "@/modules/club-imports/repository";
import { clubImportItemSchema } from "@/modules/club-imports/schemas";

const now = new Date("2026-09-23T15:00:00Z");
const item = (overrides: Record<string, unknown> = {}) => clubImportItemSchema.parse({
  sourceKey: "form-89:501",
  entryId: "501",
  clubYear: "2026-27",
  clubName: "Example Pathfinders",
  churchId: null,
  newChurchName: "Example SDA Church",
  invites: [{ role: "DIRECTOR", name: "Pat Example", email: "leader@example.test" }],
  people: [
    { firstName: "Pat", lastName: "Example", attendeeType: "STAFF", role: "Director", classLevel: null, reportedAge: null },
    { firstName: "Alex", lastName: "Sample", attendeeType: "YOUTH", role: "Pathfinder", classLevel: "FRIEND", reportedAge: 12 },
  ],
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.identityFindUnique.mockResolvedValue(null);
  mocks.orgFindFirst.mockResolvedValue(null);
  mocks.orgCreate.mockImplementation(({ data }: { data: { type: string } }) => Promise.resolve({ id: data.type === "CHURCH" ? "church-new" : "club-new", isActive: true, parentOrganizationId: null }));
  mocks.rosterFindMany.mockResolvedValue([]);
  mocks.personCreate.mockImplementation(() => Promise.resolve({ id: `person-${mocks.personCreate.mock.calls.length}` }));
  mocks.inviteFindFirst.mockResolvedValue(null);
  mocks.grantFindFirst.mockResolvedValue(null);
});

describe("club import (#376)", () => {
  it("creates the church, club, roster, and a waiting invite, and audits counts only", async () => {
    const [result] = await importClubs([item()], "admin-1", now);
    expect(result).toMatchObject({ status: "IMPORTED", organizationId: "club-new", membersAdded: 2, invitesCreated: 1 });
    expect(mocks.orgCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "CHURCH", name: "Example SDA Church" }) }));
    expect(mocks.orgCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "CLUB", parentOrganizationId: "church-new" }) }));
    expect(mocks.identityCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ provider: "FLUENT_FORMS", providerScope: "form-89:2026-27", externalId: "501", organizationId: "club-new" }) });
    expect(mocks.rosterCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ source: "IMPORT", reportedAge: 12, classLevel: "FRIEND", clubYear: "2026-27" }) });
    expect(mocks.rosterCreate.mock.calls.every(([call]) => !("sealedBirthDate" in call.data))).toBe(true);
    expect(mocks.inviteCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ email: "leader@example.test", role: "DIRECTOR", createdByUserId: "admin-1" }) });
    expect(mocks.inviteCreate.mock.calls[0][0].data.status).toBeUndefined();
    const audit = mocks.writeAuditLog.mock.calls[0][0];
    expect(audit).toMatchObject({ action: "CLUB_IMPORTED", actorUserId: "admin-1", metadata: { membersAdded: 2, invitesCreated: 1 } });
    expect(JSON.stringify(audit)).not.toMatch(/Pat|Alex|Example Pathfinders|leader@/);
  });

  it("refuses an entry that was already imported, changing nothing", async () => {
    mocks.identityFindUnique.mockResolvedValueOnce({ organizationId: "club-1" });
    const [result] = await importClubs([item()], "admin-1", now);
    expect(result).toMatchObject({ status: "ALREADY_IMPORTED", organizationId: "club-1" });
    expect(mocks.orgCreate).not.toHaveBeenCalled();
    expect(mocks.rosterCreate).not.toHaveBeenCalled();
  });

  it("merges into an existing club without doubling people or invites", async () => {
    mocks.orgFindFirst.mockImplementation(({ where }: { where: { type: string } }) => Promise.resolve(
      where.type === "CLUB" ? { id: "club-1", isActive: true, parentOrganizationId: "church-1" } : { id: "church-1", isActive: true },
    ));
    mocks.rosterFindMany.mockResolvedValue([{ person: { firstName: "alex", lastName: "SAMPLE" } }]);
    mocks.inviteFindFirst.mockResolvedValue({ id: "invite-open" });
    const [result] = await importClubs([item()], "admin-1", now);
    expect(result).toMatchObject({ status: "IMPORTED", organizationId: "club-1", membersAdded: 1, membersSkipped: 1, invitesCreated: 0 });
    expect(mocks.orgCreate).not.toHaveBeenCalled();
  });

  it("refuses a second registration for the same club and year", async () => {
    mocks.orgFindFirst.mockImplementation(({ where }: { where: { type: string } }) => Promise.resolve(
      where.type === "CLUB" ? { id: "club-1", isActive: true, parentOrganizationId: null } : null,
    ));
    mocks.identityFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "identity-1" });
    const [result] = await importClubs([item()], "admin-1", now);
    expect(result).toMatchObject({ status: "FAILED" });
    expect(result.message).toMatch(/already has an imported registration/);
  });

  it("refuses an inactive club with the same name", async () => {
    mocks.orgFindFirst.mockImplementation(({ where }: { where: { type: string } }) => Promise.resolve(
      where.type === "CLUB" ? { id: "club-1", isActive: false, parentOrganizationId: null } : null,
    ));
    const [result] = await importClubs([item()], "admin-1", now);
    expect(result).toMatchObject({ status: "FAILED" });
    expect(mocks.rosterCreate).not.toHaveBeenCalled();
  });

  it("requires a last name for everyone imported", () => {
    expect(() => item({ people: [{ firstName: "Casey", lastName: "", attendeeType: "YOUTH", classLevel: null, reportedAge: null }] })).toThrow(/last name/);
  });
});
