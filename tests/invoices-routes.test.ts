import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #167: who may do what. MANAGE_FINANCE on the event in the URL reads, drafts, revises and sets the
 * code; finalizing is passed the Finalize invoices permission (system administrators, or a granted
 * membership) and the service enforces it against the amounts; another event is refused before the
 * service is touched; only a system administrator changes who may finalize. The service is mocked
 * (rules: invoices-domain.test.ts; real database: scripts/verify-invoices.ts). Synthetic data only.
 */
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => { throw new Error("redirected"); }),
  notFound: vi.fn(() => { throw new Error("not-found"); }),
  useRouter: () => ({ refresh: vi.fn() }),
}));
const mocks = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  findActiveMembership: vi.fn(),
  listEventsForUser: vi.fn(),
  service: {
    createInvoiceDrafts: vi.fn(),
    discardInvoiceDraft: vi.fn(),
    regenerateInvoiceDraft: vi.fn(),
    reviseInvoice: vi.fn(),
    finalizeInvoiceVersion: vi.fn(),
    setEventInvoiceCode: vi.fn(),
    getInvoicesView: vi.fn(),
    getInvoiceDetail: vi.fn(),
  },
  grant: vi.fn(),
}));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/modules/events/repository", () => ({ findActiveMembership: mocks.findActiveMembership, listEventsForUser: mocks.listEventsForUser }));
vi.mock("@/lib/env", () => ({ getServerEnv: () => ({ APP_BASE_URL: "https://events.imsda.test" }), isServerEnvironmentError: () => false }));
vi.mock("@/modules/invoices/repository", async () => {
  class InvoiceError extends Error {
    constructor(message: string, public readonly code: string, public readonly blockers: unknown[] = []) { super(message); }
  }
  return { InvoiceError, ...mocks.service };
});
vi.mock("@/modules/invoices/finalize-access", () => {
  class InvoiceAccessGrantError extends Error {
    constructor(public readonly code: string, message: string) { super(message); }
  }
  return { InvoiceAccessGrantError, setInvoiceFinalizationAccess: mocks.grant };
});

import { POST } from "@/app/api/events/[eventId]/invoices/route";
import { PUT as grantPut } from "@/app/api/events/[eventId]/memberships/[membershipId]/invoice-finalization-access/route";
import InvoicesPage from "@/app/(workspace)/finance/invoices/page";
import InvoicePage from "@/app/(workspace)/finance/invoices/[invoiceId]/page";
import { InvoiceError } from "@/modules/invoices/repository";
import { InvoiceAccessGrantError } from "@/modules/invoices/finalize-access";

const KEY = "request-key-0123456789abcdef";
const context = (eventId = "event-a") => ({ params: Promise.resolve({ eventId }) });
const grantContext = (eventId = "event-a", membershipId = "m1") => ({ params: Promise.resolve({ eventId, membershipId }) });

function request(body: unknown, method = "POST", origin: string | null = "https://events.imsda.test") {
  return new Request("https://events.imsda.test/api/test", {
    method,
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  });
}

const financeManager = { id: "user-finance", globalRole: null, email: "finance@example.test", displayName: "Finance" };
const treasurer = { id: "user-treasurer", globalRole: null, email: "treasurer@example.test", displayName: "Treasurer" };
const admin = { id: "user-admin", globalRole: "SYSTEM_ADMIN", email: "admin@example.test", displayName: "Admin" };
const eventAdmin = { id: "user-event-admin", globalRole: null, email: "eventadmin@example.test", displayName: "Event Admin" };

/** Event A: finance manager (no grant), treasurer (finance manager with the grant), event admin. Event C: read-only. */
function memberships(userId: string, eventId: string) {
  if (eventId === "event-a" && userId === "user-finance") return { eventId, userId, role: "FINANCE_MANAGER", status: "ACTIVE", permissions: [] };
  if (eventId === "event-a" && userId === "user-treasurer") return { eventId, userId, role: "FINANCE_MANAGER", status: "ACTIVE", permissions: ["FINALIZE_INVOICES"] };
  if (eventId === "event-a" && userId === "user-event-admin") return { eventId, userId, role: "EVENT_ADMIN", status: "ACTIVE", permissions: [] };
  if (eventId === "event-c") return { eventId, userId, role: "READ_ONLY_STAFF", status: "ACTIVE", permissions: [] };
  return null;
}

