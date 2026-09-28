import { beforeEach, describe, expect, it, vi } from "vitest";

// The background-check admin routes (#527): the upload's preview fingerprint
// and 409, duplicate rows reported as problems, and review/undo errors as
// clear statuses instead of 500s.

const mocks = vi.hoisted(() => ({
  rejectCrossOriginRequest: vi.fn(),
  requireSystemAdministrator: vi.fn(),
  planBackgroundCheckUpload: vi.fn(),
  applyBackgroundCheckUpload: vi.fn(),
  listBackgroundCheckReviews: vi.fn(),
  resolveBackgroundCheckReview: vi.fn(),
  listManualBackgroundCheckMatches: vi.fn(),
  undoManualBackgroundCheckMatch: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/organizations/access", () => ({ requireSystemAdministrator: mocks.requireSystemAdministrator }));
vi.mock("@/modules/background-checks/repository", () => ({
  planBackgroundCheckUpload: mocks.planBackgroundCheckUpload,
  applyBackgroundCheckUpload: mocks.applyBackgroundCheckUpload,
  listBackgroundCheckReviews: mocks.listBackgroundCheckReviews,
  resolveBackgroundCheckReview: mocks.resolveBackgroundCheckReview,
  listManualBackgroundCheckMatches: mocks.listManualBackgroundCheckMatches,
  undoManualBackgroundCheckMatch: mocks.undoManualBackgroundCheckMatch,
}));

import { POST as importPost } from "@/app/api/admin/background-checks/import/route";
import { POST as reviewPost } from "@/app/api/admin/background-checks/reviews/[reviewId]/route";
import { DELETE as undoDelete } from "@/app/api/admin/background-checks/manual-matches/[matchId]/route";
import { BackgroundCheckOperationError } from "@/modules/background-checks/errors";

const post = (url: string, body: unknown, method = "POST") => new Request(`https://events.imsda.test${url}`, {
  method,
  headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const coupleCsv = [
  "First name,Last name,Email,Expiration date",
  "Ana,Rivera,family@example.test,2029-01-01",
  "Luis,Rivera,family@example.test,2029-01-01",
  "Ana,Rivera,family@example.test,2030-01-01",
].join("\n");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.requireSystemAdministrator.mockResolvedValue({ id: "admin-1" });
  mocks.planBackgroundCheckUpload.mockResolvedValue({ added: 2, changed: 0, dropped: 0, total: 2, fingerprint: "none:abc" });
  mocks.applyBackgroundCheckUpload.mockResolvedValue({ added: 2, changed: 0, dropped: 0, total: 2 });
  mocks.listBackgroundCheckReviews.mockResolvedValue([]);
  mocks.listManualBackgroundCheckMatches.mockResolvedValue([]);
});

describe("background-check upload route (#527)", () => {
  it("previews with a fingerprint, keeps a couple sharing one email, and reports a repeated person as a problem", async () => {
    const response = await importPost(post("/api/admin/background-checks/import", { csv: coupleCsv }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ format: "STERLING", fingerprint: "none:abc", total: 2 });
    expect(body.problems).toEqual([{ line: 2, name: "Ana Rivera", problems: ["Row 4 is the same person, so only row 4 is kept."] }]);
    const [rows] = mocks.planBackgroundCheckUpload.mock.calls[0]!;
    expect((rows as Array<{ firstName: string; line: number }>).map((row) => [row.line, row.firstName])).toEqual([[3, "Luis"], [4, "Ana"]]);
  });

  it("passes the echoed fingerprint to the confirm", async () => {
    const response = await importPost(post("/api/admin/background-checks/import", { csv: coupleCsv, confirm: true, fingerprint: "none:abc" }));
    expect(response.status).toBe(200);
    expect(mocks.applyBackgroundCheckUpload).toHaveBeenCalledWith(expect.any(Array), "STERLING", "admin-1", expect.any(Date), { expectedFingerprint: "none:abc" });
  });

  it("is a 409 to confirm without a preview, or when the preview changed", async () => {
    let response = await importPost(post("/api/admin/background-checks/import", { csv: coupleCsv, confirm: true }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "PREVIEW_CHANGED" });
    expect(mocks.applyBackgroundCheckUpload).not.toHaveBeenCalled();

    mocks.applyBackgroundCheckUpload.mockRejectedValueOnce(new BackgroundCheckOperationError("PREVIEW_CHANGED", "The list or the file changed since this preview."));
    response = await importPost(post("/api/admin/background-checks/import", { csv: coupleCsv, confirm: true, fingerprint: "stale" }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "PREVIEW_CHANGED" });
  });
});

describe("background-check review and undo routes (#527 N2, N5)", () => {
  const reviewCtx = { params: Promise.resolve({ reviewId: "r-1" }) };
  const matchCtx = { params: Promise.resolve({ matchId: "m-1" }) };

  it("is a 400 when the pick isn't a candidate, and a 404 for an unknown review", async () => {
    mocks.resolveBackgroundCheckReview.mockRejectedValueOnce(new BackgroundCheckOperationError("NOT_A_CANDIDATE", "That person isn't one of this row's candidates."));
    let response = await reviewPost(post("/api/admin/background-checks/reviews/r-1", { type: "match", personId: "p-x" }), reviewCtx);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "NOT_A_CANDIDATE" });

    mocks.resolveBackgroundCheckReview.mockRejectedValueOnce(new BackgroundCheckOperationError("REVIEW_NOT_FOUND", "That review was already resolved or no longer exists."));
    response = await reviewPost(post("/api/admin/background-checks/reviews/r-1", { type: "dismiss" }), reviewCtx);
    expect(response.status).toBe(404);
  });

  it("undoes a manual match and returns the rest", async () => {
    const response = await undoDelete(post("/api/admin/background-checks/manual-matches/m-1", undefined, "DELETE"), matchCtx);
    expect(response.status).toBe(200);
    expect(mocks.undoManualBackgroundCheckMatch).toHaveBeenCalledWith("m-1", "admin-1");
    await expect(response.json()).resolves.toEqual({ matches: [] });
  });

  it("is a 404 to undo a match that's gone and a 400 for one not made by hand", async () => {
    mocks.undoManualBackgroundCheckMatch.mockRejectedValueOnce(new BackgroundCheckOperationError("MATCH_NOT_FOUND", "That match no longer exists."));
    expect((await undoDelete(post("/api/admin/background-checks/manual-matches/m-1", undefined, "DELETE"), matchCtx)).status).toBe(404);
    mocks.undoManualBackgroundCheckMatch.mockRejectedValueOnce(new BackgroundCheckOperationError("NOT_A_MANUAL_MATCH", "Only a match made by hand can be undone here."));
    expect((await undoDelete(post("/api/admin/background-checks/manual-matches/m-1", undefined, "DELETE"), matchCtx)).status).toBe(400);
  });
});
