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
  identityFindMany: vi.fn(),
  orgFindMany: vi.fn(),
}));

const client = {
  externalIdentity: { findUnique: mocks.identityFindUnique, create: mocks.identityCreate, findMany: mocks.identityFindMany },
  organization: { findUnique: mocks.orgFindUnique, findFirst: mocks.orgFindFirst, create: mocks.orgCreate, update: mocks.orgUpdate, findMany: mocks.orgFindMany },
  clubRosterMember: { findMany: mocks.rosterFindMany, create: mocks.rosterCreate },
  person: { create: mocks.personCreate },
  clubInvite: { findFirst: mocks.inviteFindFirst, create: mocks.inviteCreate },
  clubDirectorGrant: { findFirst: mocks.grantFindFirst },
  $transaction: (work: (tx: unknown) => unknown) => work(client),
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => client }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));

import { annotateImportDrafts, importClubs } from "@/modules/club-imports/repository";
import { parseClubRegistrationExport } from "@/modules/club-imports/domain";
import { clubImportItemSchema } from "@/modules/club-imports/schemas";
import { syntheticExportEntry } from "./support/club-import-fixture";

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
    expect(result).toMatchObject({ status: "ALREADY_IMPORTED", organizationId: "club-1", clubYear: "2026-27" });
    expect(result.message).toMatch(/already imported for 2026-27/);
    expect(mocks.orgCreate).not.toHaveBeenCalled();
    expect(mocks.rosterCreate).not.toHaveBeenCalled();
  });

  it("merges into an existing club without doubling people or invites", async () => {
    mocks.orgFindFirst.mockImplementation(({ where }: { where: { type: string } }) => Promise.resolve(
      where.type === "CLUB" ? { id: "club-1", isActive: true, parentOrganizationId: "church-1" } : { id: "church-1", isActive: true },
    ));
    mocks.rosterFindMany.mockResolvedValue([{ attendeeType: "YOUTH", person: { firstName: "alex", lastName: "SAMPLE" } }]);
    mocks.inviteFindFirst.mockResolvedValue({ id: "invite-open" });
    const [result] = await importClubs([item()], "admin-1", now);
    expect(result).toMatchObject({ status: "IMPORTED", organizationId: "club-1", membersAdded: 1, membersSkipped: 1, invitesCreated: 0 });
    expect(result.skipped).toEqual([{ name: "Alex Sample", reason: "ALREADY_ON_ROSTER" }]);
    expect(mocks.orgCreate).not.toHaveBeenCalled();
  });

  it("refuses a second registration for the same club and year", async () => {
    mocks.orgFindFirst.mockImplementation(({ where }: { where: { type: string } }) => Promise.resolve(
      where.type === "CLUB" ? { id: "club-1", isActive: true, parentOrganizationId: null } : null,
    ));
    mocks.identityFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "identity-1" });
    const [result] = await importClubs([item()], "admin-1", now);
    expect(result).toMatchObject({ status: "FAILED" });
    expect(result.message).toBe("This club already has a 2026-27 import. Add the missing people on the roster, or move/undo the earlier import.");
  });

  it("refuses a club with no sponsoring church, creating nothing", async () => {
    const [result] = await importClubs([item({ churchId: null, newChurchName: "" })], "admin-1", now);
    expect(result).toMatchObject({ status: "FAILED" });
    expect(result.message).toMatch(/sponsoring church/);
    expect(mocks.orgCreate).not.toHaveBeenCalled();
    expect(mocks.rosterCreate).not.toHaveBeenCalled();
  });

  it("keeps an existing club's church without asking for one, and creates no stray church", async () => {
    mocks.orgFindFirst.mockImplementation(({ where }: { where: { type: string } }) => Promise.resolve(
      where.type === "CLUB" ? { id: "club-1", isActive: true, parentOrganizationId: "church-1" } : null,
    ));
    const [withoutChurch] = await importClubs([item({ churchId: null, newChurchName: "" })], "admin-1", now);
    expect(withoutChurch).toMatchObject({ status: "IMPORTED", organizationId: "club-1" });

    const [withNewChurch] = await importClubs([item({ churchId: null, newChurchName: "Another SDA Church" })], "admin-1", now);
    expect(withNewChurch).toMatchObject({ status: "IMPORTED", organizationId: "club-1" });
    expect(mocks.orgCreate).not.toHaveBeenCalled();
  });

  it("requires a church for an existing club that doesn't have one yet", async () => {
    mocks.orgFindFirst.mockImplementation(({ where }: { where: { type: string } }) => Promise.resolve(
      where.type === "CLUB" ? { id: "club-1", isActive: true, parentOrganizationId: null } : null,
    ));
    const [result] = await importClubs([item({ churchId: null, newChurchName: "" })], "admin-1", now);
    expect(result).toMatchObject({ status: "FAILED" });
    expect(result.message).toMatch(/sponsoring church/);
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

  it("imports the whole synthetic August entry, siblings and a parent and child included, into the current year", async () => {
    const [draft] = parseClubRegistrationExport([syntheticExportEntry()], now).drafts;
    const [result] = await importClubs([item({
      sourceKey: draft.sourceKey,
      entryId: draft.entryId,
      clubYear: draft.clubYear,
      people: draft.people.filter((person) => person.include).map((person) => ({
        firstName: person.firstName,
        lastName: person.lastName,
        attendeeType: person.attendeeType,
        role: person.role,
        classLevel: person.classLevel,
        reportedAge: person.reportedAge,
      })),
    })], "admin-1", now);
    expect(draft.clubYear).toBe("2026-27");
    expect(result).toMatchObject({ status: "IMPORTED", clubYear: "2026-27", membersAdded: 48, membersSkipped: 0, skipped: [] });
    expect(mocks.rosterCreate).toHaveBeenCalledTimes(48);
    expect(mocks.rosterCreate.mock.calls.every(([call]) => call.data.clubYear === "2026-27")).toBe(true);
    const created = mocks.personCreate.mock.calls.map(([call]) => `${call.data.firstName} ${call.data.lastName}`);
    for (const name of ["Cy Faux", "Dee Faux", "Kim Faux", "Lou Faux", "Max Faux", "Ada Testerson", "Ben Testerson", "Ned Testerson", "Ola Testerson", "Bo Placeholder", "Gus Placeholder"]) {
      expect(created).toContain(name);
    }
  });

  it("imports into the year chosen, and refuses a year too far away", async () => {
    const [previous] = await importClubs([item({ clubYear: "2025-26" })], "admin-1", now);
    expect(previous).toMatchObject({ status: "IMPORTED", clubYear: "2025-26" });
    expect(mocks.rosterCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ clubYear: "2025-26" }) });
    expect(mocks.identityCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ providerScope: "form-89:2025-26" }) });
    vi.clearAllMocks();
    const [far] = await importClubs([item({ clubYear: "2023-24" })], "admin-1", now);
    expect(far).toMatchObject({ status: "FAILED" });
    expect(mocks.rosterCreate).not.toHaveBeenCalled();
  });

  it("imports a parent and child who share a full name, and reports a true duplicate", async () => {
    const [result] = await importClubs([item({
      people: [
        { firstName: "Chris", lastName: "Faux", attendeeType: "STAFF", role: "Staff", classLevel: null, reportedAge: null },
        { firstName: "Chris", lastName: "Faux", attendeeType: "YOUTH", role: "Pathfinder", classLevel: "FRIEND", reportedAge: 9 },
        { firstName: "Bo", lastName: "Faux", attendeeType: "YOUTH", role: "Pathfinder", classLevel: null, reportedAge: 8 },
        { firstName: "bo", lastName: "FAUX", attendeeType: "YOUTH", role: "Pathfinder", classLevel: null, reportedAge: 8 },
      ],
    })], "admin-1", now);
    expect(result).toMatchObject({ membersAdded: 3, membersSkipped: 1 });
    expect(result.skipped).toEqual([{ name: "bo FAUX", reason: "DUPLICATE_IN_REGISTRATION" }]);
    expect(JSON.stringify(mocks.writeAuditLog.mock.calls[0][0])).not.toMatch(/Chris|Faux/);
  });

  it("re-importing the same entry reports it as already imported and adds no one", async () => {
    await importClubs([item()], "admin-1", now);
    vi.clearAllMocks();
    mocks.identityFindUnique.mockResolvedValueOnce({ organizationId: "club-new" });
    const [again] = await importClubs([item()], "admin-1", now);
    expect(again).toMatchObject({ status: "ALREADY_IMPORTED", organizationId: "club-new", membersAdded: 0 });
    expect(mocks.personCreate).not.toHaveBeenCalled();
  });

  it("adds a same-named youth only when Keep both is sent", async () => {
    const twins = [
      { firstName: "Robin", lastName: "Faux", attendeeType: "YOUTH", role: "Pathfinder", classLevel: "FRIEND", reportedAge: 9 },
      { firstName: "Robin", lastName: "Faux", attendeeType: "YOUTH", role: "Pathfinder", classLevel: "EXPLORER", reportedAge: 12 },
    ];
    const [skipped] = await importClubs([item({ people: twins })], "admin-1", now);
    expect(skipped).toMatchObject({ membersAdded: 1, membersSkipped: 1 });
    vi.clearAllMocks();
    mocks.personCreate.mockResolvedValue({ id: "person-x" });
    const [kept] = await importClubs([item({ people: [twins[0], { ...twins[1], keepBoth: true }] })], "admin-1", now);
    expect(kept).toMatchObject({ membersAdded: 2, membersSkipped: 0, skipped: [] });
    expect(mocks.rosterCreate.mock.calls.every(([call]) => !("keepBoth" in call.data))).toBe(true);
  });
});

