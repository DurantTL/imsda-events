import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ memberFindMany: vi.fn(), entryFindMany: vi.fn() }));
const client = {
  clubRosterMember: { findMany: mocks.memberFindMany },
  backgroundCheckEntry: { findMany: mocks.entryFindMany },
  backgroundCheckRejectedPairing: { findMany: async () => [] },
  registrationAttendee: { findMany: async () => [] },
  organization: { findMany: async () => [] },
  $queryRaw: async () => [{ id: "person-u", firstName: "Pat", lastName: "Sample" }],
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => client }));

import { clubComplianceReminderCounts, clubsComplianceReminderCounts } from "@/modules/background-checks/repository";

const future = "2999-01-01";
const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
const past = "2000-01-01";
const member = (organizationId: string, id: string, entry: { complianceStatus?: string | null; expiresOn: string | null } | null) => ({
  id,
  organizationId,
  personId: `person-${id}`,
  sealedBirthDate: null,
  organization: { name: "Club", parentOrganization: null },
  person: { firstName: "Test", lastName: id, normalizedEmail: null, attendeeAccountLinks: [], backgroundCheckMatch: entry ? { entry } : null },
});

// Synthetic adult roster rows for two clubs; every person with a check has a cached match.
const rows = [
  member("club-a", "1", { expiresOn: future }),
  member("club-a", "2", { expiresOn: soon }),
  member("club-a", "3", { expiresOn: past }),
  member("club-a", "4", { complianceStatus: "NOT_COMPLIANT", expiresOn: null }),
  member("club-a", "5", { expiresOn: null }),
  member("club-b", "6", { expiresOn: future }),
  member("club-b", "7", { complianceStatus: "FLAGGED", expiresOn: null }),
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.memberFindMany.mockImplementation(async (args: { where: { organizationId: string | { in: string[] } } }) => {
    const filter = args.where.organizationId;
    return rows.filter((row) => (typeof filter === "string" ? row.organizationId === filter : filter.in.includes(row.organizationId)));
  });
});

describe("batched club background-check counts (#657)", () => {
  it("gives the same counts as the per-club reminder counts", async () => {
    const batched = await clubsComplianceReminderCounts(["club-a", "club-b", "club-empty"], "2026-27");
    for (const id of ["club-a", "club-b", "club-empty"]) {
      const single = await clubComplianceReminderCounts(id, "2026-27");
      expect(batched.get(id)).toEqual({ missing: single.missing, notInCompliance: single.notInCompliance, expiringSoon: single.expiringSoon });
    }
    expect(batched.get("club-a")).toEqual({ missing: 1, notInCompliance: 2, expiringSoon: 1 });
  });

  it("reads no names, emails, birth dates or notes", async () => {
    await clubsComplianceReminderCounts(["club-a", "club-b"], "2026-27");
    expect(mocks.memberFindMany).toHaveBeenCalledTimes(1);
    const select = mocks.memberFindMany.mock.calls[0]![0].select;
    expect(JSON.stringify(select)).not.toMatch(/firstName|lastName|email|sealedBirthDate|issuesNote/i);
    expect(Object.keys(select).sort()).toEqual(["id", "organizationId", "person", "personId"]);
  });

  it("finds a check for an adult with no cached match, so they are not counted as missing, and matches the per-club count", async () => {
    const uncachedMember = {
      ...member("club-c", "u", null),
      personId: "person-u",
      sealedBirthDate: null,
      person: { firstName: "Pat", lastName: "Sample", normalizedEmail: "pat@example.test", attendeeAccountLinks: [], backgroundCheckMatch: null },
    };
    const all = [...rows, uncachedMember];
    mocks.memberFindMany.mockImplementation(async (args: { where: { id?: { in: string[] }; personId?: unknown; organizationId?: string | { in: string[] } } }) => {
      const where = args.where;
      if (where.id) return all.filter((row) => where.id!.in.includes(row.id));
      // Candidate index for the identity lookup.
      if (where.personId) return [{ ...uncachedMember, attendeeType: "ADULT", organization: { name: "Club C", parentOrganization: null } }];
      const filter = where.organizationId!;
      return all.filter((row) => (typeof filter === "string" ? row.organizationId === filter : filter.in.includes(row.organizationId)));
    });
    mocks.entryFindMany.mockResolvedValue([{
      id: "entry-1", uploadId: "upload-1", identityKey: "key-1", normalizedName: "pat sample", email: "pat@example.test",
      sealedBirthDate: null, site: null, complianceStatus: null, expiresOn: future, issuesNote: null, upload: { createdAt: new Date("2026-09-01") },
    }]);

    const batched = await clubsComplianceReminderCounts(["club-a", "club-c"], "2026-27");
    const single = await clubComplianceReminderCounts("club-c", "2026-27");
    // The lookup found a current check: clear, not missing.
    expect(single).toEqual({ missing: 0, notInCompliance: 0, expiringSoon: 0 });
    expect(batched.get("club-c")).toEqual({ missing: single.missing, notInCompliance: single.notInCompliance, expiringSoon: single.expiringSoon });
    // One follow-up evidence query across clubs, only for the uncached member.
    const evidenceCalls = mocks.memberFindMany.mock.calls.filter(([args]) => args.where.id);
    expect(evidenceCalls.filter(([args]) => args.where.id.in.includes("u"))).toHaveLength(1);
    // Counts are all that comes back.
    expect(JSON.stringify([...batched.entries()])).not.toMatch(/Pat|Sample|pat@/);
  });
});
