import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The earned awards routes (#532): club routes behind the real roster gate
 * (directors and deputies edit; registrars and Area Coordinators only view),
 * event-patch links behind the real event permission check (CONFIGURE_EVENT),
 * and Master Award rule changes behind the real system administrator check.
 * Only the lookups underneath and the storage are stubbed.
 */
const mocks = vi.hoisted(() => ({
  getCurrentAttendee: vi.fn(),
  listDirectedClubs: vi.fn(),
  findEnrollment: vi.fn(),
  findSession: vi.fn(),
  countPasskeys: vi.fn(),
  findSettings: vi.fn(),
  findAreaGrant: vi.fn(),
  findOrganization: vi.fn(),
  getCurrentSession: vi.fn(),
  findMembership: vi.fn(),
  loadEarnedAwardsWorkspace: vi.fn(),
  recordAwardNeeds: vi.fn(),
  removeAwardNeeds: vi.fn(),
  recordClassCompletions: vi.fn(),
  confirmInsignia: vi.fn(),
  dismissInsignia: vi.fn(),
  confirmEventPatches: vi.fn(),
  addMasterAwardNeeds: vi.fn(),
  listEventAwardItems: vi.fn(),
  linkEventAwardItem: vi.fn(),
  unlinkEventAwardItem: vi.fn(),
  previewMasterAwardRulesImport: vi.fn(),
  applyMasterAwardRulesImport: vi.fn(),
  updateMasterAwardRule: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/attendee-accounts/sign-in-gate", () => ({ accountNeedsSecondStep: async () => "OK" }));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    attendeeMfaEnrollment: { findUnique: mocks.findEnrollment },
    attendeeSession: { findUnique: mocks.findSession },
    attendeePasskey: { count: mocks.countPasskeys },
    platformSettings: { findUnique: mocks.findSettings },
    areaCoordinatorGrant: { findUnique: mocks.findAreaGrant },
    organization: { findUnique: mocks.findOrganization },
  }),
}));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: mocks.getCurrentAttendee }));
vi.mock("@/modules/organizations/director-access", () => ({ listDirectedClubs: mocks.listDirectedClubs }));
vi.mock("@/modules/organizations/staff-act-as", () => ({ currentStaffActingContext: async () => null }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: () => null }));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/modules/events/repository", () => ({ findActiveMembership: mocks.findMembership }));
vi.mock("@/modules/earned-awards/order-source", () => ({
  loadEarnedAwardsWorkspace: mocks.loadEarnedAwardsWorkspace,
  recordAwardNeeds: mocks.recordAwardNeeds,
  removeAwardNeeds: mocks.removeAwardNeeds,
  recordClassCompletions: mocks.recordClassCompletions,
  confirmInsignia: mocks.confirmInsignia,
  dismissInsignia: mocks.dismissInsignia,
  confirmEventPatches: mocks.confirmEventPatches,
  addMasterAwardNeeds: mocks.addMasterAwardNeeds,
}));
vi.mock("@/modules/earned-awards/event-items", () => ({
  listEventAwardItems: mocks.listEventAwardItems,
  linkEventAwardItem: mocks.linkEventAwardItem,
  unlinkEventAwardItem: mocks.unlinkEventAwardItem,
}));
vi.mock("@/modules/earned-awards/rules-repository", () => ({
  previewMasterAwardRulesImport: mocks.previewMasterAwardRulesImport,
  applyMasterAwardRulesImport: mocks.applyMasterAwardRulesImport,
  updateMasterAwardRule: mocks.updateMasterAwardRule,
}));

import { GET, POST } from "@/app/api/attendee/clubs/[organizationId]/awards/route";
import { POST as POST_COMPLETIONS } from "@/app/api/attendee/clubs/[organizationId]/awards/completions/route";
import { POST as POST_CONFIRM_INSIGNIA } from "@/app/api/attendee/clubs/[organizationId]/awards/insignia/confirm/route";
import { POST as POST_DISMISS_INSIGNIA } from "@/app/api/attendee/clubs/[organizationId]/awards/insignia/dismiss/route";
import { POST as POST_MASTER } from "@/app/api/attendee/clubs/[organizationId]/awards/master/route";
import { POST as POST_CONFIRM_PATCHES } from "@/app/api/attendee/clubs/[organizationId]/awards/patches/confirm/route";
import { POST as POST_REMOVE } from "@/app/api/attendee/clubs/[organizationId]/awards/remove/route";
import { GET as EVENT_ITEMS_GET, POST as EVENT_ITEMS_POST } from "@/app/api/events/[eventId]/award-items/route";
import { DELETE as EVENT_ITEM_DELETE } from "@/app/api/events/[eventId]/award-items/[itemId]/route";
import { POST as RULES_IMPORT } from "@/app/api/admin/master-award-rules/import/route";
import { PATCH as RULE_PATCH } from "@/app/api/admin/master-award-rules/[ruleId]/route";
import { ClubOrderError } from "@/modules/club-orders/repository";
import { EarnedAwardError } from "@/modules/earned-awards/errors";

