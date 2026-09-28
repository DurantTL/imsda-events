import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Move this import to another club year" (#541). The real-database proof
 * (48 moved, Person count unchanged) is `npm run test:club-imports`; these
 * pin the rules: conflicts refuse the whole move, nothing is created or
 * deleted, the audit has counts and ids only, and only a system
 * administrator can call the route.
 */

const mocks = vi.hoisted(() => ({
  writeAuditLog: vi.fn(),
  identityFindUnique: vi.fn(),
  identityFindMany: vi.fn(),
  identityUpdate: vi.fn(),
  rosterFindMany: vi.fn(),
  rosterUpdateMany: vi.fn(),
  rosterCount: vi.fn(),
  personCreate: vi.fn(),
  personDelete: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
  requireSystemAdministrator: vi.fn(),
}));

const client = {
  externalIdentity: { findUnique: mocks.identityFindUnique, findMany: mocks.identityFindMany, update: mocks.identityUpdate },
  clubRosterMember: { findMany: mocks.rosterFindMany, updateMany: mocks.rosterUpdateMany, count: mocks.rosterCount },
  person: { create: mocks.personCreate, delete: mocks.personDelete, deleteMany: mocks.personDelete },
  $transaction: (work: (tx: unknown) => unknown) => work(client),
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => client }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/organizations/access", () => ({ requireSystemAdministrator: mocks.requireSystemAdministrator }));

import { POST } from "@/app/api/admin/organizations/[organizationId]/club-import-year/route";
import { AccessDeniedError } from "@/modules/access/authorization";
import { listClubImports, moveImportYear, previewImportYearMove } from "@/modules/club-imports/move-year";
import { conflictLabel, ImportYearMoveError } from "@/modules/club-imports/move-year-domain";

const now = new Date("2026-09-28T15:00:00Z");

const row = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  personId: `person-${id}`,
  status: "ACTIVE",
  person: { firstName: "Robin", lastName: `Fixture${id}` },
  transferAsSender: [],
  transferAsReceiver: null,
  ...overrides,
});

/** The 2025-26 import exists; the target has none unless `targetImport`. */
function identities(targetImport = false) {
  mocks.identityFindUnique.mockImplementation(({ where }: { where: { organizationId_provider_providerScope: { providerScope: string } } }) => {
    const scope = where.organizationId_provider_providerScope.providerScope;
    if (scope === "form-89:2025-26") return Promise.resolve({ id: "identity-1", externalId: "90541" });
    return Promise.resolve(targetImport && scope === "form-89:2026-27" ? { id: "identity-2" } : null);
  });
}

function roster(fromRows: ReturnType<typeof row>[], onTarget: Array<{ personId: string }> = []) {
  mocks.rosterFindMany.mockImplementation(({ where }: { where: { clubYear: string } }) =>
    Promise.resolve(where.clubYear === "2025-26" ? fromRows : onTarget));
}

const post = (body: unknown) => POST(
  new Request("https://events.imsda.test/api/admin/organizations/club-1/club-import-year", {
    method: "POST",
    headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
    body: JSON.stringify(body),
  }),
  { params: Promise.resolve({ organizationId: "club-1" }) },
);

beforeEach(() => {
  vi.clearAllMocks();
  identities();
  roster([row("1"), row("2"), row("3", { status: "REMOVED", personId: null, person: null })]);
  mocks.rosterUpdateMany.mockResolvedValue({ count: 3 });
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.requireSystemAdministrator.mockResolvedValue({ id: "admin-1" });
});

describe("previewing a move (#541)", () => {
  it("counts the rows and changes nothing", async () => {
    const preview = await previewImportYearMove("club-1", "2025-26", "2026-27", now);
    expect(preview).toMatchObject({ fromYear: "2025-26", toYear: "2026-27", identityId: "identity-1", rowsToMove: 3, peopleOnRoster: 2, conflicts: [] });
    expect(mocks.rosterFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: "club-1", clubYear: "2025-26", source: "IMPORT" } }));
    expect(mocks.rosterUpdateMany).not.toHaveBeenCalled();
    expect(mocks.identityUpdate).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("lists every conflict: an import in the target year, someone already there, a transfer", async () => {
    identities(true);
    roster([row("1"), row("2", { transferAsReceiver: { id: "transfer-1" } })], [{ personId: "person-1" }]);
    const preview = await previewImportYearMove("club-1", "2025-26", "2026-27", now);
    expect(preview.conflicts).toEqual([
      { kind: "TARGET_HAS_IMPORT", toYear: "2026-27" },
      { kind: "ALREADY_ON_TARGET_ROSTER", rosterMemberId: "1", name: "Robin Fixture1" },
      { kind: "IN_TRANSFER", rosterMemberId: "2", name: "Robin Fixture2" },
    ]);
    expect(preview.conflicts.map((conflict) => conflictLabel(conflict, "2026-27"))).toEqual([
      "This club already has a 2026-27 import. Nothing can be moved into 2026-27 until that one is moved or undone.",
      "Robin Fixture1 is already on the 2026-27 roster.",
      "Robin Fixture2 is part of a member transfer, which is recorded for this club year.",
    ]);
  });

  it("offers only the previous, current, and next year, other than its own", async () => {
    for (const toYear of ["2024-25", "2028-29", "2025-26"]) {
      await expect(previewImportYearMove("club-1", "2025-26", toYear, now)).rejects.toMatchObject({ code: "INVALID_TARGET_YEAR" });
    }
    await expect(previewImportYearMove("club-1", "2027-28", "2026-27", now)).rejects.toMatchObject({ code: "IMPORT_NOT_FOUND" });
  });
});

