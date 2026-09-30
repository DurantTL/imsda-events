import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ memberFindMany: vi.fn() }));
const client = { clubRosterMember: { findMany: mocks.memberFindMany } };

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
    expect(Object.keys(select).sort()).toEqual(["organizationId", "person", "personId"]);
  });
});