describe("the preview's earlier imports (#541)", () => {
  const drafts = () => parseClubRegistrationExport([syntheticExportEntry({ id: 777 }), syntheticExportEntry({ id: 778 })], now).drafts;

  beforeEach(() => {
    mocks.orgFindMany.mockResolvedValue([]);
  });

  it("lists every club year each entry was imported for, by entry", async () => {
    mocks.identityFindMany.mockResolvedValue([
      { externalId: "777", providerScope: "form-89:2025-26", organization: { id: "club-1", name: "Fixture Pathfinders" } },
      { externalId: "777", providerScope: "form-89:2026-27", organization: { id: "club-1", name: "Fixture Pathfinders" } },
      { externalId: "778", providerScope: "form-89:2024-25", organization: { id: "club-2", name: "Other Pathfinders" } },
      // Not a club-year scope, and an identity whose club is gone: both ignored.
      { externalId: "778", providerScope: "form-89:778", organization: { id: "club-2", name: "Other Pathfinders" } },
      { externalId: "778", providerScope: "form-89:2026-27", organization: null },
    ]);
    const annotated = await annotateImportDrafts(drafts());
    expect(mocks.identityFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { provider: "FLUENT_FORMS", externalId: { in: ["777", "778"] } } }));
    expect(annotated.drafts[0].importedYears).toEqual({
      "2025-26": { id: "club-1", name: "Fixture Pathfinders" },
      "2026-27": { id: "club-1", name: "Fixture Pathfinders" },
    });
    expect(annotated.drafts[1].importedYears).toEqual({ "2024-25": { id: "club-2", name: "Other Pathfinders" } });
    expect(annotated.drafts.every((draft) => draft.clubYear === "2026-27")).toBe(true);
  });

  it("is empty for an entry never imported", async () => {
    mocks.identityFindMany.mockResolvedValue([]);
    const annotated = await annotateImportDrafts(drafts());
    expect(annotated.drafts.map((draft) => draft.importedYears)).toEqual([{}, {}]);
  });
});
