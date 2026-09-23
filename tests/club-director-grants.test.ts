import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  writeAuditLog: vi.fn(),
  transaction: vi.fn(),
  findOrganization: vi.fn(),
  findAccount: vi.fn(),
  findGrants: vi.fn(),
  findGrant: vi.fn(),
  createGrant: vi.fn(),
  updateGrants: vi.fn(),
  getCurrentAttendee: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({
  getCurrentAttendee: mocks.getCurrentAttendee,
}));

import { Prisma } from "@prisma/client";
import {
  directorGrantIsActive,
  directorGrantStatus,
  directorGrantWindowsOverlap,
} from "@/modules/organizations/director-grants-domain";
import {
  createDirectorGrant,
  revokeDirectorGrant,
} from "@/modules/organizations/director-grants-repository";
import { createDirectorGrantInputSchema } from "@/modules/organizations/director-grants-schemas";
import {
  findDirectedClub,
  listDirectedClubs,
} from "@/modules/organizations/director-access";

const now = new Date("2026-10-01T12:00:00Z");
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

const client = {
  organization: { findUnique: mocks.findOrganization },
  attendeeAccount: { findUnique: mocks.findAccount },
  clubDirectorGrant: {
    findMany: mocks.findGrants,
    findFirst: mocks.findGrant,
    create: mocks.createGrant,
    updateMany: mocks.updateGrants,
  },
};

const activeClub = { id: "club-1", name: "Test Pathfinders", type: "CLUB", isActive: true };
const verifiedAccount = {
  id: "account-1",
  status: "ACTIVE",
  emailVerifiedAt: day("2026-01-01"),
  disabledAt: null,
};

function grantInput(overrides: Record<string, unknown> = {}) {
  return createDirectorGrantInputSchema.parse({
    email: " Director@Example.test ",
    reason: "Church board vote",
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation(async (work: (tx: typeof client) => unknown) => work(client));
  mocks.getPrisma.mockReturnValue({ ...client, $transaction: mocks.transaction });
  mocks.findOrganization.mockResolvedValue(activeClub);
  mocks.findAccount.mockResolvedValue(verifiedAccount);
  mocks.findGrants.mockResolvedValue([]);
  mocks.createGrant.mockResolvedValue({ id: "grant-1" });
  mocks.updateGrants.mockResolvedValue({ count: 1 });
  mocks.writeAuditLog.mockResolvedValue({});
});

describe("director grant rules", () => {
  const window = { effectiveFrom: day("2026-09-01"), effectiveTo: day("2027-09-01"), revokedAt: null };

  it("derives status from the date window, with revocation winning", () => {
    expect(directorGrantStatus(window, now)).toBe("ACTIVE");
    expect(directorGrantStatus({ ...window, effectiveFrom: day("2026-11-01") }, now)).toBe("SCHEDULED");
    expect(directorGrantStatus({ ...window, effectiveTo: now }, now)).toBe("ENDED");
    expect(directorGrantStatus({ ...window, revokedAt: day("2026-09-15") }, now)).toBe("REVOKED");
    expect(directorGrantIsActive({ ...window, effectiveTo: null }, now)).toBe(true);
  });

  it("treats windows as half-open and a missing end as open-ended", () => {
    const first = { effectiveFrom: day("2026-01-01"), effectiveTo: day("2026-06-01") };
    expect(directorGrantWindowsOverlap(first, { effectiveFrom: day("2026-06-01"), effectiveTo: null })).toBe(false);
    expect(directorGrantWindowsOverlap(first, { effectiveFrom: day("2026-05-31"), effectiveTo: null })).toBe(true);
    expect(directorGrantWindowsOverlap({ effectiveFrom: day("2026-01-01"), effectiveTo: null }, first)).toBe(true);
  });

  it("normalizes the email and requires a reason", () => {
    expect(grantInput()).toMatchObject({ email: "director@example.test", role: "DIRECTOR", effectiveTo: null });
    expect(() => grantInput({ reason: "  " })).toThrow();
    expect(() => grantInput({ extra: true })).toThrow();
  });
});

describe("director grant repository", () => {
  it("grants a verified account on an active club and audits without the email", async () => {
    await createDirectorGrant("club-1", grantInput({ role: "DEPUTY" }), "admin-1", now);

    expect(mocks.findAccount).toHaveBeenCalledWith(expect.objectContaining({
      where: { email: "director@example.test" },
    }));
    expect(mocks.createGrant).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: "club-1",
        attendeeAccountId: "account-1",
        role: "DEPUTY",
        effectiveFrom: now,
        effectiveTo: null,
        grantedByUserId: "admin-1",
      }),
    });
    const [entry] = mocks.writeAuditLog.mock.calls[0];
    expect(entry).toMatchObject({ action: "CLUB_DIRECTOR_GRANTED", entityId: "grant-1" });
    expect(JSON.stringify(entry)).not.toContain("director@example.test");
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  });

  it.each([
    ["a church", { ...activeClub, type: "CHURCH" }, "CLUB_REQUIRED"],
    ["an inactive club", { ...activeClub, isActive: false }, "CLUB_INACTIVE"],
    ["a missing club", null, "ORGANIZATION_NOT_FOUND"],
  ])("refuses %s", async (_label, organization, code) => {
    mocks.findOrganization.mockResolvedValue(organization);
    await expect(createDirectorGrant("club-1", grantInput(), "admin-1", now)).rejects.toMatchObject({ code });
    expect(mocks.createGrant).not.toHaveBeenCalled();
  });

  it.each([
    ["no account", null],
    ["an unverified account", { ...verifiedAccount, status: "PENDING_VERIFICATION", emailVerifiedAt: null }],
    ["a disabled account", { ...verifiedAccount, disabledAt: day("2026-09-01") }],
  ])("refuses %s and says how to fix it", async (_label, account) => {
    mocks.findAccount.mockResolvedValue(account);
    await expect(createDirectorGrant("club-1", grantInput(), "admin-1", now)).rejects.toMatchObject({
      code: "ATTENDEE_ACCOUNT_NOT_FOUND",
      message: expect.stringContaining("/account/sign-up"),
    });
  });

  it("rejects an end date that is past or before the start", async () => {
    await expect(createDirectorGrant("club-1", grantInput({
      effectiveTo: "2026-09-01T00:00:00Z",
    }), "admin-1", now)).rejects.toMatchObject({ code: "DIRECTOR_GRANT_WINDOW_INVALID" });
    await expect(createDirectorGrant("club-1", grantInput({
      effectiveFrom: "2027-01-01T00:00:00Z",
      effectiveTo: "2026-12-01T00:00:00Z",
    }), "admin-1", now)).rejects.toMatchObject({ code: "DIRECTOR_GRANT_WINDOW_INVALID" });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects an overlapping unrevoked grant for the same person and club", async () => {
    mocks.findGrants.mockResolvedValueOnce([{ effectiveFrom: day("2026-01-01"), effectiveTo: null }]);
    await expect(createDirectorGrant("club-1", grantInput(), "admin-1", now)).rejects.toMatchObject({
      code: "DIRECTOR_GRANT_CONFLICT",
    });
    expect(mocks.findGrants).toHaveBeenCalledWith(expect.objectContaining({
      where: { organizationId: "club-1", attendeeAccountId: "account-1", revokedAt: null },
    }));
  });

  it("retries a serialization failure", async () => {
    mocks.transaction
      .mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("conflict", {
        code: "P2034",
        clientVersion: "test",
      }));
    await createDirectorGrant("club-1", grantInput(), "admin-1", now);
    expect(mocks.transaction).toHaveBeenCalledTimes(2);
    expect(mocks.createGrant).toHaveBeenCalledTimes(1);
  });

  it("revokes once, scoped to the club, and audits the reason", async () => {
    await revokeDirectorGrant("club-1", "grant-1", "Stepped down", "admin-1", now);
    expect(mocks.updateGrants).toHaveBeenCalledWith({
      where: { id: "grant-1", organizationId: "club-1", revokedAt: null },
      data: { revokedAt: now, revokedByUserId: "admin-1", revokeReason: "Stepped down" },
    });
    expect(mocks.writeAuditLog.mock.calls[0][0]).toMatchObject({ action: "CLUB_DIRECTOR_REVOKED" });
  });

  it("distinguishes an already-revoked grant from a missing one", async () => {
    mocks.updateGrants.mockResolvedValue({ count: 0 });
    mocks.findGrant.mockResolvedValueOnce({ id: "grant-1" });
    await expect(revokeDirectorGrant("club-1", "grant-1", "Again", "admin-1", now))
      .rejects.toMatchObject({ code: "DIRECTOR_GRANT_ALREADY_REVOKED" });
    mocks.findGrant.mockResolvedValueOnce(null);
    await expect(revokeDirectorGrant("club-1", "grant-9", "Missing", "admin-1", now))
      .rejects.toMatchObject({ code: "DIRECTOR_GRANT_NOT_FOUND" });
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });
});

