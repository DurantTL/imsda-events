import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Synthetic data only. */

const mocks = vi.hoisted(() => ({
  rejectCrossOriginRequest: vi.fn(),
  requireClubLeaderViewer: vi.fn(),
  confirmAddToRoster: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/request-context", () => ({ withRequestContext: (handler: unknown) => handler }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/club-forms/access", () => ({ requireClubLeaderViewer: mocks.requireClubLeaderViewer }));
vi.mock("@/modules/club-forms/roster-add", () => ({ confirmAddToRoster: mocks.confirmAddToRoster }));

import { POST } from "@/app/api/attendee/clubs/[organizationId]/forms/submissions/[submissionId]/roster/route";
import { ClubFormError } from "@/modules/club-forms/errors";
import { RosterAccessError } from "@/modules/club-rosters/access";

const leader = { kind: "CLUB_LEADER", organizationId: "club-a", actor: { kind: "ATTENDEE", accountId: "acct-1" } };
const context = { params: Promise.resolve({ organizationId: "club-a", submissionId: "sub-1" }) };
const post = (body: unknown) =>
  POST(new Request("https://events.imsda.test/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), context);

const member = { firstName: "Jordan", lastName: "Sample", birthDate: "2013-04-09", attendeeType: "YOUTH", role: "", classLevel: null, gender: "FEMALE" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.requireClubLeaderViewer.mockResolvedValue(leader);
  mocks.confirmAddToRoster.mockResolvedValue({ action: "ADDED", rosterMemberId: "member-1", clubYear: "2026-27" });
});

describe("POST roster for a submitted form (#721)", () => {
  it("adds, scoped to the club and form in the URL, never the body, and answers private and no-store", async () => {
    const response = await post({ action: "ADD", clubYear: "2026-27", member });
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(await response.json()).toEqual({ result: { action: "ADDED", rosterMemberId: "member-1", clubYear: "2026-27" } });
    expect(mocks.requireClubLeaderViewer).toHaveBeenCalledWith("club-a");
    expect(mocks.confirmAddToRoster).toHaveBeenCalledWith(leader, expect.objectContaining({ action: "ADD", organizationId: "club-a", submissionId: "sub-1", clubYear: "2026-27" }));
  });

  it("applies the roster's own member rules (a missing gender is a 400, nothing is added)", async () => {
    const response = await post({ action: "ADD", clubYear: "2026-27", member: { ...member, gender: null } });
    expect(response.status).toBe(400);
    expect(mocks.confirmAddToRoster).not.toHaveBeenCalled();
  });

  it("has no field for any other answer to travel in (strict bodies)", async () => {
    expect((await post({ action: "ADD", clubYear: "2026-27", member, answers: { health_limitation: "Yes" } })).status).toBe(400);
    expect((await post({ action: "ADD", clubYear: "2026-27", member: { ...member, healthNotes: "Synthetic" } })).status).toBe(400);
    expect((await post({ action: "LINK", memberId: "member-9", organizationId: "club-b" })).status).toBe(400);
    expect((await post({ action: "MERGE", memberId: "member-9" })).status).toBe(400);
    expect(mocks.confirmAddToRoster).not.toHaveBeenCalled();
  });

  it("links to an existing member without any member details", async () => {
    mocks.confirmAddToRoster.mockResolvedValue({ action: "LINKED", rosterMemberId: "member-9", clubYear: "2026-27" });
    const response = await post({ action: "LINK", memberId: "member-9" });
    expect(response.status).toBe(201);
    expect(mocks.confirmAddToRoster).toHaveBeenCalledWith(leader, { action: "LINK", memberId: "member-9", organizationId: "club-a", submissionId: "sub-1" });
  });

  it("refuses a registrar, who is never a club forms viewer, and an unknown club", async () => {
    mocks.requireClubLeaderViewer.mockRejectedValueOnce(new ClubFormError("FORBIDDEN", "Club forms are for the club's director and deputy."));
    expect((await post({ action: "LINK", memberId: "member-9" })).status).toBe(403);
    mocks.requireClubLeaderViewer.mockRejectedValueOnce(new RosterAccessError("NOT_FOUND", 404, "That club could not be found."));
    expect((await post({ action: "LINK", memberId: "member-9" })).status).toBe(404);
    mocks.requireClubLeaderViewer.mockRejectedValueOnce(new RosterAccessError("SIGN_IN_REQUIRED", 401, "Sign in to open your club roster."));
    expect((await post({ action: "LINK", memberId: "member-9" })).status).toBe(401);
    expect(mocks.confirmAddToRoster).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin request before anything else", async () => {
    mocks.rejectCrossOriginRequest.mockReturnValueOnce(Response.json({ error: "CROSS_ORIGIN" }, { status: 403 }));
    expect((await post({ action: "LINK", memberId: "member-9" })).status).toBe(403);
    expect(mocks.requireClubLeaderViewer).not.toHaveBeenCalled();
  });

  it.each([
    ["ALREADY_ON_ROSTER", 409],
    ["ROSTER_ADD_UNAVAILABLE", 409],
    ["DUPLICATE_ON_ROSTER", 409],
    ["MEMBER_NOT_FOUND", 404],
    ["SUBMISSION_NOT_FOUND", 404],
  ] as const)("answers %s with %i and the duplicate choices, never an answer", async (code, status) => {
    mocks.confirmAddToRoster.mockRejectedValue(new ClubFormError(code, "Message.", code === "DUPLICATE_ON_ROSTER" ? [{ key: "duplicate:member-9", message: "Jordan Sample" }] : []));
    const response = await post({ action: "LINK", memberId: "member-9" });
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body.error).toBe(code);
    if (code === "DUPLICATE_ON_ROSTER") expect(body.issues).toEqual([{ key: "duplicate:member-9", message: "Jordan Sample" }]);
  });
});

describe("the Health Record (#611) is never fed from a form (#721)", () => {
  const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

  it.each([
    "modules/club-forms/roster-add.ts",
    "modules/club-forms/roster-mapping.ts",
    "app/api/attendee/clubs/[organizationId]/forms/submissions/[submissionId]/roster/route.ts",
  ])("%s does not touch the health record module or its tables", (file) => {
    expect(read(file)).not.toMatch(/health-records|healthRecord|HealthRecord/);
  });

  it("opens the sealed answers only through the one audited read", () => {
    expect(read("modules/club-forms/roster-add.ts")).not.toMatch(/sealedSensitiveAnswers|openSensitiveAnswers/);
    expect(read("modules/club-forms/roster-add.ts")).toContain("getSubmissionForViewer");
  });
});
