import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #165: only MANAGE_FINANCE on the event in the URL may read or change billing responsibility,
 * contacts and grouping; another event is refused; the page shows the restricted notice and
 * loads nothing. The service is mocked here (rules: billing-responsibility-service.test.ts).
 * Synthetic data only.
 */
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: vi.fn(() => { throw new Error("redirected"); }) }));
const mocks = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  findActiveMembership: vi.fn(),
  listEventsForUser: vi.fn(),
  service: {
    resolveEventBillingResponsibility: vi.fn(),
    setInvoiceGrouping: vi.fn(),
    linkRegistrationToOrganization: vi.fn(),
    clearResponsibilityOverride: vi.fn(),
    setOrganizationBillingContact: vi.fn(),
    verifyOrganizationBillingContact: vi.fn(),
    endOrganizationBillingContact: vi.fn(),
    searchResponsibleOrganizations: vi.fn(),
    getBillingResponsibilityExport: vi.fn(),
    getBillingResponsibilityView: vi.fn(),
  },
}));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/modules/events/repository", () => ({ findActiveMembership: mocks.findActiveMembership, listEventsForUser: mocks.listEventsForUser }));
vi.mock("@/lib/env", () => ({ getServerEnv: () => ({ APP_BASE_URL: "https://events.imsda.test" }), isServerEnvironmentError: () => false }));
vi.mock("@/modules/event-locations/filter", () => ({
  resolveLocationFilter: vi.fn(async () => ({ locations: [], locationId: null, selected: null })),
  locationParam: () => null,
}));
vi.mock("@/modules/billing-responsibility/repository", async () => {
  class BillingResponsibilityError extends Error {
    constructor(message: string, public readonly code: string) { super(message); }
  }
  return { BillingResponsibilityError, ...mocks.service };
});

import { POST } from "@/app/api/events/[eventId]/billing-responsibility/route";
import { GET as searchGet } from "@/app/api/events/[eventId]/billing-responsibility/organizations/route";
import { GET as exportGet } from "@/app/api/events/[eventId]/exports/billing-responsibility/route";
import BillingResponsibilityPage from "@/app/(workspace)/finance/billing-responsibility/page";
import { BillingResponsibilityError } from "@/modules/billing-responsibility/repository";

const finance = { id: "user-finance", globalRole: null, email: "finance@example.test", displayName: "Finance" };
const context = (eventId = "event-a") => ({ params: Promise.resolve({ eventId }) });

function post(body: unknown, origin: string | null = "https://events.imsda.test") {
  return new Request("https://events.imsda.test/api/test", {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  });
}

/** Finance manager on event A only; a read-only member on event C. */
function memberships(userId: string, eventId: string) {
  if (eventId === "event-a") return { eventId, userId, role: "FINANCE_MANAGER", status: "ACTIVE", permissions: [] };
  if (eventId === "event-c") return { eventId, userId, role: "READ_ONLY_STAFF", status: "ACTIVE", permissions: [] };
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentSession.mockResolvedValue({ user: finance });
  mocks.findActiveMembership.mockImplementation(async (userId: string, eventId: string) => memberships(userId, eventId));
  mocks.service.setInvoiceGrouping.mockResolvedValue({ changed: true });
  mocks.service.setOrganizationBillingContact.mockResolvedValue({ id: "contact-1", replaced: false });
  mocks.service.searchResponsibleOrganizations.mockResolvedValue([]);
  mocks.service.getBillingResponsibilityExport.mockResolvedValue({ groups: [], invoiceGrouping: "PER_CHURCH" });
});