describe("director access", () => {
  const row = (id: string, role: "DIRECTOR" | "DEPUTY", church: string | null = "Test Church") => ({
    role,
    organization: { id, name: `Club ${id}`, parentOrganization: church ? { name: church } : null },
  });

  it("asks only for unrevoked, in-window grants on active clubs", async () => {
    mocks.findGrants.mockResolvedValue([]);
    await listDirectedClubs("account-1", now);
    expect(mocks.findGrants).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        attendeeAccountId: "account-1",
        revokedAt: null,
        effectiveFrom: { lte: now },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
        organization: { type: "CLUB", isActive: true },
      },
    }));
  });

  it("lists each club once with its sponsoring church", async () => {
    mocks.findGrants.mockResolvedValue([row("a", "DIRECTOR"), row("a", "DEPUTY"), row("b", "DEPUTY", null)]);
    await expect(listDirectedClubs("account-1", now)).resolves.toEqual([
      { organizationId: "a", name: "Club a", role: "DIRECTOR", sponsoringChurch: "Test Church" },
      { organizationId: "b", name: "Club b", role: "DEPUTY", sponsoringChurch: null },
    ]);
  });

  it("finds nothing for a signed-out visitor or a club they do not direct", async () => {
    mocks.getCurrentAttendee.mockResolvedValueOnce({ account: null, via: null, sessionId: null });
    await expect(findDirectedClub("a", now)).resolves.toBeNull();
    expect(mocks.findGrants).not.toHaveBeenCalled();

    mocks.getCurrentAttendee.mockResolvedValue({ account: { id: "account-1" }, via: "attendee", sessionId: "s" });
    mocks.findGrants.mockResolvedValue([row("a", "DIRECTOR")]);
    await expect(findDirectedClub("other", now)).resolves.toBeNull();
    await expect(findDirectedClub("a", now)).resolves.toMatchObject({ organizationId: "a" });
  });
});