const clubFor = (organizationId: string, role: string) => ({ organizationId, name: "Test Pathfinders", role, sponsoringChurch: null });
const account = { id: "director-1", verifiedEmail: "director@example.test", displayName: "Test Director" };
const ctx = (organizationId = "club-1") => ({ params: Promise.resolve({ organizationId }) });
const getRequest = () => new Request("https://events.imsda.test/api/x");
const postRequest = (body: unknown, method = "POST") => new Request("https://events.imsda.test/api/x", {
  method,
  headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
  body: JSON.stringify(body),
});
const entry = { personIds: ["p1", "p2"], itemIds: ["good-conduct"] };

/** Every club write route with a valid body, so each role check covers all of them. */
const clubWrites: Array<[string, (request: Request, context: ReturnType<typeof ctx>) => Promise<Response>, unknown, () => unknown]> = [
  ["record by hand", POST, entry, () => mocks.recordAwardNeeds],
  ["remove", POST_REMOVE, { needIds: ["n1"] }, () => mocks.removeAwardNeeds],
  ["mark a class completed", POST_COMPLETIONS, { personIds: ["p1"], classLevel: "FRIEND", completedOn: "2026-06-06" }, () => mocks.recordClassCompletions],
  ["confirm insignia", POST_CONFIRM_INSIGNIA, { confirmations: [{ completionId: "c1", itemIds: ["strip"] }] }, () => mocks.confirmInsignia],
  ["skip insignia", POST_DISMISS_INSIGNIA, { completionIds: ["c1"] }, () => mocks.dismissInsignia],
  ["confirm event patches", POST_CONFIRM_PATCHES, { eventId: "e1", itemId: "patch", personIds: ["p1"] }, () => mocks.confirmEventPatches],
  ["add Master Awards", POST_MASTER, { ruleId: "r1", personIds: ["p1"] }, () => mocks.addMasterAwardNeeds],
];

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getCurrentAttendee.mockResolvedValue({ account, via: "attendee", sessionId: "session-1" });
  mocks.listDirectedClubs.mockResolvedValue([clubFor("club-1", "DIRECTOR")]);
  mocks.findEnrollment.mockResolvedValue({ status: "ACTIVE" });
  mocks.findSession.mockResolvedValue({ secondFactorVerifiedAt: new Date(Date.now() - 60_000) });
  mocks.countPasskeys.mockResolvedValue(0);
  mocks.findSettings.mockResolvedValue({ passkeyRpId: null });
  mocks.findAreaGrant.mockResolvedValue(null);
  mocks.findOrganization.mockResolvedValue({ type: "CLUB", isActive: true });
  mocks.loadEarnedAwardsWorkspace.mockResolvedValue({ catalog: [], members: [], needs: [], awardedCount: 0, insignia: [], patches: [], masterAwards: [] });
  for (const mock of [mocks.recordAwardNeeds, mocks.removeAwardNeeds, mocks.recordClassCompletions, mocks.confirmInsignia, mocks.dismissInsignia, mocks.confirmEventPatches, mocks.addMasterAwardNeeds]) {
    mock.mockResolvedValue({ created: 1, skipped: 0 });
  }
  mocks.getCurrentSession.mockResolvedValue({ user: { id: "staff-1", globalRole: null } });
  mocks.findMembership.mockResolvedValue({ eventId: "event-1", userId: "staff-1", role: "EVENT_ADMIN", status: "ACTIVE", permissions: [] });
  mocks.listEventAwardItems.mockResolvedValue({ isClubEvent: true, linked: [], choices: [] });
  mocks.linkEventAwardItem.mockResolvedValue({ isClubEvent: true, linked: [], choices: [] });
  mocks.unlinkEventAwardItem.mockResolvedValue({ isClubEvent: true, linked: [], choices: [] });
  mocks.updateMasterAwardRule.mockResolvedValue([]);
});

