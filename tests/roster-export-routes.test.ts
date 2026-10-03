import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireRosterAccess: vi.fn(),
  runRosterExport: vi.fn(),
  listRosterExportFormats: vi.fn(),
  saveRosterExportFormat: vi.fn(),
  deleteRosterExportFormat: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/club-rosters/access", async () => {
  const actual = await vi.importActual<typeof import("@/modules/club-rosters/access")>("@/modules/club-rosters/access");
  return { ...actual, requireRosterAccess: mocks.requireRosterAccess };
});
vi.mock("@/modules/club-rosters/export-repository", async () => {
  const actual = await vi.importActual<typeof import("@/modules/club-rosters/export-repository")>("@/modules/club-rosters/export-repository");
  return {
    ...actual,
    runRosterExport: mocks.runRosterExport,
    listRosterExportFormats: mocks.listRosterExportFormats,
    saveRosterExportFormat: mocks.saveRosterExportFormat,
    deleteRosterExportFormat: mocks.deleteRosterExportFormat,
  };
});

import { POST as postExport } from "@/app/api/attendee/clubs/[organizationId]/roster/export/route";
import { DELETE as deleteFormat } from "@/app/api/attendee/clubs/[organizationId]/roster/export/formats/[formatId]/route";
import { GET as getFormats, POST as postFormat } from "@/app/api/attendee/clubs/[organizationId]/roster/export/formats/route";
import { RosterAccessError } from "@/modules/club-rosters/access";
import { RosterExportError } from "@/modules/club-rosters/export-repository";

const ctx = { params: Promise.resolve({ organizationId: "club-1" }) };
const formatCtx = { params: Promise.resolve({ organizationId: "club-1", formatId: "format-1" }) };
const openAccess = { state: "OPEN", capabilities: { seeBirthDates: false }, actor: { kind: "ATTENDEE", accountId: "director-1", sessionId: "session-1" } };

function jsonRequest(url: string, method: string, body?: unknown) {
  return new Request(url, {
    method,
    headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.requireRosterAccess.mockResolvedValue(openAccess);
});

describe("POST .../roster/export (#490)", () => {
  it("requires roster access before building anything", async () => {
    mocks.requireRosterAccess.mockRejectedValueOnce(new RosterAccessError("SIGN_IN_REQUIRED", 401, "Sign in to open your club roster."));
    const response = await postExport(jsonRequest("https://events.imsda.test/x", "POST", { columns: [{ key: "firstName", header: "First" }] }), ctx);
    expect(response.status).toBe(401);
    expect(mocks.runRosterExport).not.toHaveBeenCalled();
  });

  it("rejects an unknown column key before it ever reaches the repository", async () => {
    const response = await postExport(jsonRequest("https://events.imsda.test/x", "POST", { columns: [{ key: "emergencyContact", header: "Contact" }] }), ctx);
    expect(response.status).toBe(400);
    expect(mocks.runRosterExport).not.toHaveBeenCalled();
  });

  it("passes the roster's own seeBirthDates capability down to the export", async () => {
    mocks.requireRosterAccess.mockResolvedValueOnce({ ...openAccess, capabilities: { seeBirthDates: true } });
    mocks.runRosterExport.mockResolvedValueOnce({ headers: ["DOB"], rows: [["2014-05-06"]] });
    const response = await postExport(
      jsonRequest("https://events.imsda.test/x", "POST", { mode: "preview", columns: [{ key: "birthDate", header: "DOB" }], confirmSensitive: true }),
      ctx,
    );
    expect(response.status).toBe(200);
    expect(mocks.runRosterExport).toHaveBeenCalledWith(
      "club-1", expect.any(String),
      { mode: "preview", columns: [{ key: "birthDate", header: "DOB" }], confirmSensitive: true },
      true,
      { accountId: "director-1" },
      undefined,
    );
  });

  it("returns the preview JSON as-is", async () => {
    mocks.runRosterExport.mockResolvedValueOnce({ headers: ["First"], rows: [["Ana"]], totalRows: 12 });
    const response = await postExport(jsonRequest("https://events.imsda.test/x", "POST", { columns: [{ key: "firstName", header: "First" }] }), ctx);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ headers: ["First"], rows: [["Ana"]], totalRows: 12 });
  });

  it("returns a CSV attachment for mode: csv, byte-for-byte what the repository built", async () => {
    mocks.runRosterExport.mockResolvedValueOnce({ headers: ["First"], rows: [["Ana"]], csv: '"First"\r\n"Ana"\r\n' });
    const response = await postExport(
      jsonRequest("https://events.imsda.test/x", "POST", { mode: "csv", columns: [{ key: "firstName", header: "First" }] }),
      ctx,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    await expect(response.text()).resolves.toBe('"First"\r\n"Ana"\r\n');
  });

  it("maps a missing confirmation to 400, and denied birth-date access to 403", async () => {
    mocks.runRosterExport.mockRejectedValueOnce(new RosterExportError("CONFIRMATION_REQUIRED", "Confirm sharing Birth date first."));
    let response = await postExport(jsonRequest("https://events.imsda.test/x", "POST", { columns: [{ key: "birthDate", header: "DOB" }] }), ctx);
    expect(response.status).toBe(400);

    mocks.runRosterExport.mockRejectedValueOnce(new RosterExportError("SENSITIVE_ACCESS_DENIED", "Your club role doesn't include birth dates."));
    response = await postExport(jsonRequest("https://events.imsda.test/x", "POST", { columns: [{ key: "birthDate", header: "DOB" }], confirmSensitive: true }), ctx);
    expect(response.status).toBe(403);
  });
});

