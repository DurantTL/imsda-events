import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  findActiveMembership: vi.fn(),
  getCurrentSession: vi.fn(),
  listEventAssets: vi.fn(),
  createEventAsset: vi.fn(),
  removeEventAsset: vi.fn(),
  findEventAssetForStaff: vi.fn(),
  eventAssetResponse: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/modules/access/current-session", () => ({
  getCurrentSession: dependencies.getCurrentSession,
}));

vi.mock("@/modules/events/repository", () => ({
  findActiveMembership: dependencies.findActiveMembership,
}));

vi.mock("@/modules/events/asset-repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/events/asset-repository")>();
  return {
    ...actual,
    listEventAssets: dependencies.listEventAssets,
    createEventAsset: dependencies.createEventAsset,
    removeEventAsset: dependencies.removeEventAsset,
    findEventAssetForStaff: dependencies.findEventAssetForStaff,
  };
});

vi.mock("@/modules/events/asset-response", () => ({
  eventAssetResponse: dependencies.eventAssetResponse,
}));

import { GET as getAssets } from "@/app/api/events/[eventId]/assets/route";
import { DELETE as deleteAsset, GET as getAsset } from "@/app/api/events/[eventId]/assets/[assetId]/route";

const eventId = "event_1";
const assetId = "asset_1";
const origin = "https://events.imsda.test";

function request(path: string, method: string) {
  return new Request(`${origin}${path}`, { method, headers: { origin } });
}

const listParams = { params: Promise.resolve({ eventId }) };
const assetParams = { params: Promise.resolve({ eventId, assetId }) };

/** One route case per event-file endpoint, so an authorization defect can't
 * slip past by only being covered on one route (mirrors the merchandise
 * route coverage). */
const routeCases: Array<{ name: string; call: () => Promise<Response> }> = [
  { name: "GET list", call: () => getAssets(request(`/api/events/${eventId}/assets`, "GET"), listParams) },
  { name: "GET one", call: () => getAsset(request(`/api/events/${eventId}/assets/${assetId}`, "GET"), assetParams) },
  { name: "DELETE", call: () => deleteAsset(request(`/api/events/${eventId}/assets/${assetId}`, "DELETE"), assetParams) },
];

function expectNoRepositoryCalls() {
  expect(dependencies.listEventAssets).not.toHaveBeenCalled();
  expect(dependencies.findEventAssetForStaff).not.toHaveBeenCalled();
  expect(dependencies.removeEventAsset).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("event asset route authorization", () => {
  it.each(routeCases)("rejects an unauthenticated caller on $name", async ({ call }) => {
    dependencies.getCurrentSession.mockResolvedValue({ user: null });

    const response = await call();

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "AUTHENTICATION_REQUIRED" });
    expect(dependencies.findActiveMembership).not.toHaveBeenCalled();
    expectNoRepositoryCalls();
  });

  it.each(routeCases)("rejects a staff member without the CONFIGURE_EVENT permission on $name", async ({ call }) => {
    dependencies.getCurrentSession.mockResolvedValue({
      user: { id: "usr_readonly", email: "readonly@example.test", displayName: "Read Only Staff", globalRole: null },
    });
    dependencies.findActiveMembership.mockResolvedValue({
      eventId, userId: "usr_readonly", role: "READ_ONLY_STAFF", status: "ACTIVE", permissions: [],
    });

    const response = await call();

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "PERMISSION_DENIED" });
    expectNoRepositoryCalls();
  });

  it.each(routeCases)("rejects a caller with no membership for this event on $name", async ({ call }) => {
    dependencies.getCurrentSession.mockResolvedValue({
      user: { id: "usr_outsider", email: "outsider@example.test", displayName: "Outsider", globalRole: null },
    });
    dependencies.findActiveMembership.mockResolvedValue(null);

    const response = await call();

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "EVENT_ACCESS_DENIED" });
    expectNoRepositoryCalls();
  });
});

describe("DELETE /api/events/[eventId]/assets/[assetId]", () => {
  function signInAsConfigurer() {
    dependencies.getCurrentSession.mockResolvedValue({
      user: { id: "usr_admin", email: "admin@example.test", displayName: "Event Admin", globalRole: null },
    });
    dependencies.findActiveMembership.mockResolvedValue({
      eventId, userId: "usr_admin", role: "EVENT_ADMIN", status: "ACTIVE", permissions: [],
    });
  }

  it("deletes an unused file for a permitted caller, passing the actor for the audit entry", async () => {
    signInAsConfigurer();
    dependencies.removeEventAsset.mockResolvedValue(undefined);
    dependencies.listEventAssets.mockResolvedValue([]);

    const response = await deleteAsset(request(`/api/events/${eventId}/assets/${assetId}`, "DELETE"), assetParams);

    expect(response.status).toBe(200);
    expect(dependencies.removeEventAsset).toHaveBeenCalledWith(eventId, assetId, "usr_admin");
  });

  it("returns 409 with the naming message when the repository reports the file is in use", async () => {
    signInAsConfigurer();
    const { EventAssetError } = await import("@/modules/events/asset-repository");
    dependencies.removeEventAsset.mockRejectedValue(
      new EventAssetError("ASSET_IN_USE", 'Remove the tile that links to this file from the published section "Weekend schedule" before deleting it.'),
    );

    const response = await deleteAsset(request(`/api/events/${eventId}/assets/${assetId}`, "DELETE"), assetParams);

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe("ASSET_IN_USE");
    expect(body.message).toContain("Weekend schedule");
  });
});