describe("club earned awards routes (#532)", () => {
  it.each(["DIRECTOR", "DEPUTY"])("a %s can load the workspace and use every write route", async (role) => {
    mocks.listDirectedClubs.mockResolvedValue([clubFor("club-1", role)]);
    const read = await GET(getRequest(), ctx());
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ canEdit: true });
    expect(mocks.loadEarnedAwardsWorkspace).toHaveBeenCalledWith("club-1", { forEditing: true });
    for (const [label, handler, body, storage] of clubWrites) {
      const response = await handler(postRequest(body), ctx());
      expect(response.status, label).toBe(200);
      expect(storage(), label).toHaveBeenCalledTimes(1);
    }
    expect(mocks.recordAwardNeeds).toHaveBeenCalledWith("club-1", { ...entry, alreadyHasIt: false }, { accountId: "director-1" });
    expect(mocks.confirmInsignia).toHaveBeenCalledWith("club-1", [{ completionId: "c1", itemIds: ["strip"] }], { accountId: "director-1" });
  });

  it("passes 'already has it' through", async () => {
    await POST(postRequest({ ...entry, alreadyHasIt: true }), ctx());
    expect(mocks.recordAwardNeeds).toHaveBeenCalledWith("club-1", { ...entry, alreadyHasIt: true }, { accountId: "director-1" });
  });

  it("a registrar views read-only and never writes", async () => {
    mocks.listDirectedClubs.mockResolvedValue([clubFor("club-1", "REGISTRAR")]);
    const read = await GET(getRequest(), ctx());
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ canEdit: false });
    expect(mocks.loadEarnedAwardsWorkspace).toHaveBeenCalledWith("club-1", { forEditing: false });
    for (const [label, handler, body, storage] of clubWrites) {
      expect((await handler(postRequest(body), ctx())).status, label).toBe(403);
      expect(storage(), label).not.toHaveBeenCalled();
    }
  });

  it("an Area Coordinator views read-only and can't write", async () => {
    mocks.listDirectedClubs.mockResolvedValue([]);
    mocks.findAreaGrant.mockResolvedValue({ revokedAt: null, expiresAt: null });
    const read = await GET(getRequest(), ctx());
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ canEdit: false });
    expect(mocks.loadEarnedAwardsWorkspace).toHaveBeenCalledWith("club-1", { forEditing: false });
    for (const [label, handler, body, storage] of clubWrites) {
      expect((await handler(postRequest(body), ctx())).status, label).toBe(404);
      expect(storage(), label).not.toHaveBeenCalled();
    }
  });

  it("another club's director gets 404 and nothing runs", async () => {
    expect((await GET(getRequest(), ctx("club-2"))).status).toBe(404);
    for (const [label, handler, body, storage] of clubWrites) {
      expect((await handler(postRequest(body), ctx("club-2"))).status, label).toBe(404);
      expect(storage(), label).not.toHaveBeenCalled();
    }
    expect(mocks.loadEarnedAwardsWorkspace).not.toHaveBeenCalled();
  });

  it("refuses malformed bodies with 400 before touching storage", async () => {
    expect((await POST(postRequest({ personIds: [], itemIds: ["x"] }), ctx())).status).toBe(400);
    expect((await POST(postRequest({ ...entry, organizationId: "club-2" }), ctx())).status).toBe(400);
    expect((await POST_COMPLETIONS(postRequest({ personIds: ["p1"], classLevel: "WIZARD", completedOn: "2026-06-06" }), ctx())).status).toBe(400);
    expect((await POST_COMPLETIONS(postRequest({ personIds: ["p1"], classLevel: "FRIEND", completedOn: "2026-13-45" }), ctx())).status).toBe(400);
    expect((await POST_CONFIRM_INSIGNIA(postRequest({ confirmations: [] }), ctx())).status).toBe(400);
    expect((await POST_CONFIRM_INSIGNIA(postRequest({ confirmations: [{ completionId: "c1", itemIds: ["a"] }, { completionId: "c1", itemIds: ["b"] }] }), ctx())).status).toBe(400);
    expect((await POST_CONFIRM_PATCHES(postRequest({ eventId: "e1", itemId: "p", personIds: [] }), ctx())).status).toBe(400);
    expect((await POST_MASTER(postRequest({ ruleId: "r1", personIds: [] }), ctx())).status).toBe(400);
    expect((await POST_REMOVE(postRequest({ needIds: [] }), ctx())).status).toBe(400);
    for (const [, , , storage] of clubWrites) expect(storage()).not.toHaveBeenCalled();
  });

  it("maps refused suggestions and eligibility to 409", async () => {
    mocks.confirmEventPatches.mockRejectedValueOnce(new ClubOrderError("NOT_SUGGESTED", "Only members who attended."));
    const patch = await POST_CONFIRM_PATCHES(postRequest({ eventId: "e1", itemId: "patch", personIds: ["p9"] }), ctx());
    expect(patch.status).toBe(409);
    expect(await patch.json()).toMatchObject({ error: "NOT_SUGGESTED" });
    mocks.addMasterAwardNeeds.mockRejectedValueOnce(new ClubOrderError("NOT_ELIGIBLE", "Not yet."));
    expect((await POST_MASTER(postRequest({ ruleId: "r1", personIds: ["p1"] }), ctx())).status).toBe(409);
    mocks.recordAwardNeeds.mockRejectedValueOnce(new ClubOrderError("ITEM_NOT_ORDERABLE", "Not an earned-award item."));
    expect((await POST(postRequest(entry), ctx())).status).toBe(409);
  });
});

