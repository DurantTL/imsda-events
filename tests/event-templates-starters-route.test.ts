import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/event-templates/starters (#546): admin-only, checked on the
 * server, and same-origin only. The repository is stubbed; sessions are
 * synthetic.
 */
const mocks = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  addStarterEventTemplates: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/lib/logger", async () => {
  const actual = await vi.importActual<typeof import("@/lib/logger")>("@/lib/logger");
  return { ...actual, logError: mocks.logError };
});
vi.mock("@/modules/event-templates/starter-repository", () => ({ addStarterEventTemplates: mocks.addStarterEventTemplates }));

import { POST } from "@/app/api/event-templates/starters/route";

const origin = "https://events.imsda.test";
const staff = { id: "usr_synthetic_staff", email: "staff@imsda-events.test", displayName: "Synthetic Staff", globalRole: null };
const admin = { ...staff, id: "usr_synthetic_admin", globalRole: "SYSTEM_ADMIN" as const };
const result = { added: [{ starterKey: "man_camp", name: "Man Camp", templateId: "t1" }], skipped: [], stillNeeded: [] };

function post(requestOrigin = origin) {
  return POST(new Request(`${origin}/api/event-templates/starters`, { method: "POST", headers: { origin: requestOrigin } }));
}

beforeEach(() => {
  mocks.getCurrentSession.mockResolvedValue({ user: admin });
  mocks.addStarterEventTemplates.mockResolvedValue(result);
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("POST /api/event-templates/starters", () => {
  it("lets a system admin add the starters, acting as that admin", async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(mocks.addStarterEventTemplates).toHaveBeenCalledWith(admin.id);
  });

  it("rejects a signed-out request with 401 and adds nothing", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: null });
    const response = await post();
    expect(response.status).toBe(401);
    expect(mocks.addStarterEventTemplates).not.toHaveBeenCalled();
  });

  it("rejects a signed-in non-admin with 403 and adds nothing", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: staff });
    const response = await post();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "PERMISSION_DENIED" });
    expect(mocks.addStarterEventTemplates).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin request before reading the session", async () => {
    const response = await post("https://evil.example");
    expect(response.status).toBe(403);
    expect(mocks.getCurrentSession).not.toHaveBeenCalled();
    expect(mocks.addStarterEventTemplates).not.toHaveBeenCalled();
  });

  it("logs an unexpected failure and returns a generic 500", async () => {
    mocks.addStarterEventTemplates.mockRejectedValue(new Error("synthetic failure"));
    const response = await post();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "EVENT_TEMPLATE_REQUEST_FAILED" });
    expect(mocks.logError).toHaveBeenCalledTimes(1);
  });
});
