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
  listUnmatchedBackgroundCheckEntries: vi.fn(),
  listNameOnlyBackgroundCheckMatches: vi.fn(),
  rejectNameOnlyBackgroundCheckMatch: vi.fn(),
  lookupBackgroundCheckName: vi.fn(),
  rematchBackgroundCheckList: vi.fn(),
  matchRejectedBackgroundCheckPairing: vi.fn(),
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
  listUnmatchedBackgroundCheckEntries: mocks.listUnmatchedBackgroundCheckEntries,
  listNameOnlyBackgroundCheckMatches: mocks.listNameOnlyBackgroundCheckMatches,
  rejectNameOnlyBackgroundCheckMatch: mocks.rejectNameOnlyBackgroundCheckMatch,
  lookupBackgroundCheckName: mocks.lookupBackgroundCheckName,
  rematchBackgroundCheckList: mocks.rematchBackgroundCheckList,
  matchRejectedBackgroundCheckPairing: mocks.matchRejectedBackgroundCheckPairing,
}));

import { POST as importPost } from "@/app/api/admin/background-checks/import/route";
import { POST as reviewPost } from "@/app/api/admin/background-checks/reviews/[reviewId]/route";
import { DELETE as undoDelete } from "@/app/api/admin/background-checks/manual-matches/[matchId]/route";
import { GET as manualGet } from "@/app/api/admin/background-checks/manual-matches/route";
import { GET as reviewsGet } from "@/app/api/admin/background-checks/reviews/route";
import { GET as unmatchedGet } from "@/app/api/admin/background-checks/unmatched/route";
import { GET as nameOnlyGet } from "@/app/api/admin/background-checks/name-only-matches/route";
import { DELETE as nameOnlyDelete } from "@/app/api/admin/background-checks/name-only-matches/[matchId]/route";
import { GET as lookupGet } from "@/app/api/admin/background-checks/lookup/route";
import { POST as rejectedMatchPost } from "@/app/api/admin/background-checks/rejected-matches/route";
import { POST as rematchPost } from "@/app/api/admin/background-checks/rematch/route";
import { AccessDeniedError } from "@/modules/access/authorization";
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
  mocks.listUnmatchedBackgroundCheckEntries.mockResolvedValue([]);
  mocks.listNameOnlyBackgroundCheckMatches.mockResolvedValue([]);
  mocks.lookupBackgroundCheckName.mockResolvedValue({ query: "", hasList: true, rows: [], people: [], pairs: [], truncated: false });
});

