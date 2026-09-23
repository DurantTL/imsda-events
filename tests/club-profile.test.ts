import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  writeAuditLog: vi.fn(),
  findOrganization: vi.fn(),
  updateOrganization: vi.fn(),
  upsertProfile: vi.fn(),
}));

const client = {
  organization: { findUnique: mocks.findOrganization, update: mocks.updateOrganization },
  clubProfile: { upsert: mocks.upsertProfile },
  $transaction: (work: (tx: unknown) => unknown) => work(client),
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => client }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));

import { updateClubProfile } from "@/modules/organizations/club-profile-repository";
import { clubProfileInputSchema } from "@/modules/organizations/club-profile-schemas";

const stored = {
  id: "club-1",
  type: "CLUB",
  name: "Test Pathfinders",
  isActive: true,
  parentOrganizationId: "church-1",
  parentOrganization: { id: "church-1", name: "Example Church" },
  clubProfile: null,
};

const input = (overrides: Record<string, unknown> = {}) => clubProfileInputSchema.parse({
  name: "Test Pathfinders",
  sponsoringChurchId: "church-1",
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findOrganization.mockImplementation(({ where }: { where: { id: string } }) => Promise.resolve(
    where.id === "church-2" ? { type: "CHURCH", isActive: true }
      : where.id === "club-9" ? { type: "CLUB", isActive: true }
        : stored,
  ));
});

describe("club profile (#375)", () => {
  it("saves and audits only the fields that changed, without their values", async () => {
    await updateClubProfile("club-1", input({ name: "Renamed Pathfinders", meetingPlace: "Fellowship hall" }), { accountId: "account-1" });
    expect(mocks.updateOrganization).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ name: "Renamed Pathfinders", normalizedName: "renamed pathfinders" }),
    }));
    expect(mocks.upsertProfile).toHaveBeenCalledOnce();
    const entry = mocks.writeAuditLog.mock.calls[0][0];
    expect(entry).toMatchObject({ action: "CLUB_PROFILE_UPDATED", metadata: { fields: ["name", "meetingPlace"], actorAttendeeAccountId: "account-1" } });
    expect(JSON.stringify(entry.metadata)).not.toContain("Fellowship");
  });

  it("records a staff editor as the audit actor", async () => {
    await updateClubProfile("club-1", input({ contactPhone: "555-0100" }), { userId: "staff-1" });
    expect(mocks.writeAuditLog.mock.calls[0][0]).toMatchObject({ actorUserId: "staff-1" });
  });

  it("writes nothing when nothing changed", async () => {
    await updateClubProfile("club-1", input(), { accountId: "account-1" });
    expect(mocks.updateOrganization).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("accepts only an active church as sponsor", async () => {
    await updateClubProfile("club-1", input({ sponsoringChurchId: "church-2" }), { accountId: "account-1" });
    expect(mocks.updateOrganization).toHaveBeenCalled();
    await expect(updateClubProfile("club-1", input({ sponsoringChurchId: "club-9" }), { accountId: "account-1" }))
      .rejects.toMatchObject({ code: "ORGANIZATION_PARENT_INVALID" });
  });

  it("rejects a bad contact email but allows a blank one", () => {
    expect(clubProfileInputSchema.safeParse({ name: "Club", contactEmail: "not-an-email" }).success).toBe(false);
    expect(clubProfileInputSchema.safeParse({ name: "Club", contactEmail: "" }).success).toBe(true);
  });
});
