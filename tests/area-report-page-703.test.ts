import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #703 F-D8: a real club and month with no submitted report shows a message;
 * a viewer without access, a bad month, or an unknown club still gets the 404.
 */
const mocks = vi.hoisted(() => ({
  viewerActive: vi.fn(),
  orgFindUnique: vi.fn(),
  getClubReport: vi.fn(),
  reportPrefill: vi.fn(),
  notFound: vi.fn(() => { throw new Error("NOT_FOUND"); }),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound, redirect: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => ({ organization: { findUnique: mocks.orgFindUnique } }) }));
vi.mock("@/modules/organizations/area-coordinators", () => ({ currentAreaCoordinatorViewerActive: mocks.viewerActive }));
vi.mock("@/modules/club-reports/repository", () => ({ getClubReport: mocks.getClubReport, reportPrefill: mocks.reportPrefill }));

import AreaClubReportPage from "@/app/(public)/account/(portal)/area/[organizationId]/reports/[month]/page";

const params = (month: string) => ({ params: Promise.resolve({ organizationId: "club-1", month }) });

function text(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  const props = (node as { props?: { children?: unknown } }).props;
  return text(props?.children);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.viewerActive.mockResolvedValue(true);
  mocks.orgFindUnique.mockResolvedValue({ type: "CLUB", name: "Synthetic Trail Club", isActive: true });
  mocks.getClubReport.mockResolvedValue(null);
  mocks.reportPrefill.mockResolvedValue({});
});

describe("area club report page (#703)", () => {
  it("says no report is submitted when none exists", async () => {
    const page = await AreaClubReportPage(params("2026-09"));
    expect(text(page)).toContain("No submitted report for September 2026 yet.");
  });

  it("does not reveal a draft: it reads the same as no report", async () => {
    mocks.getClubReport.mockResolvedValue({ status: "DRAFT" });
    const page = await AreaClubReportPage(params("2026-09"));
    expect(text(page)).toContain("No submitted report for September 2026 yet.");
  });

  it("keeps the 404 for a viewer without area access, before any club lookup", async () => {
    mocks.viewerActive.mockResolvedValue(false);
    await expect(AreaClubReportPage(params("2026-09"))).rejects.toThrow("NOT_FOUND");
    expect(mocks.orgFindUnique).not.toHaveBeenCalled();
  });

  it("keeps the 404 for a malformed month and for a club that is not an active club", async () => {
    await expect(AreaClubReportPage(params("not-a-month"))).rejects.toThrow("NOT_FOUND");
    mocks.orgFindUnique.mockResolvedValue({ type: "CLUB", name: "Closed", isActive: false });
    await expect(AreaClubReportPage(params("2026-09"))).rejects.toThrow("NOT_FOUND");
    mocks.orgFindUnique.mockResolvedValue(null);
    await expect(AreaClubReportPage(params("2026-09"))).rejects.toThrow("NOT_FOUND");
  });
});
