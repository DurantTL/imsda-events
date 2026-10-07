import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #817: the routes around new club applications. The public submit is open but
 * guarded (same origin, rate limit, bot check); deciding is for system
 * administrators only, with an Area Coordinator getting 403 and a signed-out
 * visitor 401; the attachment is for administrators and Area Coordinators and
 * looks like a missing file to everyone else. Synthetic data only.
 */

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  currentAreaCoordinatorViewerActive: vi.fn(),
  decide: vi.fn(),
  submit: vi.fn(),
  getAttachment: vi.fn(),
  createInvite: vi.fn(),
  listInvites: vi.fn(),
  submitLimit: vi.fn(),
  emailLimit: vi.fn(),
  linkLimit: vi.fn(),
  readAsset: vi.fn(),
  isSameOrigin: vi.fn(),
}));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/modules/organizations/area-coordinators", () => ({ currentAreaCoordinatorViewerActive: mocks.currentAreaCoordinatorViewerActive }));
vi.mock("@/modules/access/request-security", () => ({
  rejectCrossOriginRequest: (request: Request) => (request.headers.get("origin") === "https://events.imsda.test" ? null : Response.json({ error: "INVALID_REQUEST_ORIGIN" }, { status: 403 })),
}));
vi.mock("@/lib/request-context", () => ({ withRequestContext: (handler: unknown) => handler }));
vi.mock("@/modules/events/asset-storage", async (importOriginal) => ({ ...(await importOriginal<object>()), readAsset: mocks.readAsset }));
vi.mock("@/modules/rate-limit/service", () => ({
  checkNewClubApplicationSubmitRateLimit: mocks.submitLimit,
  checkNewClubApplicationEmailRateLimit: mocks.emailLimit,
  checkNewClubApplicationLinkRateLimit: mocks.linkLimit,
}));
vi.mock("@/modules/club-applications/repository", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  decideNewClubApplication: mocks.decide,
  submitNewClubApplication: mocks.submit,
  getApplicationAttachment: mocks.getAttachment,
  createNewClubInvite: mocks.createInvite,
  listNewClubInvites: mocks.listInvites,
}));
// The repository's own imports reach the database and outbox; the routes never call them here.
vi.mock("@/lib/prisma", () => ({ getPrisma: vi.fn() }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/modules/background-checks/repository", () => ({ directorBackgroundStatesByEmail: vi.fn() }));
vi.mock("@/modules/club-imports/invites", () => ({ createApplicationDirectorInvite: vi.fn() }));
vi.mock("@/modules/communications/account-email", () => ({ isAccountEmailConfigured: () => true, getAccountEmailSender: vi.fn(), AccountEmailNotConfiguredError: class extends Error {} }));
vi.mock("@/modules/communications/email-delivery", () => ({ processAccountEmailQueue: vi.fn() }));
vi.mock("@/modules/system-admin/platform-settings", () => ({ getPlatformSettings: vi.fn() }));
vi.mock("@/lib/env", () => ({ getServerEnv: () => ({ APP_BASE_URL: "https://events.imsda.test" }) }));

import { AccessDeniedError } from "@/modules/access/authorization";
import { NewClubApplicationError } from "@/modules/club-applications/repository";
import { POST as publicSubmit } from "@/app/api/public/club-applications/route";
import { POST as decide } from "@/app/api/admin/club-applications/[applicationId]/decision/route";
import { GET as attachment } from "@/app/api/admin/club-applications/[applicationId]/attachment/route";
import { POST as sendInvite } from "@/app/api/admin/club-applications/invites/route";

const origin = { origin: "https://events.imsda.test" };
const allowed = { allowed: true, decisions: [] };
const params = (applicationId = "app-1") => ({ params: Promise.resolve({ applicationId }) });

function staff(globalRole: "SYSTEM_ADMIN" | null) {
  mocks.getCurrentSession.mockResolvedValue({ user: { id: "user-1", email: "staff@imsda-events.test", displayName: "Sam Staff", globalRole } });
}

function formWith(data: unknown, extra: Record<string, string | Blob> = {}) {
  const body = new FormData();
  body.set("data", JSON.stringify(data));
  for (const [key, value] of Object.entries(extra)) body.set(key, value);
  return body;
}

const validData = {
  clubName: "Synthetic Trailblazers",
  clubType: "PATHFINDER",
  sponsoringChurchId: "church-1",
  pastorName: "Pat Pastor",
  directorName: "Dana Director",
  directorAddress: "100 Example Road, Sampletown, ZZ 00000",
  directorEmail: "dana.director@example.test",
  directorHomePhone: "555-0100",
  philosophyAgreed: true,
  pastorSignature: "Pat Pastor",
  headElderSignature: "Hal Elder",
  clerkSignature: "Cleo Clerk",
  directorSignature: "Dana Director",
  otherBoardMembers: [],
  formOpenedAt: Date.now() - 60_000,
  website: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentSession.mockResolvedValue({ user: null });
  mocks.currentAreaCoordinatorViewerActive.mockResolvedValue(false);
  mocks.submitLimit.mockResolvedValue(allowed);
  mocks.emailLimit.mockResolvedValue(allowed);
  mocks.linkLimit.mockResolvedValue(allowed);
  mocks.submit.mockResolvedValue({ id: "app-1" });
  mocks.decide.mockResolvedValue({ status: "APPROVED", organizationId: "org-1" });
  mocks.listInvites.mockResolvedValue([]);
});

describe("POST /api/public/club-applications", () => {
  /** Sends like a browser does: the body is serialized first so the request states its own Content-Length. */
  const post = async (body: BodyInit, headers: Record<string, string> = origin) => {
    const probe = new Request("https://events.imsda.test/x", { method: "POST", body });
    const bytes = await probe.arrayBuffer();
    const type = probe.headers.get("content-type");
    return publicSubmit(new Request("https://events.imsda.test/api/public/club-applications", {
      method: "POST",
      headers: { ...(type ? { "content-type": type } : {}), "content-length": String(bytes.byteLength), ...headers },
      body: bytes,
    }));
  };
  const postRaw = (headers: Record<string, string>, body?: BodyInit) => publicSubmit(new Request("https://events.imsda.test/api/public/club-applications", { method: "POST", headers: { ...origin, ...headers }, body }));

  it("takes an application from anyone, signed out, and does not echo an id", async () => {
    const response = await post(formWith(validData));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.submit).toHaveBeenCalledTimes(1);
    expect(mocks.submit.mock.calls[0]![0]).toMatchObject({ clubName: "Synthetic Trailblazers", directorEmail: "dana.director@example.test" });
    expect(mocks.submit.mock.calls[0]![1]).toMatchObject({ attachment: null, inviteToken: null });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("passes the attachment and the invite token along", async () => {
    const file = new File(["%PDF-1.4"], "page.pdf", { type: "application/pdf" });
    await post(formWith(validData, { attachment: file, inviteToken: "token-abc" }));
    expect(mocks.submit.mock.calls[0]![1]).toMatchObject({ inviteToken: "token-abc" });
    expect(mocks.submit.mock.calls[0]![1].attachment).toBeInstanceOf(File);
    expect(mocks.linkLimit).toHaveBeenCalledTimes(1);
  });

  it("refuses a request from another origin (CSRF) before doing anything", async () => {
    const response = await post(formWith(validData), { origin: "https://evil.example" });
    expect(response.status).toBe(403);
    expect(mocks.submitLimit).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("is rate limited, by client and then by director email, charging the client once per submit", async () => {
    mocks.submitLimit.mockResolvedValueOnce({ allowed: false, decisions: [] });
    expect((await post(formWith(validData))).status).toBe(429);
    mocks.submitLimit.mockClear();
    mocks.emailLimit.mockResolvedValueOnce({ allowed: false, decisions: [] });
    expect((await post(formWith(validData))).status).toBe(429);
    expect(mocks.submitLimit).toHaveBeenCalledTimes(1);
    expect(mocks.emailLimit).toHaveBeenCalledWith("dana.director@example.test");
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("fails the bot check when the hidden field is filled", async () => {
    const response = await post(formWith({ ...validData, website: "https://spam.example" }));
    expect(response.status).toBe(400);
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("answers a form sent too quickly or with a bad file with a clear status", async () => {
    mocks.submit.mockRejectedValueOnce(new NewClubApplicationError("TOO_QUICK", "That was sent too quickly."));
    expect((await post(formWith(validData))).status).toBe(400);
    mocks.submit.mockRejectedValueOnce(new NewClubApplicationError("ATTACHMENT_TYPE", "Attach a PDF or an image."));
    expect((await post(formWith(validData))).status).toBe(415);
    mocks.submit.mockRejectedValueOnce(new NewClubApplicationError("INVITE_UNAVAILABLE", "This link can't be used any more."));
    expect((await post(formWith(validData))).status).toBe(410);
  });

  it("refuses a form with no answers, and an oversized one", async () => {
    expect((await post(new FormData())).status).toBe(400);
    const response = await post(formWith(validData), { ...origin, "content-length": String(40 * 1024 * 1024) });
    expect(response.status).toBe(413);
  });

  it("refuses a request that doesn't say how big it is", async () => {
    const response = await postRaw({ "content-type": "text/plain" }, "hello");
    expect(response.status).toBe(411);
    expect(mocks.submit).not.toHaveBeenCalled();
    expect((await postRaw({ "content-type": "text/plain", "content-length": "abc" }, "hello")).status).toBe(411);
  });

  it("answers a JSON body or a text body with 400 INVALID_REQUEST, not a server error", async () => {
    for (const [type, body] of [["application/json", JSON.stringify(validData)], ["text/plain", "just some text"]] as const) {
      const response = await postRaw({ "content-type": type, "content-length": String(Buffer.byteLength(body)) }, body);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("INVALID_REQUEST");
    }
    const badJson = new FormData();
    badJson.set("data", "{not json");
    const notJson = await post(badJson);
    expect(notJson.status).toBe(400);
    expect((await notJson.json()).error).toBe("INVALID_REQUEST");
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("never shows an unexpected failure's details", async () => {
    mocks.submit.mockRejectedValueOnce(new Error("relation \"NewClubApplication\" does not exist"));
    const response = await post(formWith(validData));
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("relation");
  });
});

describe("POST /api/admin/club-applications/[id]/decision", () => {
  const post = (body: unknown = { decision: "approve" }) => decide(new Request("https://events.imsda.test/api/admin/club-applications/app-1/decision", { method: "POST", headers: { ...origin, "content-type": "application/json" }, body: JSON.stringify(body) }), params());

  it("lets a system administrator approve", async () => {
    staff("SYSTEM_ADMIN");
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "app-1", status: "APPROVED", organizationId: "org-1" });
    expect(mocks.decide).toHaveBeenCalledWith(expect.objectContaining({ id: "user-1", globalRole: "SYSTEM_ADMIN" }), "app-1", { decision: "approve" });
  });

  it("lets a system administrator decline with a reason", async () => {
    staff("SYSTEM_ADMIN");
    mocks.decide.mockResolvedValue({ status: "DECLINED", organizationId: null });
    expect((await post({ decision: "decline", declineReason: "Not this year" })).status).toBe(200);
    expect(mocks.decide).toHaveBeenCalledWith(expect.anything(), "app-1", { decision: "decline", declineReason: "Not this year" });
  });

  it("gives an Area Coordinator, who can read the queue, a 403", async () => {
    mocks.currentAreaCoordinatorViewerActive.mockResolvedValue(true);
    const response = await post();
    expect(response.status).toBe(403);
    expect(mocks.decide).not.toHaveBeenCalled();
  });

  it("gives other staff a 403 and a signed-out visitor a 401", async () => {
    staff(null);
    expect((await post()).status).toBe(403);
    mocks.getCurrentSession.mockResolvedValue({ user: null });
    expect((await post()).status).toBe(401);
    expect(mocks.decide).not.toHaveBeenCalled();
  });

  it("refuses a request from another origin", async () => {
    staff("SYSTEM_ADMIN");
    const response = await decide(new Request("https://events.imsda.test/x", { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" }), params());
    expect(response.status).toBe(403);
    expect(mocks.decide).not.toHaveBeenCalled();
  });

  it("reports a second decision as a conflict, and a bad decision as invalid", async () => {
    staff("SYSTEM_ADMIN");
    mocks.decide.mockRejectedValueOnce(new NewClubApplicationError("ALREADY_DECIDED", "That application was already decided."));
    expect((await post()).status).toBe(409);
    expect((await post({ decision: "maybe" })).status).toBe(400);
  });
});

describe("GET /api/admin/club-applications/[id]/attachment", () => {
  const get = () => attachment(new Request("https://events.imsda.test/api/admin/club-applications/app-1/attachment"), params());
  const stored = { displayName: "Signed page.pdf", contentType: "application/pdf", storageKey: "new-club-applications/abc.pdf" };

  it("serves the file to a system administrator and an Area Coordinator as a private download", async () => {
    mocks.getAttachment.mockResolvedValue(stored);
    mocks.readAsset.mockResolvedValue(Buffer.from("%PDF-1.4 synthetic"));
    staff("SYSTEM_ADMIN");
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.getAttachment).toHaveBeenCalledWith("SYSTEM_ADMIN", "app-1");

    mocks.getCurrentSession.mockResolvedValue({ user: null });
    mocks.currentAreaCoordinatorViewerActive.mockResolvedValue(true);
    expect((await get()).status).toBe(200);
    expect(mocks.getAttachment).toHaveBeenLastCalledWith("AREA_COORDINATOR", "app-1");
  });

  it("looks like a missing file to anyone else, without asking the database", async () => {
    mocks.getAttachment.mockResolvedValue(stored);
    expect((await get()).status).toBe(404);
    staff(null);
    expect((await get()).status).toBe(404);
    expect(mocks.getAttachment).not.toHaveBeenCalled();
  });

  it("is a 404 when the application has no attachment", async () => {
    staff("SYSTEM_ADMIN");
    mocks.getAttachment.mockResolvedValue(null);
    expect((await get()).status).toBe(404);
  });

  it("is a 404, not a 403, when access is denied inside", async () => {
    staff("SYSTEM_ADMIN");
    mocks.getAttachment.mockRejectedValue(new AccessDeniedError("no", 403, "PERMISSION_DENIED"));
    expect((await get()).status).toBe(404);
  });
});

describe("POST /api/admin/club-applications/invites", () => {
  const post = (body: unknown = { email: "New.Director@Example.test" }) => sendInvite(new Request("https://events.imsda.test/api/admin/club-applications/invites", { method: "POST", headers: { ...origin, "content-type": "application/json" }, body: JSON.stringify(body) }));

  it("is for system administrators only", async () => {
    mocks.currentAreaCoordinatorViewerActive.mockResolvedValue(true);
    expect((await post()).status).toBe(401);
    staff(null);
    expect((await post()).status).toBe(403);
    expect(mocks.createInvite).not.toHaveBeenCalled();
  });

  it("sends the link for a system administrator, with the email cleaned", async () => {
    staff("SYSTEM_ADMIN");
    expect((await post()).status).toBe(201);
    expect(mocks.createInvite).toHaveBeenCalledWith(expect.objectContaining({ id: "user-1" }), { email: "new.director@example.test", name: "" });
    expect((await post({ email: "nope" })).status).toBe(400);
  });
});
