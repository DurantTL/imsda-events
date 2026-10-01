import { beforeEach, describe, expect, it, vi } from "vitest";

/** #722: an inactive club's form is a 404 before anything is read, so no audited VIEW is written. Synthetic ids only. */
const mocks = vi.hoisted(() => ({
  resolveViewer: vi.fn(),
  getSubmission: vi.fn(),
  orgFindUnique: vi.fn(),
  notFound: vi.fn(() => { throw new Error("NOT_FOUND"); }),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound, redirect: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => ({ organization: { findUnique: mocks.orgFindUnique } }) }));
vi.mock("@/modules/club-forms/access", () => ({ resolveAreaCoordinatorViewer: mocks.resolveViewer }));
vi.mock("@/modules/club-forms/submissions", () => ({ getSubmissionForViewer: mocks.getSubmission }));

import AreaClubFormPage from "@/app/(public)/account/(portal)/area/[organizationId]/forms/[submissionId]/page";

const props = { params: Promise.resolve({ organizationId: "club-1", submissionId: "sub-1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveViewer.mockResolvedValue({ kind: "AREA_COORDINATOR" });
  mocks.getSubmission.mockResolvedValue({ id: "sub-1" });
});

describe("area club form page (#722)", () => {
  it("is a 404 for an inactive club and never reads (or audits) the submission", async () => {
    mocks.orgFindUnique.mockResolvedValue({ type: "CLUB", isActive: false });
    await expect(AreaClubFormPage(props)).rejects.toThrow("NOT_FOUND");
    expect(mocks.getSubmission).not.toHaveBeenCalled();
  });

  it("is a 404 for an unknown club", async () => {
    mocks.orgFindUnique.mockResolvedValue(null);
    await expect(AreaClubFormPage(props)).rejects.toThrow("NOT_FOUND");
    expect(mocks.getSubmission).not.toHaveBeenCalled();
  });

  it("reads the submission for an active club", async () => {
    mocks.orgFindUnique.mockResolvedValue({ type: "CLUB", isActive: true });
    await AreaClubFormPage(props);
    expect(mocks.getSubmission).toHaveBeenCalledWith({ kind: "AREA_COORDINATOR" }, "sub-1", "VIEW", "club-1");
  });
});