describe("name-only matches, lookup, and Refresh routes (#598)", () => {
  const matchCtx = { params: Promise.resolve({ matchId: "m-1" }) };
  const url = (path: string) => `https://events.imsda.test/api/admin/background-checks/${path}`;

  it("lists name-only matches and rejects one as not the same person", async () => {
    mocks.listNameOnlyBackgroundCheckMatches.mockResolvedValue([{ id: "m-1", personName: "Mina Osei" }]);
    const list = await nameOnlyGet(new Request(url("name-only-matches")));
    await expect(list.json()).resolves.toEqual({ matches: [{ id: "m-1", personName: "Mina Osei" }] });
    const response = await nameOnlyDelete(post("/api/admin/background-checks/name-only-matches/m-1", undefined, "DELETE"), matchCtx);
    expect(response.status).toBe(200);
    expect(mocks.rejectNameOnlyBackgroundCheckMatch).toHaveBeenCalledWith("m-1", "admin-1");
  });

  it("is a 404 for a match that's gone and a 400 for one not made on the name alone", async () => {
    mocks.rejectNameOnlyBackgroundCheckMatch.mockRejectedValueOnce(new BackgroundCheckOperationError("MATCH_NOT_FOUND", "gone"));
    expect((await nameOnlyDelete(post("/api/admin/background-checks/name-only-matches/m-1", undefined, "DELETE"), matchCtx)).status).toBe(404);
    mocks.rejectNameOnlyBackgroundCheckMatch.mockRejectedValueOnce(new BackgroundCheckOperationError("NOT_A_NAME_ONLY_MATCH", "no"));
    expect((await nameOnlyDelete(post("/api/admin/background-checks/name-only-matches/m-1", undefined, "DELETE"), matchCtx)).status).toBe(400);
  });

  it("looks a name up and re-matches on Refresh, and Refresh is a 409 during an upload", async () => {
    const lookup = await lookupGet(new Request(url("lookup?name=Mina%20Osei")));
    expect(lookup.status).toBe(200);
    expect(mocks.lookupBackgroundCheckName).toHaveBeenCalledWith("Mina Osei");
    expect((await rematchPost(post("/api/admin/background-checks/rematch", undefined))).status).toBe(200);
    expect(mocks.rematchBackgroundCheckList).toHaveBeenCalledTimes(1);
    mocks.rematchBackgroundCheckList.mockRejectedValueOnce(new BackgroundCheckOperationError("UPLOAD_IN_PROGRESS", "busy"));
    expect((await rematchPost(post("/api/admin/background-checks/rematch", undefined))).status).toBe(409);
  });

  it("matches a rejected pair anyway, staff-only, with clear errors", async () => {
    const body = { entryId: "e-1", personId: "p-1" };
    expect((await rejectedMatchPost(post("/api/admin/background-checks/rejected-matches", body))).status).toBe(200);
    expect(mocks.matchRejectedBackgroundCheckPairing).toHaveBeenCalledWith("e-1", "p-1", "admin-1");
    expect((await rejectedMatchPost(post("/api/admin/background-checks/rejected-matches", { entryId: "e-1" }))).status).toBe(400);
    mocks.matchRejectedBackgroundCheckPairing.mockRejectedValueOnce(new BackgroundCheckOperationError("LIST_BUSY", "busy"));
    expect((await rejectedMatchPost(post("/api/admin/background-checks/rejected-matches", body))).status).toBe(409);
    mocks.matchRejectedBackgroundCheckPairing.mockClear();
    mocks.requireSystemAdministrator.mockRejectedValueOnce(new AccessDeniedError("System administrator access is required.", 403, "PERMISSION_DENIED"));
    expect((await rejectedMatchPost(post("/api/admin/background-checks/rejected-matches", body))).status).toBe(403);
    expect(mocks.matchRejectedBackgroundCheckPairing).not.toHaveBeenCalled();
  });

  it("refuses all four to anyone who isn't a system administrator, and a cross-origin write", async () => {
    mocks.requireSystemAdministrator.mockRejectedValue(new AccessDeniedError("System administrator access is required.", 403, "PERMISSION_DENIED"));
    const responses = [
      await nameOnlyGet(new Request(url("name-only-matches"))),
      await nameOnlyDelete(post("/api/admin/background-checks/name-only-matches/m-1", undefined, "DELETE"), matchCtx),
      await lookupGet(new Request(url("lookup?name=Mina%20Osei"))),
      await rematchPost(post("/api/admin/background-checks/rematch", undefined)),
    ];
    expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403]);
    expect(mocks.listNameOnlyBackgroundCheckMatches).not.toHaveBeenCalled();
    expect(mocks.rejectNameOnlyBackgroundCheckMatch).not.toHaveBeenCalled();
    expect(mocks.lookupBackgroundCheckName).not.toHaveBeenCalled();
    expect(mocks.rematchBackgroundCheckList).not.toHaveBeenCalled();
    mocks.rejectCrossOriginRequest.mockReturnValue(Response.json({ error: "CROSS_ORIGIN" }, { status: 403 }));
    expect((await rematchPost(post("/api/admin/background-checks/rematch", undefined))).status).toBe(403);
    expect(mocks.rematchBackgroundCheckList).not.toHaveBeenCalled();
  });
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

  it("reports a non-clear Sterling status as a problem and never passes that row on to be stored", async () => {
    const csv = [
      "First name,Last name,Email,Expiration date,Status",
      "Ana,Rivera,ana@example.test,2029-01-01,Clear",
      "Bo,Lee,bo@example.test,2029-01-01,Pending adjudication",
    ].join("\n");
    const response = await importPost(post("/api/admin/background-checks/import", { csv }));
    const body = await response.json();
    expect(body.problems).toEqual([{ line: 3, name: "Bo Lee", problems: ['Status is "Pending adjudication", not a clear check, so nothing was recorded. Review this person in Sterling.'] }]);
    const [rows] = mocks.planBackgroundCheckUpload.mock.calls[0]!;
    expect((rows as Array<{ firstName: string; complianceStatus: unknown; issuesNote: unknown }>).map((row) => [row.firstName, row.complianceStatus, row.issuesNote])).toEqual([["Ana", null, null]]);
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

describe("background-check staff routes are system administrators only (#527)", () => {
  it("refuses the review list, the unmatched list, manual matches, a review decision, and an undo to anyone else", async () => {
    mocks.requireSystemAdministrator.mockRejectedValue(new AccessDeniedError("System administrator access is required.", 403, "PERMISSION_DENIED"));
    const responses = [
      await reviewsGet(new Request("https://events.imsda.test/api/admin/background-checks/reviews")),
      await unmatchedGet(new Request("https://events.imsda.test/api/admin/background-checks/unmatched")),
      await manualGet(new Request("https://events.imsda.test/api/admin/background-checks/manual-matches")),
      await reviewPost(post("/api/admin/background-checks/reviews/r-1", { type: "dismiss" }), { params: Promise.resolve({ reviewId: "r-1" }) }),
      await undoDelete(post("/api/admin/background-checks/manual-matches/m-1", undefined, "DELETE"), { params: Promise.resolve({ matchId: "m-1" }) }),
      await importPost(post("/api/admin/background-checks/import", { csv: coupleCsv })),
    ];
    expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403, 403, 403]);
    expect(mocks.listBackgroundCheckReviews).not.toHaveBeenCalled();
    expect(mocks.listUnmatchedBackgroundCheckEntries).not.toHaveBeenCalled();
    expect(mocks.listManualBackgroundCheckMatches).not.toHaveBeenCalled();
    expect(mocks.resolveBackgroundCheckReview).not.toHaveBeenCalled();
    expect(mocks.undoManualBackgroundCheckMatch).not.toHaveBeenCalled();
    expect(mocks.planBackgroundCheckUpload).not.toHaveBeenCalled();
  });

  it("is a 409 to decide a review while an upload is in progress", async () => {
    mocks.resolveBackgroundCheckReview.mockRejectedValueOnce(new BackgroundCheckOperationError("UPLOAD_IN_PROGRESS", "A background-check list upload is in progress. Try again in a moment."));
    const response = await reviewPost(post("/api/admin/background-checks/reviews/r-1", { type: "dismiss" }), { params: Promise.resolve({ reviewId: "r-1" }) });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "UPLOAD_IN_PROGRESS" });
  });
});