describe("guardian columns on the export routes (#510)", () => {
  const guardianBody = { mode: "preview", columns: [{ key: "guardian1Name", header: "Guardian 1 name" }], confirmSensitive: true };

  it("passes the club role's guardians capability down to the export", async () => {
    mocks.requireRosterAccess.mockResolvedValueOnce({ ...openAccess, capabilities: { seeBirthDates: true, guardians: true } });
    mocks.runRosterExport.mockResolvedValueOnce({ headers: ["Guardian 1 name"], rows: [["Synthetic Guardian"]], totalRows: 1 });
    const response = await postExport(jsonRequest("https://events.imsda.test/x", "POST", guardianBody), ctx);
    expect(response.status).toBe(200);
    expect(mocks.runRosterExport).toHaveBeenCalledWith("club-1", expect.any(String), guardianBody, true, { accountId: "director-1" }, true);
  });

  it("answers 403 when the repository refuses a role without guardians access", async () => {
    mocks.runRosterExport.mockRejectedValueOnce(new RosterExportError("SENSITIVE_ACCESS_DENIED", "Guardian contacts are for your club's director and deputy."));
    const response = await postExport(jsonRequest("https://events.imsda.test/x", "POST", guardianBody), ctx);
    expect(response.status).toBe(403);
  });

  it("refuses to save a format with guardian columns for a role without guardians access, and allows it for a director", async () => {
    const body = { name: "With guardians", columns: [{ key: "firstName", header: "First" }, { key: "guardian1Email", header: "G1 email" }] };
    let response = await postFormat(jsonRequest("https://events.imsda.test/x", "POST", body), ctx);
    expect(response.status).toBe(403);
    expect(mocks.saveRosterExportFormat).not.toHaveBeenCalled();

    mocks.requireRosterAccess.mockResolvedValueOnce({ ...openAccess, capabilities: { seeBirthDates: true, guardians: true } });
    mocks.saveRosterExportFormat.mockResolvedValueOnce({ id: "format-2", name: "With guardians", columns: body.columns, updatedAt: "" });
    mocks.listRosterExportFormats.mockResolvedValueOnce([]);
    response = await postFormat(jsonRequest("https://events.imsda.test/x", "POST", body), ctx);
    expect(response.status).toBe(201);
  });
});

describe("saved export formats routes (#490)", () => {
  it("lists formats behind roster access", async () => {
    mocks.listRosterExportFormats.mockResolvedValueOnce([{ id: "format-1", name: "NAD Camporee", columns: [], updatedAt: "2026-09-01T00:00:00.000Z" }]);
    const response = await getFormats(new Request("https://events.imsda.test/x"), ctx);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ formats: [{ name: "NAD Camporee" }] });
  });

  it("saves a format and refuses a duplicate name with 409", async () => {
    mocks.saveRosterExportFormat.mockResolvedValueOnce({ id: "format-1", name: "NAD Camporee", columns: [{ key: "firstName", header: "First" }], updatedAt: "" });
    mocks.listRosterExportFormats.mockResolvedValueOnce([]);
    let response = await postFormat(jsonRequest("https://events.imsda.test/x", "POST", { name: "NAD Camporee", columns: [{ key: "firstName", header: "First" }] }), ctx);
    expect(response.status).toBe(201);

    mocks.saveRosterExportFormat.mockRejectedValueOnce(new RosterExportError("FORMAT_NAME_TAKEN", "A saved format with this name already exists."));
    response = await postFormat(jsonRequest("https://events.imsda.test/x", "POST", { name: "NAD Camporee", columns: [{ key: "firstName", header: "First" }] }), ctx);
    expect(response.status).toBe(409);
  });

  it("deletes a format behind roster access, 404 when it's not this club's", async () => {
    mocks.deleteRosterExportFormat.mockRejectedValueOnce(new RosterExportError("FORMAT_NOT_FOUND", "That saved format could not be found."));
    let response = await deleteFormat(jsonRequest("https://events.imsda.test/x", "DELETE"), formatCtx);
    expect(response.status).toBe(404);

    mocks.deleteRosterExportFormat.mockResolvedValueOnce(undefined);
    mocks.listRosterExportFormats.mockResolvedValueOnce([]);
    response = await deleteFormat(jsonRequest("https://events.imsda.test/x", "DELETE"), formatCtx);
    expect(response.status).toBe(200);
  });

  it("requires roster access for every format route", async () => {
    mocks.requireRosterAccess.mockRejectedValue(new RosterAccessError("SIGN_IN_REQUIRED", 401, "Sign in to open your club roster."));
    expect((await getFormats(new Request("https://events.imsda.test/x"), ctx)).status).toBe(401);
    expect((await postFormat(jsonRequest("https://events.imsda.test/x", "POST", { name: "X", columns: [{ key: "firstName", header: "First" }] }), ctx)).status).toBe(401);
    expect((await deleteFormat(jsonRequest("https://events.imsda.test/x", "DELETE"), formatCtx)).status).toBe(401);
  });
});
