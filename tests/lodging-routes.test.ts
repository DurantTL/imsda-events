import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `/api/events/[eventId]/lodging/**` (#198): the lodging screens are staff only
 * and authorization is server-side. Inventory, availability and holds take the
 * event setup permission (CONFIGURE_EVENT); rates, which change what people pay,
 * take the finance permission (MANAGE_FINANCE). The service is stubbed and the
 * sessions and memberships are synthetic.
 */
const mocks = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  findActiveMembership: vi.fn(),
  selectEventProperty: vi.fn(),
  updateEventUnit: vi.fn(),
  createHold: vi.fn(),
  changeHold: vi.fn(),
  setEventRate: vi.fn(),
  updateEventLayout: vi.fn(),
  getLodgingView: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: () => null }));
vi.mock("@/modules/events/repository", () => ({ findActiveMembership: mocks.findActiveMembership }));
vi.mock("@/modules/lodging/service", () => ({
  selectEventProperty: mocks.selectEventProperty,
  updateEventUnit: mocks.updateEventUnit,
  createHold: mocks.createHold,
  changeHold: mocks.changeHold,
  setEventRate: mocks.setEventRate,
  updateEventLayout: mocks.updateEventLayout,
  getLodgingView: mocks.getLodgingView,
}));

import { GET as viewRoute, POST as selectRoute } from "@/app/api/events/[eventId]/lodging/route";
import { PATCH as unitRoute } from "@/app/api/events/[eventId]/lodging/units/[unitId]/route";
import { POST as holdCreateRoute } from "@/app/api/events/[eventId]/lodging/units/[unitId]/holds/route";
import { PATCH as holdChangeRoute } from "@/app/api/events/[eventId]/lodging/holds/[holdId]/route";
import { POST as layoutRoute } from "@/app/api/events/[eventId]/lodging/layout/route";
import { PUT as rateRoute } from "@/app/api/events/[eventId]/lodging/rates/route";
import { LodgingError } from "@/modules/lodging/errors";

const user = { id: "usr_synthetic", email: "staff@imsda-events.test", displayName: "Synthetic Staff", globalRole: null };
const membership = (role: string) => ({ eventId: "ev1", userId: user.id, role, status: "ACTIVE", permissions: [] });
const origin = "https://events.imsda.test";
const request = (method: string, body: unknown = {}) => new Request(`${origin}/api/x`, { method, headers: { "content-type": "application/json", origin }, body: method === "GET" ? undefined : JSON.stringify(body) });
const params = { eventId: "ev1" };

const routes: Array<{ name: string; call: () => Promise<Response>; permission: "CONFIGURE_EVENT" | "MANAGE_FINANCE" }> = [
  { name: "view", call: () => viewRoute(request("GET"), { params: Promise.resolve(params) }), permission: "CONFIGURE_EVENT" },
  { name: "choose property", call: () => selectRoute(request("POST", { propertyKey: "camp-heritage" }), { params: Promise.resolve(params) }), permission: "CONFIGURE_EVENT" },
  { name: "unit", call: () => unitRoute(request("PATCH", { unavailable: true }), { params: Promise.resolve({ ...params, unitId: "u1" }) }), permission: "CONFIGURE_EVENT" },
  { name: "place hold", call: () => holdCreateRoute(request("POST", {}), { params: Promise.resolve({ ...params, unitId: "u1" }) }), permission: "CONFIGURE_EVENT" },
  { name: "change hold", call: () => holdChangeRoute(request("PATCH", {}), { params: Promise.resolve({ ...params, holdId: "h1" }) }), permission: "CONFIGURE_EVENT" },
  { name: "update layout", call: () => layoutRoute(request("POST", {}), { params: Promise.resolve(params) }), permission: "CONFIGURE_EVENT" },
  { name: "rates", call: () => rateRoute(request("PUT", {}), { params: Promise.resolve(params) }), permission: "MANAGE_FINANCE" },
];

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getLodgingView.mockResolvedValue({ eventId: "ev1" });
  mocks.selectEventProperty.mockResolvedValue({ created: true });
  mocks.updateEventUnit.mockResolvedValue({});
  mocks.createHold.mockResolvedValue({});
  mocks.changeHold.mockResolvedValue({});
  mocks.setEventRate.mockResolvedValue({});
  mocks.updateEventLayout.mockResolvedValue({});
});

describe("lodging route authorization", () => {
  for (const route of routes) {
    it(`${route.name}: refuses a signed-out request`, async () => {
      mocks.getCurrentSession.mockResolvedValue({ user: null });
      expect((await route.call()).status).toBe(401);
    });

    it(`${route.name}: refuses a person who is not on the event`, async () => {
      mocks.getCurrentSession.mockResolvedValue({ user });
      mocks.findActiveMembership.mockResolvedValue(null);
      expect((await route.call()).status).toBe(403);
    });

    it(`${route.name}: refuses read-only staff`, async () => {
      mocks.getCurrentSession.mockResolvedValue({ user });
      mocks.findActiveMembership.mockResolvedValue(membership("READ_ONLY_STAFF"));
      expect((await route.call()).status).toBe(403);
    });
  }

  it("lets an event administrator use every route", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user });
    mocks.findActiveMembership.mockResolvedValue(membership("EVENT_ADMIN"));
    for (const route of routes) expect((await route.call()).status, route.name).toBeLessThan(300);
  });

  it("keeps rates to the finance permission: setup-only staff are refused, finance staff are not", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user });
    mocks.findActiveMembership.mockResolvedValue({ ...membership("READ_ONLY_STAFF"), permissions: ["CONFIGURE_EVENT"] });
    const rate = routes.find((route) => route.name === "rates")!;
    expect((await rate.call()).status).toBe(403);
    expect(mocks.setEventRate).not.toHaveBeenCalled();
    mocks.findActiveMembership.mockResolvedValue(membership("FINANCE_MANAGER"));
    expect((await rate.call()).status).toBe(200);
    // Finance alone does not open the inventory screens.
    const unit = routes.find((route) => route.name === "unit")!;
    expect((await unit.call()).status).toBe(403);
  });

  it("answers a lodging refusal with its status and code", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user });
    mocks.findActiveMembership.mockResolvedValue(membership("EVENT_ADMIN"));
    mocks.createHold.mockRejectedValue(new LodgingError("HOLD_OVERLAP", "Overlaps."));
    const response = await routes.find((route) => route.name === "place hold")!.call();
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("HOLD_OVERLAP");
  });
});
