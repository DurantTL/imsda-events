import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
  createClubFormTemplate: vi.fn(),
  saveClubFormDraft: vi.fn(),
  discardClubFormDraft: vi.fn(),
  publishClubFormDraft: vi.fn(),
  setClubFormTemplateEnabled: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/request-context", () => ({ withRequestContext: (handler: unknown) => handler }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
// The real system administrator gate runs; only the session behind it is faked.
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/modules/club-forms/builder", () => ({
  createClubFormTemplate: mocks.createClubFormTemplate,
  saveClubFormDraft: mocks.saveClubFormDraft,
  discardClubFormDraft: mocks.discardClubFormDraft,
  publishClubFormDraft: mocks.publishClubFormDraft,
}));
vi.mock("@/modules/club-forms/templates", () => ({ setClubFormTemplateEnabled: mocks.setClubFormTemplateEnabled }));
vi.mock("@/modules/club-rosters/access", () => ({
  RosterAccessError: class RosterAccessError extends Error {
    constructor(public readonly code: string, public readonly status: number, message: string) {
      super(message);
    }
  },
}));
vi.mock("@/modules/club-rosters/api-errors", () => ({
  RosterBodyError: class RosterBodyError extends Error { readonly code = "INVALID_JSON_BODY"; },
  readRosterJson: async (request: Request) => request.json(),
}));

import { PATCH as TOGGLE } from "@/app/api/admin/club-forms/[templateKey]/route";
import { DELETE as DISCARD, PUT as SAVE } from "@/app/api/admin/club-forms/[templateKey]/draft/route";
import { POST as PUBLISH } from "@/app/api/admin/club-forms/[templateKey]/publish/route";
import { POST as CREATE } from "@/app/api/admin/club-forms/route";
import { ClubFormError } from "@/modules/club-forms/errors";

const admin = { id: "admin-1", globalRole: "SYSTEM_ADMIN" };
const eventAdmin = { id: "user-2", globalRole: "USER" };
const key = { params: Promise.resolve({ templateKey: "synthetic_form" }) };
const json = (body: unknown, method = "POST") =>
  new Request("https://events.imsda.test/api/admin/club-forms", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const routes: Array<{ name: string; call: () => Promise<Response>; service: () => ReturnType<typeof vi.fn> }> = [
  { name: "create", call: () => CREATE(json({ name: "Synthetic Form" })), service: () => mocks.createClubFormTemplate },
  { name: "save draft", call: () => SAVE(json({ draft: {}, baseVersion: 1 }, "PUT"), key), service: () => mocks.saveClubFormDraft },
  { name: "discard draft", call: () => DISCARD(json({}, "DELETE"), key), service: () => mocks.discardClubFormDraft },
  { name: "publish", call: () => PUBLISH(json({ baseVersion: 1 }), key), service: () => mocks.publishClubFormDraft },
  { name: "enable", call: () => TOGGLE(json({ enabled: true }, "PATCH"), key), service: () => mocks.setClubFormTemplateEnabled },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.getCurrentSession.mockResolvedValue({ user: admin });
  mocks.createClubFormTemplate.mockResolvedValue({ key: "synthetic_form", version: 1 });
  mocks.saveClubFormDraft.mockResolvedValue({ key: "synthetic_form", version: 1, draftUpdatedAt: "2026-10-05T15:00:00.000Z" });
  mocks.discardClubFormDraft.mockResolvedValue({ key: "synthetic_form", version: 1 });
  mocks.publishClubFormDraft.mockResolvedValue({ key: "synthetic_form", version: 2 });
  mocks.setClubFormTemplateEnabled.mockResolvedValue({ key: "synthetic_form", enabled: true });
});

describe("club form builder routes are for system administrators only (#712)", () => {
  for (const route of routes) {
    it(`${route.name}: refuses a signed-in user who is not a system administrator, before doing anything`, async () => {
      mocks.getCurrentSession.mockResolvedValue({ user: eventAdmin });
      const response = await route.call();
      expect(response.status).toBe(403);
      expect(route.service()).not.toHaveBeenCalled();
    });

    it(`${route.name}: refuses a visitor who is not signed in`, async () => {
      mocks.getCurrentSession.mockResolvedValue({ user: null });
      const response = await route.call();
      expect(response.status).toBe(401);
      expect(route.service()).not.toHaveBeenCalled();
    });

    it(`${route.name}: refuses a cross-origin request first`, async () => {
      mocks.rejectCrossOriginRequest.mockReturnValue(Response.json({ error: "CROSS_ORIGIN" }, { status: 403 }));
      const response = await route.call();
      expect(response.status).toBe(403);
      expect(mocks.getCurrentSession).not.toHaveBeenCalled();
      expect(route.service()).not.toHaveBeenCalled();
    });
  }

  it("creates a form for a system administrator and records who", async () => {
    const response = await CREATE(json({ name: "Synthetic Form", copyFromKey: "off_premises_permission_slip" }));
    expect(response.status).toBe(201);
    expect(mocks.createClubFormTemplate).toHaveBeenCalledWith({ name: "Synthetic Form", copyFromKey: "off_premises_permission_slip" }, "admin-1");
  });

  it("saves a draft with the version it was based on", async () => {
    const response = await SAVE(json({ draft: { name: "x" }, baseVersion: 3, expectedDraftUpdatedAt: null }, "PUT"), key);
    expect(response.status).toBe(200);
    expect(mocks.saveClubFormDraft).toHaveBeenCalledWith("synthetic_form", { draft: { name: "x" }, baseVersion: 3, expectedDraftUpdatedAt: null }, "admin-1");
  });

  it("publishes and answers with the new version", async () => {
    const response = await PUBLISH(json({ baseVersion: 1 }), key);
    expect(await response.json()).toMatchObject({ version: 2 });
  });

  it("returns field-level issues from a refused draft", async () => {
    mocks.saveClubFormDraft.mockRejectedValue(new ClubFormError("VALIDATION_FAILED", "Every field needs a label.", [{ key: "field:f1", message: "Every field needs a label." }]));
    const response = await SAVE(json({ draft: {}, baseVersion: 1 }, "PUT"), key);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ issues: [{ key: "field:f1" }] });
  });

  it("answers a stale draft or version with a conflict", async () => {
    mocks.publishClubFormDraft.mockRejectedValue(new ClubFormError("TEMPLATE_CHANGED", "This form changed since you opened it."));
    expect((await PUBLISH(json({ baseVersion: 1 }), key)).status).toBe(409);
  });

  it("rejects a malformed body without calling the service", async () => {
    expect((await PUBLISH(json({ baseVersion: "one" }), key)).status).toBe(400);
    expect((await CREATE(json({ name: "x", unexpected: true }))).status).toBe(400);
    expect(mocks.publishClubFormDraft).not.toHaveBeenCalled();
    expect(mocks.createClubFormTemplate).not.toHaveBeenCalled();
  });
});
