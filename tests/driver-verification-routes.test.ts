import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireGlobalDriverReviewAccess: vi.fn(),
  requireClubDriverReviewAccess: vi.fn(),
  listWillingDrivers: vi.fn(),
  recordDriverClearance: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/driver-verification/access", async () => {
  const actual = await vi.importActual<typeof import("@/modules/driver-verification/access")>("@/modules/driver-verification/access");
  return {
    ...actual,
    requireGlobalDriverReviewAccess: mocks.requireGlobalDriverReviewAccess,
    requireClubDriverReviewAccess: mocks.requireClubDriverReviewAccess,
  };
});
vi.mock("@/modules/driver-verification/repository", async () => {
  const actual = await vi.importActual<typeof import("@/modules/driver-verification/repository")>("@/modules/driver-verification/repository");
  return { ...actual, listWillingDrivers: mocks.listWillingDrivers, recordDriverClearance: mocks.recordDriverClearance };
});

import { AccessDeniedError } from "@/modules/access/authorization";
import { RosterAccessError } from "@/modules/club-rosters/access";
import { DriverVerificationError } from "@/modules/driver-verification/repository";
import { GET as adminList } from "@/app/api/admin/driver-verification/route";
import { POST as adminClear } from "@/app/api/admin/driver-verification/[personId]/route";
import { GET as clubList } from "@/app/api/attendee/clubs/[organizationId]/driver-verification/route";
import { POST as clubClear } from "@/app/api/attendee/clubs/[organizationId]/driver-verification/[personId]/route";

const jsonRequest = (url: string, body: unknown) => new Request(url, {
  method: "POST",
  headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
  body: JSON.stringify(body),
});

const validClearance = { clearedToTransport: true, note: "Checked.", confirmedChecksReviewed: true };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.listWillingDrivers.mockResolvedValue([]);
});

describe("the conference-wide driver verification queue (system admin only)", () => {
  const adminListRequest = () => new Request("https://events.imsda.test/api/admin/driver-verification");

  it("refuses anyone who isn't a system administrator", async () => {
    mocks.requireGlobalDriverReviewAccess.mockRejectedValue(new AccessDeniedError("nope", 403, "PERMISSION_DENIED"));
    const response = await adminList(adminListRequest());
    expect(response.status).toBe(403);
    expect(mocks.listWillingDrivers).not.toHaveBeenCalled();
  });

  it("lists the global queue for a system administrator", async () => {
    mocks.requireGlobalDriverReviewAccess.mockResolvedValue({ userId: "admin-1" });
    mocks.listWillingDrivers.mockResolvedValue([{ personId: "person-1" }]);
    const response = await adminList(adminListRequest());
    expect(response.status).toBe(200);
    expect(mocks.listWillingDrivers).toHaveBeenCalledWith({ kind: "GLOBAL" });
    await expect(response.json()).resolves.toEqual({ entries: [{ personId: "person-1" }] });
  });

  it("validates the review body before recording anything", async () => {
    mocks.requireGlobalDriverReviewAccess.mockResolvedValue({ userId: "admin-1" });
    const response = await adminClear(
      jsonRequest("https://events.imsda.test/api/admin/driver-verification/person-1", { clearedToTransport: true }),
      { params: Promise.resolve({ personId: "person-1" }) },
    );
    expect(response.status).toBe(400);
    expect(mocks.recordDriverClearance).not.toHaveBeenCalled();
  });

  it("records a system administrator's decision", async () => {
    mocks.requireGlobalDriverReviewAccess.mockResolvedValue({ userId: "admin-1" });
    mocks.recordDriverClearance.mockResolvedValue(undefined);
    const response = await adminClear(
      jsonRequest("https://events.imsda.test/api/admin/driver-verification/person-1", validClearance),
      { params: Promise.resolve({ personId: "person-1" }) },
    );
    expect(response.status).toBe(200);
    expect(mocks.recordDriverClearance).toHaveBeenCalledWith(
      "person-1", { kind: "GLOBAL" }, { clearedToTransport: true, note: "Checked." }, { userId: "admin-1" },
    );
  });

  it("turns self-nomination into a 403, never a silent clear", async () => {
    mocks.requireGlobalDriverReviewAccess.mockResolvedValue({ userId: "admin-1" });
    mocks.recordDriverClearance.mockRejectedValue(new DriverVerificationError("SELF_REVIEW", "You can't clear yourself."));
    const response = await adminClear(
      jsonRequest("https://events.imsda.test/api/admin/driver-verification/person-1", validClearance),
      { params: Promise.resolve({ personId: "person-1" }) },
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "SELF_REVIEW" });
  });
});

describe("a club's own driver verification queue (director or deputy only)", () => {
  const ctx = { params: Promise.resolve({ organizationId: "club-1" }) };

  it("refuses a registrar (no manageTeam capability)", async () => {
    mocks.requireClubDriverReviewAccess.mockRejectedValue(new RosterAccessError("ROLE_NOT_ALLOWED", 403, "Your club role doesn't include this."));
    const response = await clubList(new Request("https://events.imsda.test/api/attendee/clubs/club-1/driver-verification"), ctx);
    expect(response.status).toBe(403);
    expect(mocks.listWillingDrivers).not.toHaveBeenCalled();
  });

  it("lists only this club's queue for a director", async () => {
    mocks.requireClubDriverReviewAccess.mockResolvedValue({
      state: "OK", club: {}, capabilities: {}, actor: { kind: "ATTENDEE", accountId: "director-1", sessionId: "session-1" },
    });
    await clubList(new Request("https://events.imsda.test/api/attendee/clubs/club-1/driver-verification"), ctx);
    expect(mocks.listWillingDrivers).toHaveBeenCalledWith({ kind: "CLUB", organizationId: "club-1" });
  });

  it("refuses self-nomination for a director reviewing their own record", async () => {
    mocks.requireClubDriverReviewAccess.mockResolvedValue({
      state: "OK", club: {}, capabilities: {}, actor: { kind: "ATTENDEE", accountId: "director-1", sessionId: "session-1" },
    });
    mocks.recordDriverClearance.mockRejectedValue(new DriverVerificationError("SELF_REVIEW", "You can't clear yourself."));
    const response = await clubClear(
      jsonRequest("https://events.imsda.test/api/attendee/clubs/club-1/driver-verification/person-1", validClearance),
      { params: Promise.resolve({ organizationId: "club-1", personId: "person-1" }) },
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "SELF_REVIEW" });
  });

  it("records a director's decision scoped to their own club", async () => {
    const actor = { kind: "ATTENDEE" as const, accountId: "director-1", sessionId: "session-1" };
    mocks.requireClubDriverReviewAccess.mockResolvedValue({ state: "OK", club: {}, capabilities: {}, actor });
    mocks.recordDriverClearance.mockResolvedValue(undefined);
    const response = await clubClear(
      jsonRequest("https://events.imsda.test/api/attendee/clubs/club-1/driver-verification/person-1", validClearance),
      { params: Promise.resolve({ organizationId: "club-1", personId: "person-1" }) },
    );
    expect(response.status).toBe(200);
    expect(mocks.recordDriverClearance).toHaveBeenCalledWith(
      "person-1", { kind: "CLUB", organizationId: "club-1" }, { clearedToTransport: true, note: "Checked." }, actor,
    );
  });
});