describe("event patch link routes (#532)", () => {
  const ctxEvent = { params: Promise.resolve({ eventId: "event-1" }) };
  const ctxItem = { params: Promise.resolve({ eventId: "event-1", itemId: "patch" }) };

  it("event administrators (CONFIGURE_EVENT) list, link and unlink, attributed to them", async () => {
    expect((await EVENT_ITEMS_GET(getRequest(), ctxEvent)).status).toBe(200);
    expect((await EVENT_ITEMS_POST(postRequest({ itemId: "patch" }), ctxEvent)).status).toBe(201);
    expect(mocks.linkEventAwardItem).toHaveBeenCalledWith("event-1", "patch", "staff-1");
    expect((await EVENT_ITEM_DELETE(postRequest({}, "DELETE"), ctxItem)).status).toBe(200);
    expect(mocks.unlinkEventAwardItem).toHaveBeenCalledWith("event-1", "patch", "staff-1");
  });

  it("staff without CONFIGURE_EVENT can neither read nor change the links", async () => {
    mocks.findMembership.mockResolvedValue({ eventId: "event-1", userId: "staff-1", role: "READ_ONLY_STAFF", status: "ACTIVE", permissions: [] });
    expect((await EVENT_ITEMS_GET(getRequest(), ctxEvent)).status).toBe(403);
    expect((await EVENT_ITEMS_POST(postRequest({ itemId: "patch" }), ctxEvent)).status).toBe(403);
    expect((await EVENT_ITEM_DELETE(postRequest({}, "DELETE"), ctxItem)).status).toBe(403);
    expect(mocks.linkEventAwardItem).not.toHaveBeenCalled();
    expect(mocks.unlinkEventAwardItem).not.toHaveBeenCalled();
  });

  it("a signed-out visitor gets 401, and a bad body 400", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: null });
    expect((await EVENT_ITEMS_POST(postRequest({ itemId: "patch" }), ctxEvent)).status).toBe(401);
    mocks.getCurrentSession.mockResolvedValue({ user: { id: "staff-1", globalRole: null } });
    expect((await EVENT_ITEMS_POST(postRequest({ item: "patch" }), ctxEvent)).status).toBe(400);
  });

  it("maps a non-club event to 409", async () => {
    mocks.linkEventAwardItem.mockRejectedValueOnce(new EarnedAwardError("NOT_A_CLUB_EVENT", "Club events only."));
    const response = await EVENT_ITEMS_POST(postRequest({ itemId: "patch" }), ctxEvent);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "NOT_A_CLUB_EVENT" });
  });
});