let signedIn: Record<string, unknown> = financeManager;
beforeEach(() => {
  vi.clearAllMocks();
  signedIn = financeManager;
  mocks.getCurrentSession.mockImplementation(async () => ({ user: signedIn }));
  mocks.findActiveMembership.mockImplementation(async (userId: string, eventId: string) => memberships(userId, eventId));
  mocks.service.createInvoiceDrafts.mockResolvedValue({ created: 2, regenerated: 0, unchanged: 0, finalized: 0, needRevision: 0, reconciliationVersionNumber: 1 });
  mocks.service.regenerateInvoiceDraft.mockResolvedValue({ versionId: "v1", invoiceId: "i1" });
  mocks.service.discardInvoiceDraft.mockResolvedValue({ versionId: "v1", invoiceId: "i1" });
  mocks.service.reviseInvoice.mockResolvedValue({ versionId: "v2", invoiceId: "i1", revision: 1 });
  mocks.service.setEventInvoiceCode.mockResolvedValue({ changed: true, code: "SC" });
  mocks.service.finalizeInvoiceVersion.mockResolvedValue({ changed: true, versionId: "v1", invoiceId: "i1", number: "SC27-0001", revision: 0, amountDueCents: 5000 });
  mocks.grant.mockResolvedValue({ granted: true, changed: true });
});

const finalizeBody = { action: "finalize", versionId: "v1", idempotencyKey: KEY, confirm: true };

