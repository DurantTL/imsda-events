import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The church location route (#437) end to end through the real permission
 * check and repository: only the session and the database are stubbed.
 * Matches what the sibling organization routes return — 401 signed out,
 * 403 for anyone but a system administrator, 404 for anything that is not
 * an existing church.
 */
const mocks = vi.hoisted(() => ({
  rejectCrossOriginRequest: vi.fn(),
  getCurrentSession: vi.fn(),
  findOrganization: vi.fn(),
  upsertLocation: vi.fn(),
  writeAuditLog: vi.fn(),
}));

const client = {
  organization: { findUnique: mocks.findOrganization },
  churchLocation: { upsert: mocks.upsertLocation },
  $transaction: (work: (tx: unknown) => unknown) => work(client),
};

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/request-security", () => ({
  rejectCrossOriginRequest: mocks.rejectCrossOriginRequest,
}));
vi.mock("@/modules/access/current-session", () => ({
  getCurrentSession: mocks.getCurrentSession,
}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => client }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));

import { PATCH } from "@/app/api/admin/organizations/[organizationId]/location/route";

const validBody = { city: "Sampleton", state: "IA", zip: "50000", latitude: 41.5, longitude: -93.5 };

function patch(organizationId: string) {
  return PATCH(
    new Request(`https://events.imsda.test/api/admin/organizations/${organizationId}/location`, {
      method: "PATCH",
      headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
      body: JSON.stringify(validBody),
    }),
    { params: Promise.resolve({ organizationId }) },
  );
}

const admin = { user: { id: "admin-1", globalRole: "SYSTEM_ADMIN", email: "admin@example.test", name: "Test Admin" } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
});

describe("church location route gates (#437)", () => {
  it("answers 401 when nobody is signed in", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: null });
    const response = await patch("church-1");
    expect(response.status).toBe(401);
    expect(mocks.findOrganization).not.toHaveBeenCalled();
    expect(mocks.upsertLocation).not.toHaveBeenCalled();
  });

  it("answers 403 for a signed-in user who is not a system administrator", async () => {
    mocks.getCurrentSession.mockResolvedValue({
      user: { id: "staff-1", globalRole: null, email: "staff@example.test", name: "Test Staff" },
    });
    const response = await patch("church-1");
    expect(response.status).toBe(403);
    expect(mocks.findOrganization).not.toHaveBeenCalled();
    expect(mocks.upsertLocation).not.toHaveBeenCalled();
  });

  it("answers 404 for an organization that does not exist", async () => {
    mocks.getCurrentSession.mockResolvedValue(admin);
    mocks.findOrganization.mockResolvedValue(null);
    const response = await patch("missing-church");
    expect(response.status).toBe(404);
    expect(mocks.upsertLocation).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("answers 404 for a club id: only churches carry a location", async () => {
    mocks.getCurrentSession.mockResolvedValue(admin);
    mocks.findOrganization.mockResolvedValue({ id: "club-1", type: "CLUB", name: "Sample Club", churchLocation: null });
    const response = await patch("club-1");
    expect(response.status).toBe(404);
    expect(mocks.upsertLocation).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });
});