describe("POST /api/events/[eventId]/billing-responsibility", () => {
  it("lets a finance manager change the grouping for their event, as themselves", async () => {
    const response = await POST(post({ action: "set-grouping", invoiceGrouping: "PER_CLUB" }), context());
    expect(response.status).toBe(200);
    expect(mocks.service.setInvoiceGrouping).toHaveBeenCalledWith({ eventId: "event-a", invoiceGrouping: "PER_CLUB", actorUserId: "user-finance" });
  });

  it("refuses a member without MANAGE_FINANCE and an event the user is not assigned to, before touching the service", async () => {
    expect((await POST(post({ action: "set-grouping", invoiceGrouping: "PER_CLUB" }), context("event-c"))).status).toBe(403);
    expect((await POST(post({ action: "set-grouping", invoiceGrouping: "PER_CLUB" }), context("event-b"))).status).toBe(403);
    expect(Object.values(mocks.service).every((fn) => fn.mock.calls.length === 0)).toBe(true);
  });

  it("requires a signed-in user and a same-origin request", async () => {
    mocks.getCurrentSession.mockResolvedValueOnce({ user: null });
    expect((await POST(post({ action: "resolve" }), context())).status).toBe(401);
    expect((await POST(post({ action: "resolve" }, "https://evil.example.test"), context())).status).toBe(403);
    expect(mocks.service.resolveEventBillingResponsibility).not.toHaveBeenCalled();
  });

  it("validates the body: unknown actions, bad groupings and malformed contacts are 400", async () => {
    expect((await POST(post({ action: "delete-everything" }), context())).status).toBe(400);
    expect((await POST(post({ action: "set-grouping", invoiceGrouping: "PER_PLANET" }), context())).status).toBe(400);
    expect((await POST(post({ action: "set-contact", organizationId: "org-1", contact: { name: "T", email: "not-an-email", roleLabel: "Treasurer" } }), context())).status).toBe(400);
    expect(mocks.service.setOrganizationBillingContact).not.toHaveBeenCalled();
  });

  it("normalizes contact input and never reads the actor from the body", async () => {
    await POST(post({ action: "set-contact", organizationId: "org-1", actorUserId: "someone-else", contact: { name: " Terry ", email: " T@Example.TEST ", roleLabel: "Treasurer", phone: "" } }), context());
    expect(mocks.service.setOrganizationBillingContact).toHaveBeenCalledWith({
      eventId: "event-a", organizationId: "org-1", actorUserId: "user-finance",
      contact: { name: "Terry", email: "t@example.test", roleLabel: "Treasurer", phone: null },
    });
  });

  it("maps service refusals to client errors", async () => {
    mocks.service.linkRegistrationToOrganization.mockRejectedValueOnce(new BillingResponsibilityError("Not on this event.", "REGISTRATION_NOT_FOUND"));
    expect((await POST(post({ action: "link", registrationId: "r-other", organizationId: "org-1" }), context())).status).toBe(404);
    mocks.service.linkRegistrationToOrganization.mockRejectedValueOnce(new BillingResponsibilityError("Why?", "REASON_REQUIRED"));
    expect((await POST(post({ action: "link", registrationId: "r-1", organizationId: "org-1" }), context())).status).toBe(400);
  });
});

describe("billing responsibility reads", () => {
  it("search and CSV export are MANAGE_FINANCE on the event only", async () => {
    const searchRequest = new Request("https://events.imsda.test/api/x?q=alpha");
    expect((await searchGet(searchRequest, context())).status).toBe(200);
    expect((await searchGet(searchRequest, context("event-c"))).status).toBe(403);
    expect((await searchGet(searchRequest, context("event-b"))).status).toBe(403);
    expect(mocks.service.searchResponsibleOrganizations).toHaveBeenCalledTimes(1);

    const exported = await exportGet(new Request("https://events.imsda.test/api/x"), context());
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-type")).toContain("text/csv");
    expect((await exportGet(new Request("https://events.imsda.test/api/x"), context("event-c"))).status).toBe(403);
    expect((await exportGet(new Request("https://events.imsda.test/api/x"), context("event-b"))).status).toBe(403);
    expect(mocks.service.getBillingResponsibilityExport).toHaveBeenCalledTimes(1);
  });

  it("the page shows the restricted notice and loads nothing without MANAGE_FINANCE", async () => {
    mocks.listEventsForUser.mockResolvedValue([{ id: "event-c", name: "Event C", billingMode: "DEFERRED_ORGANIZATION_INVOICE" }]);
    const markup = renderToStaticMarkup(await BillingResponsibilityPage({ searchParams: Promise.resolve({ event: "event-c" }) }));
    expect(markup).toContain("Finance is restricted");
    expect(mocks.service.getBillingResponsibilityView).not.toHaveBeenCalled();
  });
});