describe("POST /api/events/[eventId]/invoices", () => {
  it("lets a finance manager create drafts, regenerate, revise and set the code, as themselves", async () => {
    expect((await POST(request({ action: "create-drafts" }), context())).status).toBe(200);
    expect(mocks.service.createInvoiceDrafts).toHaveBeenCalledWith({ eventId: "event-a", actorUserId: "user-finance" });
    expect((await POST(request({ action: "regenerate", invoiceId: "i1", actorUserId: "someone-else" }), context())).status).toBe(200);
    expect(mocks.service.regenerateInvoiceDraft).toHaveBeenCalledWith({ eventId: "event-a", invoiceId: "i1", actorUserId: "user-finance" });
    expect((await POST(request({ action: "discard", invoiceId: "i1" }), context())).status).toBe(200);
    expect(mocks.service.discardInvoiceDraft).toHaveBeenCalledWith({ eventId: "event-a", invoiceId: "i1", actorUserId: "user-finance" });
    expect((await POST(request({ action: "revise", invoiceId: "i1", mode: "CONTACT_ONLY", reason: "New treasurer" }), context())).status).toBe(200);
    expect(mocks.service.reviseInvoice).toHaveBeenCalledWith({ eventId: "event-a", invoiceId: "i1", mode: "CONTACT_ONLY", reason: "New treasurer", actorUserId: "user-finance" });
    expect((await POST(request({ action: "set-code", code: "SC" }), context())).status).toBe(200);
    expect(mocks.service.setEventInvoiceCode).toHaveBeenCalledWith({ eventId: "event-a", code: "SC", actorUserId: "user-finance" });
  });

  it("MANAGE_FINANCE alone does not carry the Finalize invoices permission into finalization", async () => {
    expect((await POST(request(finalizeBody), context())).status).toBe(200);
    expect(mocks.service.finalizeInvoiceVersion).toHaveBeenCalledWith({ eventId: "event-a", versionId: "v1", actorUserId: "user-finance", idempotencyKey: KEY, confirm: true, canFinalizeInvoices: false });
  });

  it("an Event Admin does not have it either: the role does not include it", async () => {
    signedIn = eventAdmin;
    await POST(request(finalizeBody), context());
    expect(mocks.service.finalizeInvoiceVersion).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: "user-event-admin", canFinalizeInvoices: false }));
  });

  it("a granted staff member and a system administrator finalize with the permission", async () => {
    signedIn = treasurer;
    await POST(request(finalizeBody), context());
    expect(mocks.service.finalizeInvoiceVersion).toHaveBeenLastCalledWith(expect.objectContaining({ actorUserId: "user-treasurer", canFinalizeInvoices: true }));
    signedIn = admin;
    await POST(request(finalizeBody), context("event-z"));
    expect(mocks.service.finalizeInvoiceVersion).toHaveBeenLastCalledWith(expect.objectContaining({ actorUserId: "user-admin", eventId: "event-z", canFinalizeInvoices: true }));
  });

  it("refuses a member without MANAGE_FINANCE and an event the user is not assigned to (403), before the service", async () => {
    const bodies = [{ action: "create-drafts" }, { action: "regenerate", invoiceId: "i1" }, { action: "discard", invoiceId: "i1" }, { action: "revise", invoiceId: "i1", mode: "CONTACT_ONLY", reason: "x" }, { action: "set-code", code: "SC" }, finalizeBody];
    for (const body of bodies) {
      expect((await POST(request(body), context("event-c"))).status).toBe(403);
      expect((await POST(request(body), context("event-b"))).status).toBe(403);
    }
    expect(Object.values(mocks.service).every((fn) => fn.mock.calls.length === 0)).toBe(true);
  });

  it("requires a signed-in user and a same-origin request", async () => {
    signedIn = null as never;
    mocks.getCurrentSession.mockResolvedValueOnce({ user: null });
    expect((await POST(request({ action: "create-drafts" }), context())).status).toBe(401);
    expect((await POST(request({ action: "create-drafts" }, "POST", "https://evil.example.test"), context())).status).toBe(403);
    expect(mocks.service.createInvoiceDrafts).not.toHaveBeenCalled();
  });

  it("validates the body: finalizing needs a confirmation, revising a reason; there is no send action", async () => {
    expect((await POST(request({ action: "finalize", versionId: "v1", idempotencyKey: KEY }), context())).status).toBe(400);
    expect((await POST(request({ action: "finalize", versionId: "v1", idempotencyKey: KEY, confirm: false }), context())).status).toBe(400);
    expect((await POST(request({ action: "revise", invoiceId: "i1", mode: "CONTACT_ONLY", reason: " " }), context())).status).toBe(400);
    expect((await POST(request({ action: "send", invoiceId: "i1" }), context())).status).toBe(400);
    expect(mocks.service.finalizeInvoiceVersion).not.toHaveBeenCalled();
    expect(mocks.service.reviseInvoice).not.toHaveBeenCalled();
  });

  it("maps refusals: another event's invoice or version is 404, a missing permission 403, stale and blocked 409 with the reasons", async () => {
    mocks.service.finalizeInvoiceVersion.mockRejectedValueOnce(new InvoiceError("Not on this event.", "VERSION_NOT_FOUND"));
    expect((await POST(request(finalizeBody), context())).status).toBe(404);
    mocks.service.reviseInvoice.mockRejectedValueOnce(new InvoiceError("Not on this event.", "INVOICE_NOT_FOUND"));
    expect((await POST(request({ action: "revise", invoiceId: "i-other", mode: "CONTACT_ONLY", reason: "x" }), context())).status).toBe(404);
    mocks.service.finalizeInvoiceVersion.mockRejectedValueOnce(new InvoiceError("Needs the permission.", "FINALIZE_PERMISSION_REQUIRED"));
    expect((await POST(request(finalizeBody), context())).status).toBe(403);
    mocks.service.createInvoiceDrafts.mockRejectedValueOnce(new InvoiceError("Facts changed.", "FACTS_CHANGED"));
    expect((await POST(request({ action: "create-drafts" }), context())).status).toBe(409);
    mocks.service.createInvoiceDrafts.mockRejectedValueOnce(new InvoiceError("Finish billing responsibility first.", "RESPONSIBILITY_NOT_READY", [{ registrationId: "r1", confirmationCode: "C-1", label: "Club", reason: "UNRESOLVED" }]));
    const blocked = await POST(request({ action: "create-drafts" }), context());
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: "RESPONSIBILITY_NOT_READY", blockers: [{ registrationId: "r1" }] });
    mocks.service.finalizeInvoiceVersion.mockRejectedValueOnce(new InvoiceError("Draft stale.", "DRAFT_STALE"));
    expect((await POST(request(finalizeBody), context())).status).toBe(409);
    mocks.service.setEventInvoiceCode.mockRejectedValueOnce(new InvoiceError("Use letters.", "CODE_INVALID"));
    expect((await POST(request({ action: "set-code", code: "S1" }), context())).status).toBe(400);
  });
});

