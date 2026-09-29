import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rejectCrossOriginRequest: vi.fn(),
  requireClubLeaderViewer: vi.fn(),
  requireStaffViewer: vi.fn(),
  requireSystemAdministrator: vi.fn(),
  createClubFormLink: vi.fn(),
  resolveClubFormLinkForFill: vi.fn(),
  submitClubFormViaLink: vi.fn(),
  revokeClubFormLink: vi.fn(),
  saveClubFormSubmission: vi.fn(),
  setClubFormTemplateEnabled: vi.fn(),
  buildClubFormsCsv: vi.fn(),
  checkClubFormLinkRateLimit: vi.fn(),
  checkClubFormLinkCreateRateLimit: vi.fn(),
  processAccountEmailQueue: vi.fn(),
  after: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/lib/request-context", () => ({ withRequestContext: (handler: unknown) => handler }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/club-forms/access", () => ({
  requireClubLeaderViewer: mocks.requireClubLeaderViewer,
  requireStaffViewer: mocks.requireStaffViewer,
}));
vi.mock("@/modules/organizations/access", () => ({ requireSystemAdministrator: mocks.requireSystemAdministrator }));
vi.mock("@/modules/club-forms/links", () => ({
  createClubFormLink: mocks.createClubFormLink,
  resolveClubFormLinkForFill: mocks.resolveClubFormLinkForFill,
  submitClubFormViaLink: mocks.submitClubFormViaLink,
  revokeClubFormLink: mocks.revokeClubFormLink,
}));
vi.mock("@/modules/club-forms/submissions", () => ({ saveClubFormSubmission: mocks.saveClubFormSubmission }));
vi.mock("@/modules/club-forms/templates", () => ({ setClubFormTemplateEnabled: mocks.setClubFormTemplateEnabled }));
vi.mock("@/modules/club-forms/csv", () => ({ buildClubFormsCsv: mocks.buildClubFormsCsv }));
vi.mock("@/modules/communications/email-delivery", () => ({ processAccountEmailQueue: mocks.processAccountEmailQueue }));
vi.mock("@/modules/rate-limit/service", () => ({
  checkClubFormLinkRateLimit: mocks.checkClubFormLinkRateLimit,
  checkClubFormLinkCreateRateLimit: mocks.checkClubFormLinkCreateRateLimit,
}));
vi.mock("@/modules/club-rosters/access", () => ({
  RosterAccessError: class RosterAccessError extends Error {
    constructor(public readonly code: string, public readonly status: number, message: string) {
      super(message);
    }
  },
}));
vi.mock("@/modules/club-rosters/api-errors", () => ({
  RosterBodyError: class RosterBodyError extends Error { readonly code = "INVALID_JSON_BODY"; },
  readRosterJson: async (request: Request) => request.json(),
}));

import { DELETE as REVOKE } from "@/app/api/attendee/clubs/[organizationId]/forms/links/[linkId]/route";
import { POST as SEND_LINK } from "@/app/api/attendee/clubs/[organizationId]/forms/links/route";
import { POST as SAVE } from "@/app/api/attendee/clubs/[organizationId]/forms/submissions/route";
import { PATCH as TOGGLE } from "@/app/api/admin/club-forms/[templateKey]/route";
import { GET as PUBLIC_GET, POST as PUBLIC_POST } from "@/app/api/public/club-forms/[token]/route";
import { GET as EXPORT } from "@/app/api/staff/club-forms/export/route";
import { AccessDeniedError } from "@/modules/access/authorization";
import { ClubFormError } from "@/modules/club-forms/errors";
import { RosterAccessError } from "@/modules/club-rosters/access";

const TOKEN = "T".repeat(43);
const allowed = { allowed: true, decisions: [] };
const denied = { allowed: false, decisions: [{ policy: "p", allowed: false, limit: 1, remaining: 0, count: 2, windowSeconds: 900, resetAfterSeconds: 60 }] };
const leader = { kind: "CLUB_LEADER", organizationId: "club-a", actor: { kind: "ATTENDEE", accountId: "acct-1" } };

