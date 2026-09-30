import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rejectCrossOriginRequest: vi.fn(),
  requireSystemAdministrator: vi.fn(),
  previewEadventistImport: vi.fn(),
  commitEadventistImport: vi.fn(),
  setDirectoryOrganizationActive: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/organizations/access", () => ({ requireSystemAdministrator: mocks.requireSystemAdministrator }));
vi.mock("@/modules/organizations/eadventist-import-repository", () => ({
  previewEadventistImport: mocks.previewEadventistImport,
  commitEadventistImport: mocks.commitEadventistImport,
  setDirectoryOrganizationActive: mocks.setDirectoryOrganizationActive,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { POST } from "@/app/api/admin/organizations/eadventist-import/route";
import { PATCH } from "@/app/api/admin/organizations/[organizationId]/status/route";
import { AccessDeniedError } from "@/modules/access/authorization";
import { EadventistImportWorkspace } from "@/components/eadventist-import-workspace";
import { OrganizationOperationError } from "@/modules/organizations/repository";

const fixture = readFileSync(join(__dirname, "fixtures", "eadventist-organizations-synthetic.csv"), "utf8");

function request(method: string, path: string, body: unknown) {
  return new Request(`https://events.imsda.test${path}`, {
    method,
    headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.requireSystemAdministrator.mockResolvedValue({ id: "admin-1", globalRole: "SYSTEM_ADMIN" });
});

describe("eAdventist import routes (#649)", () => {
  it("previews without confirm and commits with it, as the signed-in system administrator", async () => {
    mocks.previewEadventistImport.mockResolvedValue({ counts: {}, items: [], rejected: [] });
    mocks.commitEadventistImport.mockResolvedValue({ committed: true, counts: {}, items: [], rejected: [] });
    const preview = await POST(request("POST", "/api/admin/organizations/eadventist-import", { csv: fixture, confirm: false }));
    expect(preview.status).toBe(200);
    expect(mocks.previewEadventistImport).toHaveBeenCalledWith(fixture);
    expect(mocks.commitEadventistImport).not.toHaveBeenCalled();
    const commit = await POST(request("POST", "/api/admin/organizations/eadventist-import", { csv: fixture, confirm: true }));
    expect(await commit.json()).toMatchObject({ committed: true });
    expect(mocks.commitEadventistImport).toHaveBeenCalledWith(fixture, "admin-1");
  });

  it("refuses anyone who is not a system administrator, before reading the file", async () => {
    mocks.requireSystemAdministrator.mockRejectedValue(new AccessDeniedError("System administrator access is required.", 403, "PERMISSION_DENIED"));
    const response = await POST(request("POST", "/api/admin/organizations/eadventist-import", { csv: fixture, confirm: true }));
    expect(response.status).toBe(403);
    const status = await PATCH(request("PATCH", "/api/admin/organizations/org-1/status", { isActive: false }), { params: Promise.resolve({ organizationId: "org-1" }) });
    expect(status.status).toBe(403);
    expect(mocks.commitEadventistImport).not.toHaveBeenCalled();
    expect(mocks.setDirectoryOrganizationActive).not.toHaveBeenCalled();
  });

  it("rejects a malformed body and a file that is not the export", async () => {
    expect((await POST(request("POST", "/api/admin/organizations/eadventist-import", { csv: "", confirm: false }))).status).toBe(400);
    expect((await POST(request("POST", "/api/admin/organizations/eadventist-import", { csv: fixture }))).status).toBe(400);
    const { EadventistImportError } = await import("@/modules/organizations/eadventist-import");
    mocks.previewEadventistImport.mockRejectedValue(new EadventistImportError("MISSING_COLUMNS", "Missing columns: OrgName."));
    const response = await POST(request("POST", "/api/admin/organizations/eadventist-import", { csv: "a,b\n1,2", confirm: false }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "MISSING_COLUMNS" });
  });

  it("changes a status and reports a refusal as a conflict", async () => {
    const ok = await PATCH(request("PATCH", "/api/admin/organizations/org-1/status", { isActive: false }), { params: Promise.resolve({ organizationId: "org-1" }) });
    expect(ok.status).toBe(200);
    expect(mocks.setDirectoryOrganizationActive).toHaveBeenCalledWith("org-1", false, "admin-1");
    mocks.setDirectoryOrganizationActive.mockRejectedValue(new OrganizationOperationError("ORGANIZATION_HAS_ACTIVE_CLUBS", "Move clubs first."));
    const refused = await PATCH(request("PATCH", "/api/admin/organizations/org-1/status", { isActive: false }), { params: Promise.resolve({ organizationId: "org-1" }) });
    expect(refused.status).toBe(409);
  });
});

describe("the upload preview screen (#649)", () => {
  it("shows the counts, each record's kind and outcome, and the disbanded flag, with Save enabled", () => {
    const html = renderToStaticMarkup(createElement(EadventistImportWorkspace, {
      initialPreview: {
        counts: { new: 1, updated: 1, unchanged: 0, skipped: 0, flagged: 1 },
        rejected: [{ line: 9, name: "Sample Odd", reason: "Unknown organization type \"Spaceport\"." }],
        items: [
          { line: 2, name: "Sample Ridge Group", kind: "GROUP", action: "NEW", matchedBy: null, notes: [], disbandedOn: "2024-03-01" },
          { line: 3, name: "Sample Hills SDA Church", kind: "CHURCH", action: "UPDATED", matchedBy: "NAME", notes: ["Matches the existing church \"Sample Hills SDA Church\" by name."], disbandedOn: null },
        ],
      },
    }));
    expect(html).toContain("1 new, 1 updated, 0 unchanged, 0 skipped. 1 with a disbanded date on file to review.");
    expect(html).toContain("Disbanded 03/01/2024 on file — review");
    expect(html).toContain("Matches the existing church");
    expect(html).toContain("Save 2 changes");
    expect(html).toContain("Unknown organization type");
  });
});
