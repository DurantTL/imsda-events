import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  writeAuditLog: vi.fn(),
  findOrganization: vi.fn(),
  upsertLocation: vi.fn(),
}));

const client = {
  organization: { findUnique: mocks.findOrganization },
  churchLocation: { upsert: mocks.upsertLocation },
  $transaction: (work: (tx: unknown) => unknown) => work(client),
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => client }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));

import { updateChurchLocation } from "@/modules/organizations/church-location-repository";
import { churchLocationInputSchema } from "@/modules/organizations/church-location-schemas";

const stored = {
  id: "church-1",
  type: "CHURCH",
  name: "First Church",
  churchLocation: null,
};

const input = (overrides: Record<string, unknown> = {}) => churchLocationInputSchema.parse({
  city: "Ames",
  state: "IA",
  zip: "50010",
  latitude: 42.03,
  longitude: -93.62,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findOrganization.mockImplementation(({ where }: { where: { id: string } }) => Promise.resolve(
    where.id === "club-1" ? { type: "CLUB" } : stored,
  ));
});

describe("church location zod validation (#437)", () => {
  it("accepts a valid location with coordinates", () => {
    expect(churchLocationInputSchema.safeParse({
      city: "Ames", state: "IA", zip: "50010", latitude: 42.03, longitude: -93.62,
    }).success).toBe(true);
  });

  it("accepts a location with no coordinates yet", () => {
    const result = churchLocationInputSchema.safeParse({ city: "Ames", state: "IA", zip: "50010" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.latitude).toBeNull();
      expect(result.data.longitude).toBeNull();
    }
  });

  it("rejects latitude out of range", () => {
    expect(churchLocationInputSchema.safeParse({ latitude: 91, longitude: 0 }).success).toBe(false);
    expect(churchLocationInputSchema.safeParse({ latitude: -91, longitude: 0 }).success).toBe(false);
  });

  it("rejects longitude out of range", () => {
    expect(churchLocationInputSchema.safeParse({ latitude: 0, longitude: 181 }).success).toBe(false);
    expect(churchLocationInputSchema.safeParse({ latitude: 0, longitude: -181 }).success).toBe(false);
  });

  it("rejects one coordinate given without the other", () => {
    expect(churchLocationInputSchema.safeParse({ latitude: 42.03, longitude: null }).success).toBe(false);
    expect(churchLocationInputSchema.safeParse({ latitude: null, longitude: -93.62 }).success).toBe(false);
  });

  it("rejects a malformed ZIP but accepts a blank one and a ZIP+4", () => {
    expect(churchLocationInputSchema.safeParse({ zip: "not-a-zip" }).success).toBe(false);
    expect(churchLocationInputSchema.safeParse({ zip: "5001" }).success).toBe(false);
    expect(churchLocationInputSchema.safeParse({ zip: "" }).success).toBe(true);
    expect(churchLocationInputSchema.safeParse({ zip: "50010-1234" }).success).toBe(true);
  });
});

describe("church location repository (#437)", () => {
  it("saves and audits only the fields that changed, without their values", async () => {
    await updateChurchLocation("church-1", input(), "staff-1");
    expect(mocks.upsertLocation).toHaveBeenCalledWith(expect.objectContaining({
      where: { organizationId: "church-1" },
      create: expect.objectContaining({ organizationId: "church-1", city: "Ames", latitude: 42.03 }),
    }));
    const entry = mocks.writeAuditLog.mock.calls[0][0];
    expect(entry).toMatchObject({
      actorUserId: "staff-1",
      action: "CHURCH_LOCATION_UPDATED",
      metadata: { fields: expect.arrayContaining(["city", "state", "zip", "latitude", "longitude"]) },
    });
    // Coordinates and ZIP never appear in the audited metadata.
    expect(JSON.stringify(entry.metadata)).not.toContain("42.03");
    expect(JSON.stringify(entry.metadata)).not.toContain("50010");
  });

  it("writes nothing when nothing changed", async () => {
    mocks.findOrganization.mockResolvedValueOnce({
      id: "church-1",
      type: "CHURCH",
      name: "First Church",
      churchLocation: { city: "Ames", state: "IA", zip: "50010", latitude: 42.03, longitude: -93.62 },
    });
    await updateChurchLocation("church-1", input(), "staff-1");
    expect(mocks.upsertLocation).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("rejects a club, since only churches have a location", async () => {
    await expect(updateChurchLocation("club-1", input(), "staff-1"))
      .rejects.toMatchObject({ code: "ORGANIZATION_NOT_FOUND" });
  });
});
