import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rejectCrossOriginRequest: vi.fn(),
  requireSystemAdministrator: vi.fn(),
  runChurchGeocoding: vi.fn(),
  acceptGeocodeResult: vi.fn(),
  skipGeocodeResult: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@/lib/logger", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/logger")>()), logError: mocks.logError }));
vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/organizations/access", () => ({ requireSystemAdministrator: mocks.requireSystemAdministrator }));
vi.mock("@/modules/organizations/church-geocoding", () => ({
  runChurchGeocoding: mocks.runChurchGeocoding,
  acceptGeocodeResult: mocks.acceptGeocodeResult,
  skipGeocodeResult: mocks.skipGeocodeResult,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { POST as run } from "@/app/api/admin/organizations/map-locations/route";
import { POST as decide } from "@/app/api/admin/organizations/[organizationId]/map-location/route";
import { ChurchMapLocationsWorkspace } from "@/components/church-map-locations-workspace";
import { AccessDeniedError } from "@/modules/access/authorization";
import { OrganizationOperationError } from "@/modules/organizations/repository";

const post = (path: string, body?: unknown) => new Request(`https://events.imsda.test${path}`, {
  method: "POST",
  headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const params = { params: Promise.resolve({ organizationId: "org-1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.requireSystemAdministrator.mockResolvedValue({ id: "admin-1" });
  mocks.runChurchGeocoding.mockResolvedValue({ processed: 2, matched: 1, noMatch: 1 });
});

describe("Find map locations routes (#724)", () => {
  it("runs the lookup for a system administrator and returns counts", async () => {
    const response = await run(post("/api/admin/organizations/map-locations"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ processed: 2, matched: 1, noMatch: 1 });
    expect(mocks.runChurchGeocoding).toHaveBeenCalledWith("admin-1");
  });

  it("refuses anyone who is not a system administrator, before doing anything", async () => {
    mocks.requireSystemAdministrator.mockRejectedValue(new AccessDeniedError("System administrator access is required.", 403, "PERMISSION_DENIED"));
    expect((await run(post("/api/admin/organizations/map-locations"))).status).toBe(403);
    expect((await decide(post("/api/admin/organizations/org-1/map-location", { decision: "accept" }), params)).status).toBe(403);
    expect(mocks.runChurchGeocoding).not.toHaveBeenCalled();
    expect(mocks.acceptGeocodeResult).not.toHaveBeenCalled();
  });

  it("refuses a cross-origin request", async () => {
    mocks.rejectCrossOriginRequest.mockReturnValue(Response.json({ error: "CROSS_ORIGIN" }, { status: 403 }));
    expect((await run(post("/api/admin/organizations/map-locations"))).status).toBe(403);
    expect(mocks.requireSystemAdministrator).not.toHaveBeenCalled();
  });

  it("answers 409 when the flag is off and 502 when the service can't be reached", async () => {
    mocks.runChurchGeocoding.mockRejectedValueOnce(new OrganizationOperationError("GEOCODING_DISABLED", "Off."));
    expect((await run(post("/api/admin/organizations/map-locations"))).status).toBe(409);
    mocks.runChurchGeocoding.mockRejectedValueOnce(new OrganizationOperationError("GEOCODING_UNAVAILABLE", "Could not be reached. Nothing was changed."));
    const down = await run(post("/api/admin/organizations/map-locations"));
    expect(down.status).toBe(502);
    expect(await down.json()).toMatchObject({ message: expect.stringContaining("Nothing was changed") });
  });

  it("accepts or skips one result, and rejects anything else", async () => {
    expect((await decide(post("/api/admin/organizations/org-1/map-location", { decision: "accept" }), params)).status).toBe(200);
    expect(mocks.acceptGeocodeResult).toHaveBeenCalledWith("org-1", "admin-1");
    expect((await decide(post("/api/admin/organizations/org-1/map-location", { decision: "skip" }), params)).status).toBe(200);
    expect(mocks.skipGeocodeResult).toHaveBeenCalledWith("org-1");
    expect((await decide(post("/api/admin/organizations/org-1/map-location", { decision: "x", latitude: 1 }), params)).status).toBe(400);
    mocks.acceptGeocodeResult.mockRejectedValueOnce(new OrganizationOperationError("LOCATION_SET_BY_HAND", "Set by hand."));
    expect((await decide(post("/api/admin/organizations/org-1/map-location", { decision: "accept" }), params)).status).toBe(409);
  });
});

describe("the review screen", () => {
  const items = [
    { organizationId: "org-1", name: "Sample Hills SDA Church", address: "10 Sample Road, Sample Hills, ZZ 00001", status: "MATCHED" as const, latitude: 41.5, longitude: -93.6, matchedAddress: "10 SAMPLE RD" },
    { organizationId: "org-2", name: "Sample Creek SDA Church", address: "2 Nowhere Lane, Sample Creek, ZZ", status: "NO_MATCH" as const, latitude: null, longitude: null, matchedAddress: "" },
  ];

  it("lists matches with Accept, Set on map and Skip, and no-matches without Accept", () => {
    const html = renderToStaticMarkup(createElement(ChurchMapLocationsWorkspace, { enabled: true, eligible: 3, items }));
    expect(html).toContain("Find map locations");
    expect(html).toContain("2 results to review.");
    expect(html.match(/>Accept</g)).toHaveLength(1);
    expect(html.match(/>Skip</g)).toHaveLength(2);
    expect(html).toContain("/admin/organizations/org-2/location");
    expect(html).toContain("No match");
  });

  it("disables the button and explains when the flag is off", () => {
    const html = renderToStaticMarkup(createElement(ChurchMapLocationsWorkspace, { enabled: false, eligible: 3, items: [] }));
    expect(html).toContain("GEOCODING_ENABLED=true");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Find map locations/);
  });
});