const json = (body: unknown, url = "https://events.imsda.test/x", method = "POST") =>
  new Request(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const club = (organizationId = "club-a", linkId = "link-1") => ({ params: Promise.resolve({ organizationId, linkId }) });
const tokenContext = (token = TOKEN) => ({ params: Promise.resolve({ token }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.requireClubLeaderViewer.mockResolvedValue(leader);
  mocks.checkClubFormLinkRateLimit.mockResolvedValue(allowed);
  mocks.checkClubFormLinkCreateRateLimit.mockResolvedValue(allowed);
  mocks.createClubFormLink.mockResolvedValue({ linkId: "link-1", messageId: "message-1", expiresAt: new Date("2026-10-19T15:00:00Z") });
});

describe("the private link's public routes (#610)", () => {
  it("returns the form on GET with private, no-store, no-referrer headers", async () => {
    mocks.resolveClubFormLinkForFill.mockResolvedValue({ clubName: "Example Pathfinders", form: { name: "Slip" } });
    const response = await PUBLIC_GET(new Request("https://events.imsda.test/api/public/club-forms/x"), tokenContext());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
    expect(mocks.checkClubFormLinkRateLimit).toHaveBeenCalledWith(expect.any(Request), TOKEN, "read");
  });

  it("stops at the rate limit before it looks anything up, on both read and submit", async () => {
    mocks.checkClubFormLinkRateLimit.mockResolvedValue(denied);
    const read = await PUBLIC_GET(new Request("https://events.imsda.test/api/public/club-forms/x"), tokenContext());
    expect(read.status).toBe(429);
    const submit = await PUBLIC_POST(json({ answers: {} }), tokenContext());
    expect(submit.status).toBe(429);
    expect(mocks.resolveClubFormLinkForFill).not.toHaveBeenCalled();
    expect(mocks.submitClubFormViaLink).not.toHaveBeenCalled();
    expect(mocks.checkClubFormLinkRateLimit).toHaveBeenLastCalledWith(expect.any(Request), TOKEN, "submit");
  });

  it("gives every unusable link the same 404", async () => {
    mocks.resolveClubFormLinkForFill.mockRejectedValue(new ClubFormError("LINK_UNAVAILABLE", "This private link is invalid or no longer active."));
    mocks.submitClubFormViaLink.mockRejectedValue(new ClubFormError("LINK_UNAVAILABLE", "This private link is invalid or no longer active."));
    const read = await PUBLIC_GET(new Request("https://events.imsda.test/api/public/club-forms/x"), tokenContext());
    const submit = await PUBLIC_POST(json({ answers: {} }), tokenContext());
    expect(read.status).toBe(404);
    expect(submit.status).toBe(404);
    expect(await read.json()).toEqual(await submit.json());
  });

  it("submits once and reports only that it worked, never the submission id", async () => {
    mocks.submitClubFormViaLink.mockResolvedValue({ submissionId: "sub-1", confirmationMessage: "Thank you." });
    const response = await PUBLIC_POST(json({ answers: { child_name: "Riley Sample" } }), tokenContext());
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toEqual({ ok: true, confirmationMessage: "Thank you." });
    expect(mocks.submitClubFormViaLink).toHaveBeenCalledWith(TOKEN, { child_name: "Riley Sample" });
  });

  it("returns validation problems by label and keeps the link usable", async () => {
    mocks.submitClubFormViaLink.mockRejectedValue(new ClubFormError("VALIDATION_FAILED", "Child's name is required.", [{ key: "child_name", message: "Child's name is required." }]));
    const response = await PUBLIC_POST(json({ answers: {} }), tokenContext());
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "VALIDATION_FAILED", issues: [{ key: "child_name" }] });
  });

  it("rejects a cross-origin submit, an oversized body and malformed JSON", async () => {
    mocks.rejectCrossOriginRequest.mockReturnValueOnce(Response.json({ error: "CROSS_ORIGIN" }, { status: 403 }));
    expect((await PUBLIC_POST(json({ answers: {} }), tokenContext())).status).toBe(403);
    const big = await PUBLIC_POST(new Request("https://events.imsda.test/x", { method: "POST", body: JSON.stringify({ answers: { note: "x".repeat(400_000) } }) }), tokenContext());
    expect(big.status).toBe(413);
    const bad = await PUBLIC_POST(new Request("https://events.imsda.test/x", { method: "POST", body: "{not json" }), tokenContext());
    expect(bad.status).toBe(400);
    expect(mocks.submitClubFormViaLink).not.toHaveBeenCalled();
  });

  it("refuses an unknown key in the body", async () => {
    const response = await PUBLIC_POST(json({ answers: {}, organizationId: "club-b" }), tokenContext());
    expect(response.status).toBe(400);
    expect(mocks.submitClubFormViaLink).not.toHaveBeenCalled();
  });
});

