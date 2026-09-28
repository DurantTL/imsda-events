import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireSystemAdministrator: vi.fn(),
  listClubSupplyItems: vi.fn(),
  previewClubSupplyImport: vi.fn(),
  applyClubSupplyImport: vi.fn(),
  setClubSupplyItemActive: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/organizations/access", () => ({ requireSystemAdministrator: mocks.requireSystemAdministrator }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: () => null }));
vi.mock("@/modules/club-supplies/repository", async () => {
  const actual = await vi.importActual<typeof import("@/modules/club-supplies/repository")>("@/modules/club-supplies/repository");
  return {
    ...actual,
    listClubSupplyItems: mocks.listClubSupplyItems,
    previewClubSupplyImport: mocks.previewClubSupplyImport,
    applyClubSupplyImport: mocks.applyClubSupplyImport,
    setClubSupplyItemActive: mocks.setClubSupplyItemActive,
  };
});

import { GET as CATALOG_GET } from "@/app/api/admin/club-supplies/route";
import { PATCH as ITEM_PATCH } from "@/app/api/admin/club-supplies/[itemId]/route";
import { POST as IMPORT_POST } from "@/app/api/admin/club-supplies/import/route";
import { GET as TEMPLATE_GET } from "@/app/api/admin/club-supplies/template/route";
import { AccessDeniedError } from "@/modules/access/authorization";
import { planClubSupplyImport, parseClubSupplyCsv } from "@/modules/club-supplies/catalog-csv";
import { ClubSupplyError } from "@/modules/club-supplies/repository";

const csv = "section,item,adventsource_catalog_number\nInvestiture,Friend Pin,002120";
const plan = planClubSupplyImport(parseClubSupplyCsv(csv), [], []);
const json = (method: string, body: unknown) => new Request("https://events.imsda.test/api/admin/x", {
  method,
  headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
  body: JSON.stringify(body),
});
const getRequest = () => new Request("https://events.imsda.test/api/admin/x");
const itemCtx = { params: Promise.resolve({ itemId: "item-1" }) };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireSystemAdministrator.mockResolvedValue({ id: "admin-1" });
  mocks.previewClubSupplyImport.mockResolvedValue({ plan, fingerprint: "f".repeat(64) });
  mocks.applyClubSupplyImport.mockResolvedValue({ ...plan, items: [] });
  mocks.listClubSupplyItems.mockResolvedValue([]);
  mocks.setClubSupplyItemActive.mockResolvedValue([]);
});

describe("staff club supply catalog routes (#531)", () => {
  it("offers the template", async () => {
    const response = await TEMPLATE_GET(getRequest());
    expect(response.status).toBe(200);
    expect((await response.text()).trim()).toBe('"Section","Item","Catalog Number","Active"');
  });

  it("previews with counts and a fingerprint, saving nothing", async () => {
    const response = await IMPORT_POST(json("POST", { csv }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ fingerprint: "f".repeat(64), summary: { added: 1, honorsMatched: 0, honorsUnmatched: 0 } });
    expect(body.steps[0]).toEqual({ line: 2, name: "Friend Pin", action: "ADD", message: "Will be added.", section: "INVESTITURE", honorMatch: null, duplicateOfLine: null });
    expect(mocks.applyClubSupplyImport).not.toHaveBeenCalled();
  });

  it("saves on confirm with the echoed fingerprint", async () => {
    const response = await IMPORT_POST(json("POST", { csv, confirm: true, fingerprint: "f".repeat(64) }));
    expect(response.status).toBe(200);
    expect(mocks.applyClubSupplyImport).toHaveBeenCalledWith(expect.any(Array), "f".repeat(64), "admin-1");
  });

  it("refuses a confirm without a fingerprint, or with a stale one, as 409 PREVIEW_CHANGED", async () => {
    const missing = await IMPORT_POST(json("POST", { csv, confirm: true }));
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({ error: "PREVIEW_CHANGED" });
    expect(mocks.applyClubSupplyImport).not.toHaveBeenCalled();

    mocks.applyClubSupplyImport.mockRejectedValue(new ClubSupplyError("PREVIEW_CHANGED", "Changed."));
    const stale = await IMPORT_POST(json("POST", { csv, confirm: true, fingerprint: "0".repeat(64) }));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "PREVIEW_CHANGED" });
  });

  it("answers a catalog conflict with 409 CATALOG_CONFLICT, never 404", async () => {
    mocks.applyClubSupplyImport.mockRejectedValue(new ClubSupplyError("CATALOG_CONFLICT", "Conflict."));
    const response = await IMPORT_POST(json("POST", { csv, confirm: true, fingerprint: "f".repeat(64) }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "CATALOG_CONFLICT" });
  });

  it("rejects an unreadable CSV with 400 before planning", async () => {
    const response = await IMPORT_POST(json("POST", { csv: "Name\nBirds" }));
    expect(response.status).toBe(400);
    expect(mocks.previewClubSupplyImport).not.toHaveBeenCalled();
  });

  it("sets an item's active flag, and 404s a missing item", async () => {
    expect((await ITEM_PATCH(json("PATCH", { isActive: false }), itemCtx)).status).toBe(200);
    expect(mocks.setClubSupplyItemActive).toHaveBeenCalledWith("item-1", false, "admin-1");
    expect((await ITEM_PATCH(json("PATCH", { isActive: "no" }), itemCtx)).status).toBe(400);
    mocks.setClubSupplyItemActive.mockRejectedValue(new ClubSupplyError("ITEM_NOT_FOUND", "Missing."));
    expect((await ITEM_PATCH(json("PATCH", { isActive: true }), itemCtx)).status).toBe(404);
  });

  it("is closed to anyone but a system administrator", async () => {
    mocks.requireSystemAdministrator.mockRejectedValue(new AccessDeniedError("No.", 403, "PERMISSION_DENIED"));
    expect((await CATALOG_GET(getRequest())).status).toBe(403);
    expect((await TEMPLATE_GET(getRequest())).status).toBe(403);
    expect((await IMPORT_POST(json("POST", { csv }))).status).toBe(403);
    expect((await ITEM_PATCH(json("PATCH", { isActive: false }), itemCtx)).status).toBe(403);
    expect(mocks.previewClubSupplyImport).not.toHaveBeenCalled();
    expect(mocks.setClubSupplyItemActive).not.toHaveBeenCalled();
  });
});