describe("Master Award rule routes are staff-only (#532)", () => {
  const admin = { id: "admin-1", globalRole: "SYSTEM_ADMIN" };
  const ruleCtx = { params: Promise.resolve({ ruleId: "rule-1" }) };
  const file = JSON.stringify({ "Health Master Award": { groups: [{ minimum: 3, honors: ["First Aid", "Nutrition", "Swimming"] }], groupsRequired: 1 } });
  const plan = { steps: [], summary: { added: 1, existing: 0, needsManualCheck: 0, honorsMatched: 3, honorsUnmatched: 0 }, unmatched: [] };

  beforeEach(() => {
    mocks.previewMasterAwardRulesImport.mockResolvedValue({ plan, fingerprint: "f".repeat(64) });
    mocks.applyMasterAwardRulesImport.mockResolvedValue({ plan, rules: [] });
  });

  it("a system administrator previews (saving nothing), confirms with the fingerprint, and edits a rule", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: admin });
    const preview = await RULES_IMPORT(postRequest({ json: file }));
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ fingerprint: "f".repeat(64), summary: { added: 1 } });
    expect(mocks.applyMasterAwardRulesImport).not.toHaveBeenCalled();
    const saved = await RULES_IMPORT(postRequest({ json: file, confirm: true, fingerprint: "f".repeat(64) }));
    expect(saved.status).toBe(200);
    expect(mocks.applyMasterAwardRulesImport).toHaveBeenCalledWith(expect.any(Array), "f".repeat(64), "admin-1");
    const edit = await RULE_PATCH(postRequest({ status: "ACTIVE", needsManualCheck: false }, "PATCH"), ruleCtx);
    expect(edit.status).toBe(200);
    expect(mocks.updateMasterAwardRule).toHaveBeenCalledWith("rule-1", { status: "ACTIVE", needsManualCheck: false }, "admin-1");
  });

  it("an event administrator, a club director, and a signed-out visitor can't import or change a rule", async () => {
    for (const session of [{ user: { id: "staff-1", globalRole: null } }, { user: null }]) {
      mocks.getCurrentSession.mockResolvedValue(session);
      const importResponse = await RULES_IMPORT(postRequest({ json: file, confirm: true, fingerprint: "f".repeat(64) }));
      expect(importResponse.status).toBe(session.user ? 403 : 401);
      const patchResponse = await RULE_PATCH(postRequest({ status: "ACTIVE" }, "PATCH"), ruleCtx);
      expect(patchResponse.status).toBe(session.user ? 403 : 401);
    }
    // A club director has no staff session at all: the attendee account is not a staff user.
    expect(mocks.previewMasterAwardRulesImport).not.toHaveBeenCalled();
    expect(mocks.applyMasterAwardRulesImport).not.toHaveBeenCalled();
    expect(mocks.updateMasterAwardRule).not.toHaveBeenCalled();
  });

  it("refuses a confirm without a fingerprint, a stale preview, a bad file, and an empty edit", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: admin });
    const missing = await RULES_IMPORT(postRequest({ json: file, confirm: true }));
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({ error: "PREVIEW_CHANGED" });
    mocks.applyMasterAwardRulesImport.mockRejectedValueOnce(new EarnedAwardError("PREVIEW_CHANGED", "Changed."));
    expect((await RULES_IMPORT(postRequest({ json: file, confirm: true, fingerprint: "0".repeat(64) }))).status).toBe(409);
    const bad = await RULES_IMPORT(postRequest({ json: "not json" }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "INVALID_MASTER_AWARD_RULES_FILE" });
    expect((await RULES_IMPORT(postRequest({ json: JSON.stringify({ X: { groups: [], groupsRequired: 1 } }) }))).status).toBe(400);
    expect((await RULE_PATCH(postRequest({}, "PATCH"), ruleCtx)).status).toBe(400);
    expect((await RULE_PATCH(postRequest({ groups: [{ minimum: 0, honorIds: ["h1"] }] }, "PATCH"), ruleCtx)).status).toBe(400);
    expect(mocks.updateMasterAwardRule).not.toHaveBeenCalled();
  });

  it("answers an unready rule with 409 and a missing rule with 404", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: admin });
    mocks.updateMasterAwardRule.mockRejectedValueOnce(new EarnedAwardError("RULE_NOT_READY", "Check this rule first."));
    const unready = await RULE_PATCH(postRequest({ status: "ACTIVE" }, "PATCH"), ruleCtx);
    expect(unready.status).toBe(409);
    expect(await unready.json()).toMatchObject({ error: "RULE_NOT_READY" });
    mocks.updateMasterAwardRule.mockRejectedValueOnce(new EarnedAwardError("RULE_NOT_FOUND", "Missing."));
    expect((await RULE_PATCH(postRequest({ status: "ACTIVE" }, "PATCH"), ruleCtx)).status).toBe(404);
  });
});