describe("PUT .../memberships/[membershipId]/invoice-finalization-access", () => {
  it("only a system administrator grants or revokes it, as themselves, and it is audited by the service", async () => {
    signedIn = admin;
    expect((await grantPut(request({ granted: true }, "PUT"), grantContext())).status).toBe(200);
    expect(mocks.grant).toHaveBeenCalledWith("event-a", "m1", "user-admin", true);
    expect((await grantPut(request({ granted: false }, "PUT"), grantContext())).status).toBe(200);
    expect(mocks.grant).toHaveBeenLastCalledWith("event-a", "m1", "user-admin", false);
  });

  it("refuses a finance manager, an Event Admin and the treasurer themselves, and anonymous or cross-origin requests", async () => {
    for (const user of [financeManager, eventAdmin, treasurer]) {
      signedIn = user;
      expect((await grantPut(request({ granted: true }, "PUT"), grantContext())).status).toBe(403);
    }
    mocks.getCurrentSession.mockResolvedValueOnce({ user: null });
    expect((await grantPut(request({ granted: true }, "PUT"), grantContext())).status).toBe(401);
    signedIn = admin;
    expect((await grantPut(request({ granted: true }, "PUT", "https://evil.example.test"), grantContext())).status).toBe(403);
    expect(mocks.grant).not.toHaveBeenCalled();
  });

  it("validates the body and maps the service's refusals", async () => {
    signedIn = admin;
    expect((await grantPut(request({ granted: "yes" }, "PUT"), grantContext())).status).toBe(400);
    mocks.grant.mockRejectedValueOnce(new InvoiceAccessGrantError("MEMBERSHIP_NOT_FOUND", "Gone."));
    expect((await grantPut(request({ granted: true }, "PUT"), grantContext())).status).toBe(404);
    mocks.grant.mockRejectedValueOnce(new InvoiceAccessGrantError("TARGET_IS_SYSTEM_ADMIN", "Already can."));
    expect((await grantPut(request({ granted: true }, "PUT"), grantContext())).status).toBe(400);
  });
});

describe("invoice pages", () => {
  const deferred = { id: "event-a", name: "Event A", billingMode: "DEFERRED_ORGANIZATION_INVOICE" };

  it("show the restricted notice and load nothing without MANAGE_FINANCE", async () => {
    mocks.listEventsForUser.mockResolvedValue([{ ...deferred, id: "event-c", name: "Event C" }]);
    const list = renderToStaticMarkup(await InvoicesPage({ searchParams: Promise.resolve({ event: "event-c" }) }));
    expect(list).toContain("Finance is restricted");
    const detail = renderToStaticMarkup(await InvoicePage({ params: Promise.resolve({ invoiceId: "i1" }), searchParams: Promise.resolve({ event: "event-c" }) }));
    expect(detail).toContain("Finance is restricted");
    expect(mocks.service.getInvoicesView).not.toHaveBeenCalled();
    expect(mocks.service.getInvoiceDetail).not.toHaveBeenCalled();
  });

  it("an invoice of another event is not found, and the lookup is scoped to the event in the URL", async () => {
    mocks.listEventsForUser.mockResolvedValue([deferred]);
    mocks.service.getInvoiceDetail.mockResolvedValue(null);
    await expect(InvoicePage({ params: Promise.resolve({ invoiceId: "i-other" }), searchParams: Promise.resolve({ event: "event-a" }) })).rejects.toThrow("not-found");
    expect(mocks.service.getInvoiceDetail).toHaveBeenCalledWith("event-a", "i-other", { versionId: null });
  });

  it("the list page loads the view for the event in the URL", async () => {
    mocks.listEventsForUser.mockResolvedValue([deferred]);
    mocks.service.getInvoicesView.mockResolvedValue({ isDeferred: false });
    signedIn = financeManager;
    const markup = renderToStaticMarkup(await InvoicesPage({ searchParams: Promise.resolve({ event: "event-a" }) }));
    expect(markup).toContain("This event is not billed to organizations");
    expect(mocks.service.getInvoicesView).toHaveBeenCalledWith("event-a");
  });
});
