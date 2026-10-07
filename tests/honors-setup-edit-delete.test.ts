import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rejectCrossOriginRequest: vi.fn(),
  requireHonorPermission: vi.fn(),
  updateHonorSession: vi.fn(),
  deleteHonorSession: vi.fn(),
  updateHonorOffering: vi.fn(),
  deleteHonorOffering: vi.fn(),
  updateHonor: vi.fn(),
  requireSystemAdministrator: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/honors/access", () => ({ requireHonorPermission: mocks.requireHonorPermission }));
vi.mock("@/modules/organizations/access", () => ({ requireSystemAdministrator: mocks.requireSystemAdministrator }));
vi.mock("@/modules/honors/repository", async () => {
  const actual = await vi.importActual<typeof import("@/modules/honors/repository")>("@/modules/honors/repository");
  return {
    ...actual,
    updateHonorSession: mocks.updateHonorSession,
    deleteHonorSession: mocks.deleteHonorSession,
    updateHonorOffering: mocks.updateHonorOffering,
    deleteHonorOffering: mocks.deleteHonorOffering,
    updateHonor: mocks.updateHonor,
  };
});

import { PATCH as PATCH_HONOR } from "@/app/api/admin/honors/[honorId]/route";
import { DELETE as DELETE_OFFERING, PATCH as PATCH_OFFERING } from "@/app/api/events/[eventId]/honors/offerings/[offeringId]/route";
import { DELETE as DELETE_SESSION, PATCH as PATCH_SESSION } from "@/app/api/events/[eventId]/honors/sessions/[sessionId]/route";
import { AccessDeniedError } from "@/modules/access/authorization";
import { offeringPlacementPatch, sessionEditPatch } from "@/modules/honors/domain";
import { HonorConfigurationError } from "@/modules/honors/repository";
import { honorOfferingUpdateSchema, honorSessionUpdateSchema, honorUpdateSchema } from "@/modules/honors/schemas";

const sessionContext = { params: Promise.resolve({ eventId: "site-b", sessionId: "s1" }) };
const offeringContext = { params: Promise.resolve({ eventId: "site-b", offeringId: "o1" }) };
const setup = { locations: [], sessions: [], offerings: [] };