describe("moving an import (#541)", () => {
  it("moves the rows and the identity together, creates and deletes no one, and audits counts and ids only", async () => {
    const moved = await moveImportYear("club-1", "2025-26", "2026-27", "admin-1", now);
    expect(moved).toMatchObject({ rowsMoved: 3, toYear: "2026-27" });
    expect(mocks.rosterUpdateMany).toHaveBeenCalledWith({
      where: { organizationId: "club-1", clubYear: "2025-26", source: "IMPORT" },
      data: { clubYear: "2026-27" },
    });
    expect(mocks.identityUpdate).toHaveBeenCalledWith({
      where: { id: "identity-1" },
      data: { providerScope: "form-89:2026-27", displayLabel: "Yearly club registration, 2026-27" },
    });
    expect(mocks.personCreate).not.toHaveBeenCalled();
    expect(mocks.personDelete).not.toHaveBeenCalled();
    const [audit, tx] = mocks.writeAuditLog.mock.calls[0];
    expect(tx).toBe(client);
    expect(audit).toMatchObject({
      action: "CLUB_IMPORT_YEAR_MOVED",
      actorUserId: "admin-1",
      entityId: "club-1",
      metadata: { organizationId: "club-1", externalIdentityId: "identity-1", fromYear: "2025-26", toYear: "2026-27", rowsMoved: 3, peopleOnRoster: 2 },
    });
    expect(JSON.stringify(audit)).not.toMatch(/Robin|Fixture/);
  });

  it("refuses the whole move on any conflict, listing it and changing nothing", async () => {
    roster([row("1"), row("2")], [{ personId: "person-2" }]);
    const error = await moveImportYear("club-1", "2025-26", "2026-27", "admin-1", now).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ImportYearMoveError);
    expect(error).toMatchObject({ code: "IMPORT_MOVE_CONFLICT", preview: { conflicts: [{ kind: "ALREADY_ON_TARGET_ROSTER", rosterMemberId: "2" }] } });
    expect(mocks.rosterUpdateMany).not.toHaveBeenCalled();
    expect(mocks.identityUpdate).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("lists a club's imports by year with their roster counts", async () => {
    mocks.identityFindMany.mockResolvedValue([
      { id: "identity-2", providerScope: "form-89:2026-27", externalId: "90542" },
      { id: "identity-1", providerScope: "form-89:2025-26", externalId: "90541" },
    ]);
    mocks.rosterCount.mockResolvedValueOnce(12).mockResolvedValueOnce(48);
    expect(await listClubImports("club-1")).toEqual([
      { identityId: "identity-1", entryId: "90541", clubYear: "2025-26", peopleOnRoster: 48 },
      { identityId: "identity-2", entryId: "90542", clubYear: "2026-27", peopleOnRoster: 12 },
    ]);
  });
});

describe("the move route (#541)", () => {
  // The route uses today's club year; pin it.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is for system administrators only", async () => {
    mocks.requireSystemAdministrator.mockRejectedValue(new AccessDeniedError("Only system administrators can do that.", 403, "PERMISSION_DENIED"));
    const response = await post({ fromYear: "2025-26", toYear: "2026-27", mode: "move" });
    expect(response.status).toBe(403);
    expect(mocks.rosterUpdateMany).not.toHaveBeenCalled();
    expect(mocks.identityFindUnique).not.toHaveBeenCalled();
  });

  it("previews, then moves", async () => {
    const preview = await post({ fromYear: "2025-26", toYear: "2026-27", mode: "preview" });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ preview: { rowsToMove: 3, conflicts: [] } });
    expect(mocks.rosterUpdateMany).not.toHaveBeenCalled();

    const moved = await post({ fromYear: "2025-26", toYear: "2026-27", mode: "move" });
    expect(moved.status).toBe(200);
    expect(await moved.json()).toMatchObject({ moved: { rowsMoved: 3 } });
  });

  it("answers a conflict with 409 and the conflicts, and a bad request with 400", async () => {
    identities(true);
    const refused = await post({ fromYear: "2025-26", toYear: "2026-27", mode: "move" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "IMPORT_MOVE_CONFLICT", preview: { conflicts: [{ kind: "TARGET_HAS_IMPORT" }] } });
    expect((await post({ fromYear: "2025-26", toYear: "2026-27", mode: "merge" })).status).toBe(400);
    expect((await post({ fromYear: "2025-26", toYear: "2023-24", mode: "move" })).status).toBe(400);
  });
});