describe("sending and withdrawing links from the club portal (#610)", () => {
  const body = { templateKey: "off_premises_permission_slip", recipientEmail: "parent@example.test" };

  it("sends the link, then delivers the queued email after the response", async () => {
    const response = await SEND_LINK(json(body), club());
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ link: { id: "link-1", expiresAt: "2026-10-19T15:00:00.000Z" } });
    expect(mocks.createClubFormLink).toHaveBeenCalledWith(leader, { ...body, organizationId: "club-a" });
    // Delivery is scheduled for after the response, not run inside the transaction or the handler.
    expect(mocks.processAccountEmailQueue).not.toHaveBeenCalled();
    expect(mocks.after).toHaveBeenCalledTimes(1);
    await mocks.after.mock.calls[0][0]();
    expect(mocks.processAccountEmailQueue).toHaveBeenCalledWith({ messageIds: ["message-1"], limit: 1 });
  });

  it("rate limits per director, club and recipient address", async () => {
    await SEND_LINK(json(body), club());
    expect(mocks.checkClubFormLinkCreateRateLimit).toHaveBeenCalledWith(expect.any(Request), "acct-1", "club-a", "parent@example.test");
    mocks.checkClubFormLinkCreateRateLimit.mockResolvedValue(denied);
    const limited = await SEND_LINK(json(body), club());
    expect(limited.status).toBe(429);
    expect(mocks.createClubFormLink).toHaveBeenCalledTimes(1);
  });

  it("takes the club from the URL, never from the body", async () => {
    const response = await SEND_LINK(json({ ...body, organizationId: "club-b" }), club());
    expect(response.status).toBe(400);
    expect(mocks.createClubFormLink).not.toHaveBeenCalled();
  });

  it("refuses a registrar, reporter or another club's director before anything is queued", async () => {
    mocks.requireClubLeaderViewer.mockRejectedValue(new ClubFormError("FORBIDDEN", "Club forms are for the club's director and deputy."));
    expect((await SEND_LINK(json(body), club())).status).toBe(403);
    mocks.requireClubLeaderViewer.mockRejectedValue(new RosterAccessError("NOT_FOUND", 404, "That club could not be found."));
    const other = await SEND_LINK(json(body), club("club-b"));
    expect(other.status).toBe(404);
    expect(mocks.createClubFormLink).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("reports missing email setup as unavailable, not as a crash", async () => {
    mocks.createClubFormLink.mockRejectedValue(new ClubFormError("EMAIL_NOT_CONFIGURED", "Email isn't set up."));
    expect((await SEND_LINK(json(body), club())).status).toBe(503);
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("withdraws a link, scoped to the club in the URL", async () => {
    const response = await REVOKE(new Request("https://events.imsda.test/x", { method: "DELETE" }), club("club-a", "link-1"));
    expect(response.status).toBe(200);
    expect(mocks.revokeClubFormLink).toHaveBeenCalledWith(leader, "club-a", "link-1");
    mocks.revokeClubFormLink.mockRejectedValue(new ClubFormError("LINK_NOT_FOUND", "That link could not be found."));
    expect((await REVOKE(new Request("https://events.imsda.test/x", { method: "DELETE" }), club("club-a", "link-of-club-b"))).status).toBe(404);
  });

  it("saves a form for the club in the URL", async () => {
    mocks.saveClubFormSubmission.mockResolvedValue({ id: "sub-1", status: "SUBMITTED" });
    const response = await SAVE(json({ templateKey: "off_premises_permission_slip", answers: { child_name: "Riley Sample" }, submit: true }), club());
    expect(response.status).toBe(201);
    expect(mocks.saveClubFormSubmission).toHaveBeenCalledWith(leader, expect.objectContaining({ organizationId: "club-a", submit: true }));
    const forged = await SAVE(json({ templateKey: "t", answers: {}, submit: true, organizationId: "club-b" }), club());
    expect(forged.status).toBe(400);
  });
});

describe("the system administrator's switch and the staff export (#610)", () => {
  it("turns a form on for a system administrator only", async () => {
    mocks.requireSystemAdministrator.mockResolvedValue({ id: "admin-1" });
    mocks.setClubFormTemplateEnabled.mockResolvedValue({ key: "off_premises_permission_slip", enabled: true });
    const response = await TOGGLE(json({ enabled: true }, "https://events.imsda.test/x", "PATCH"), { params: Promise.resolve({ templateKey: "off_premises_permission_slip" }) });
    expect(response.status).toBe(200);
    expect(mocks.setClubFormTemplateEnabled).toHaveBeenCalledWith("off_premises_permission_slip", true, "admin-1");

    mocks.requireSystemAdministrator.mockRejectedValue(new AccessDeniedError("System administrator access is required.", 403, "PERMISSION_DENIED"));
    const refused = await TOGGLE(json({ enabled: true }, "https://events.imsda.test/x", "PATCH"), { params: Promise.resolve({ templateKey: "off_premises_permission_slip" }) });
    expect(refused.status).toBe(403);
    expect(mocks.setClubFormTemplateEnabled).toHaveBeenCalledTimes(1);
  });

  it("downloads the CSV the export builds, uncached, and passes the filters through", async () => {
    mocks.requireStaffViewer.mockResolvedValue({ kind: "STAFF", userId: "staff-1", systemAdmin: false });
    mocks.buildClubFormsCsv.mockResolvedValue({ csv: "\"Form\"\r\n", filename: "form.csv", rowCount: 0 });
    const response = await EXPORT(new Request("https://events.imsda.test/api/staff/club-forms/export?form=off_premises_permission_slip&club=club-a"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/csv");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(mocks.buildClubFormsCsv).toHaveBeenCalledWith(expect.objectContaining({ kind: "STAFF" }), { templateKey: "off_premises_permission_slip", organizationId: "club-a" });
  });

  it("refuses the export to anyone who is not conference staff", async () => {
    mocks.requireStaffViewer.mockRejectedValue(new AccessDeniedError("Conference staff access is required.", 403, "PERMISSION_DENIED"));
    expect((await EXPORT(new Request("https://events.imsda.test/api/staff/club-forms/export?form=x"))).status).toBe(403);
    expect(mocks.buildClubFormsCsv).not.toHaveBeenCalled();
  });
});