function request(method: string, body?: unknown, query = "") {
  return new Request(`https://events.imsda.test/api/x${query}`, {
    method,
    headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.requireHonorPermission.mockResolvedValue({ user: { id: "staff-1" } });
  mocks.updateHonorSession.mockResolvedValue(setup);
  mocks.deleteHonorSession.mockResolvedValue(setup);
  mocks.updateHonorOffering.mockResolvedValue(setup);
  mocks.deleteHonorOffering.mockResolvedValue(setup);
  mocks.updateHonor.mockResolvedValue([]);
  mocks.requireSystemAdministrator.mockResolvedValue({ id: "admin-1" });
});

describe("renaming a session keeps its site (#615)", () => {
  it("parses a rename to exactly the name, with no site or order added", () => {
    // Regression: `.partial()` still applied the create schema's defaults, so
    // `{ name }` became `{ name, sortOrder: 0, locationId: null }` and the
    // repository answered "Choose the site for this session."
    expect(honorSessionUpdateSchema.parse({ name: "Sabbath afternoon" })).toEqual({ name: "Sabbath afternoon" });
    expect(honorSessionUpdateSchema.parse({ locationId: "loc-1" })).toEqual({ locationId: "loc-1" });
    expect(honorSessionUpdateSchema.parse({ sortOrder: 3 })).toEqual({ sortOrder: 3 });
    expect(honorSessionUpdateSchema.parse({ locationId: null })).toEqual({ locationId: null });
    expect(honorSessionUpdateSchema.parse({})).toEqual({});
  });

  it("passes only the renamed name to the repository", async () => {
    const response = await PATCH_SESSION(request("PATCH", { name: "Renamed" }), sessionContext);
    expect(response.status).toBe(200);
    expect(mocks.updateHonorSession).toHaveBeenCalledWith("site-b", "s1", { name: "Renamed" }, "staff-1");
  });

  it("the session form sends only what changed", () => {
    const current = { name: "Sabbath", sortOrder: 1, locationId: "loc-1" };
    expect(sessionEditPatch(current, { name: "Sabbath afternoon", sortOrder: 1, locationId: "loc-1" })).toEqual({ name: "Sabbath afternoon" });
    expect(sessionEditPatch(current, { name: " Sabbath ", sortOrder: 1, locationId: "loc-1" })).toEqual({});
    expect(sessionEditPatch(current, { name: "Sabbath", sortOrder: 4, locationId: "loc-2" })).toEqual({ sortOrder: 4, locationId: "loc-2" });
    expect(sessionEditPatch({ ...current, locationId: null }, { name: "Sabbath", sortOrder: 1, locationId: null })).toEqual({});
  });
});

describe("offering update schema", () => {
  it("accepts every field set at creation and adds no defaults", () => {
    expect(honorOfferingUpdateSchema.parse({ capacity: 9 })).toEqual({ capacity: 9 });
    expect(honorOfferingUpdateSchema.parse({ honorId: "h2", span: "ALL_SESSIONS", sessionId: null, locationId: "loc-1" }))
      .toEqual({ honorIds: ["h2"], span: "ALL_SESSIONS", sessionId: null, locationId: "loc-1" });
    expect(honorOfferingUpdateSchema.safeParse({ unknown: 1 }).success).toBe(false);
  });

  it("the class form sends the honor, span and session only when they changed", () => {
    const current = { honorIds: ["h1"], span: "SINGLE_SESSION" as const, sessionId: "s1" };
    expect(offeringPlacementPatch(current, { ...current })).toEqual({});
    expect(offeringPlacementPatch(current, { ...current, honorIds: ["h2"], sessionId: "s2" })).toEqual({ honorIds: ["h2"], sessionId: "s2" });
    expect(offeringPlacementPatch(current, { honorIds: ["h1"], span: "ALL_SESSIONS", sessionId: "s1" })).toEqual({ span: "ALL_SESSIONS", sessionId: null });
  });
});

describe("edit and delete routes", () => {
  it("authorize every write with the configure permission on the event, before touching anything", async () => {
    mocks.requireHonorPermission.mockRejectedValue(new AccessDeniedError("No.", 403, "PERMISSION_DENIED"));
    expect((await PATCH_SESSION(request("PATCH", { name: "x" }), sessionContext)).status).toBe(403);
    expect((await DELETE_SESSION(request("DELETE"), sessionContext)).status).toBe(403);
    expect((await PATCH_OFFERING(request("PATCH", { capacity: 1 }), offeringContext)).status).toBe(403);
    expect((await DELETE_OFFERING(request("DELETE"), offeringContext)).status).toBe(403);
    expect(mocks.requireHonorPermission).toHaveBeenCalledWith("site-b");
    expect(mocks.updateHonorSession).not.toHaveBeenCalled();
    expect(mocks.deleteHonorSession).not.toHaveBeenCalled();
    expect(mocks.updateHonorOffering).not.toHaveBeenCalled();
    expect(mocks.deleteHonorOffering).not.toHaveBeenCalled();
  });

  it("rejects cross-origin deletes before checking the account", async () => {
    mocks.rejectCrossOriginRequest.mockReturnValue(Response.json({}, { status: 403 }));
    expect((await DELETE_OFFERING(request("DELETE"), offeringContext)).status).toBe(403);
    expect((await DELETE_SESSION(request("DELETE"), sessionContext)).status).toBe(403);
    expect(mocks.requireHonorPermission).not.toHaveBeenCalled();
  });

  it("deletes a class with nothing picked, passing no confirmation", async () => {
    expect((await DELETE_OFFERING(request("DELETE"), offeringContext)).status).toBe(200);
    expect(mocks.deleteHonorOffering).toHaveBeenCalledWith("site-b", "o1", "staff-1", undefined);
  });

  it("passes the confirmed pick count on, and rejects a malformed one", async () => {
    await DELETE_OFFERING(request("DELETE", undefined, "?confirmPicks=4"), offeringContext);
    expect(mocks.deleteHonorOffering).toHaveBeenCalledWith("site-b", "o1", "staff-1", 4);
    await DELETE_SESSION(request("DELETE", undefined, "?confirmPicks=0"), sessionContext);
    expect(mocks.deleteHonorSession).toHaveBeenCalledWith("site-b", "s1", "staff-1", 0);
    expect((await DELETE_OFFERING(request("DELETE", undefined, "?confirmPicks=abc"), offeringContext)).status).toBe(400);
    expect((await DELETE_SESSION(request("DELETE", undefined, "?confirmPicks=-1"), sessionContext)).status).toBe(400);
  });

  it("answers an unconfirmed delete of a picked class with 409 and the count", async () => {
    mocks.deleteHonorOffering.mockRejectedValue(new HonorConfigurationError("PICKS_NEED_CONFIRMATION", "3 class picks will be removed.", 3));
    const response = await DELETE_OFFERING(request("DELETE"), offeringContext);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "PICKS_NEED_CONFIRMATION", picks: 3 });
  });

  it("answers a refused delete of written-back picks with 409", async () => {
    mocks.deleteHonorSession.mockRejectedValue(new HonorConfigurationError("HAS_WRITTEN_BACK_COMPLETIONS", "Deactivate it instead.", 2));
    const response = await DELETE_SESSION(request("DELETE", undefined, "?confirmPicks=2"), sessionContext);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("HAS_WRITTEN_BACK_COMPLETIONS");
  });

  it("edits a class through PATCH with the whole set of fields", async () => {
    const body = { honorId: "h2", span: "SINGLE_SESSION", sessionId: "s2", capacity: 12, teacherName: "A. Teacher" };
    expect((await PATCH_OFFERING(request("PATCH", body), offeringContext)).status).toBe(200);
    expect(mocks.updateHonorOffering).toHaveBeenCalledWith("site-b", "o1", { ...body, honorId: undefined, honorIds: ["h2"] }, "staff-1");
  });

  it("keeps the refusal for changing the site of a picked class as a 409 with the reason", async () => {
    mocks.updateHonorOffering.mockRejectedValue(new HonorConfigurationError("OFFERING_HAS_PICKS", "Clubs have already picked this class, so it can't move to another site."));
    const response = await PATCH_OFFERING(request("PATCH", { locationId: "loc-2" }), offeringContext);
    expect(response.status).toBe(409);
    expect((await response.json()).message).toContain("already picked");
  });
});

describe("catalog honor update keeps unsent fields (#615)", () => {
  it("parses a one-field update to just that field", () => {
    // Same Zod 4 `.partial()` default bug as the session rename: it used to add description "" and isActive true.
    expect(honorUpdateSchema.parse({ name: "Knot Tying II" })).toEqual({ name: "Knot Tying II" });
    expect(honorUpdateSchema.parse({ isActive: false })).toEqual({ isActive: false });
    expect(honorUpdateSchema.parse({ description: "" })).toEqual({ description: "" });
    expect(honorUpdateSchema.safeParse({ code: "" }).success).toBe(false);
  });

  it("PATCHes one field without sending the others to the repository", async () => {
    const response = await PATCH_HONOR(request("PATCH", { name: "Renamed" }), { params: Promise.resolve({ honorId: "h1" }) });
    expect(response.status).toBe(200);
    expect(mocks.updateHonor).toHaveBeenCalledWith("h1", { name: "Renamed" }, "admin-1");
  });
});
