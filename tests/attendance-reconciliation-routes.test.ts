import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #166: only MANAGE_FINANCE on the event in the URL may read, correct, prepare or approve; another
 * event is refused before the service is touched; the page shows the restricted notice and loads
 * nothing. The service is mocked here (rules: attendance-reconciliation-service.test.ts).
 * Synthetic data only.
 */
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: vi.fn(() => { throw new Error("redirected"); }), useRouter: () => ({ refresh: vi.fn() }) }));
const mocks = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  findActiveMembership: vi.fn(),
  listEventsForUser: vi.fn(),
  service: {
    prepareReconciliation: vi.fn(),
    approveReconciliation: vi.fn(),
    recordAttendanceCorrection: vi.fn(),
    acknowledgeRosterReview: vi.fn(),
    getAttendanceReconciliationView: vi.fn(),
    getAttendanceReconciliationExport: vi.fn(),
  },
}));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/modules/events/repository", () => ({ findActiveMembership: mocks.findActiveMembership, listEventsForUser: mocks.listEventsForUser }));
vi.mock("@/lib/env", () => ({ getServerEnv: () => ({ APP_BASE_URL: "https://events.imsda.test" }), isServerEnvironmentError: () => false }));
vi.mock("@/modules/event-locations/filter", () => ({
  resolveLocationFilter: vi.fn(async () => ({ locations: [], locationId: null, selected: null })),
  locationParam: () => null,
}));
vi.mock("@/modules/attendance-reconciliation/repository", async () => {
  class AttendanceReconciliationError extends Error {
    constructor(message: string, public readonly code: string, public readonly blockers: unknown[] = []) { super(message); }
  }
  return { AttendanceReconciliationError, ...mocks.service };
});

import { POST } from "@/app/api/events/[eventId]/attendance-reconciliation/route";
import { GET as exportGet } from "@/app/api/events/[eventId]/exports/attendance-reconciliation/route";
import AttendanceReconciliationPage from "@/app/(workspace)/finance/attendance-reconciliation/page";
import { AttendanceReconciliationError } from "@/modules/attendance-reconciliation/repository";
import { reconcileEvent } from "@/modules/attendance-reconciliation/domain";

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
  mocks.service.prepareReconciliation.mockResolvedValue({ created: true, versionId: "v1", versionNumber: 1, status: "DRAFT" });
  mocks.service.approveReconciliation.mockResolvedValue({ changed: true, versionId: "v1", versionNumber: 1 });
  mocks.service.recordAttendanceCorrection.mockResolvedValue({ correctionId: "c1" });
});

describe("POST /api/events/[eventId]/attendance-reconciliation", () => {
  it("lets a finance manager prepare, approve and correct for their event, as themselves", async () => {
    expect((await POST(post({ action: "prepare" }), context())).status).toBe(200);
    expect(mocks.service.prepareReconciliation).toHaveBeenCalledWith({ eventId: "event-a", actorUserId: "user-finance" });
    expect((await POST(post({ action: "approve", versionId: "v1", actorUserId: "someone-else" }), context())).status).toBe(200);
    expect(mocks.service.approveReconciliation).toHaveBeenCalledWith({ eventId: "event-a", versionId: "v1", actorUserId: "user-finance" });
    expect((await POST(post({ action: "correct", attendeeId: "att-1", kind: "MARK_ATTENDED", reason: "Missed at the desk" }), context())).status).toBe(200);
    expect(mocks.service.recordAttendanceCorrection).toHaveBeenCalledWith({ eventId: "event-a", attendeeId: "att-1", kind: "MARK_ATTENDED", reason: "Missed at the desk", actorUserId: "user-finance" });
  });

  it("refuses a member without MANAGE_FINANCE and an event the user is not assigned to (403), before the service", async () => {
    const bodies = [
      { action: "prepare" },
      { action: "approve", versionId: "v1" },
      { action: "correct", attendeeId: "att-1", kind: "MARK_ATTENDED", reason: "x" },
    ];
    for (const body of bodies) {
      expect((await POST(post(body), context("event-c"))).status).toBe(403);
      expect((await POST(post(body), context("event-b"))).status).toBe(403);
    }
    expect(Object.values(mocks.service).every((fn) => fn.mock.calls.length === 0)).toBe(true);
  });

  it("requires a signed-in user and a same-origin request", async () => {
    mocks.getCurrentSession.mockResolvedValueOnce({ user: null });
    expect((await POST(post({ action: "prepare" }), context())).status).toBe(401);
    expect((await POST(post({ action: "prepare" }, "https://evil.example.test"), context())).status).toBe(403);
    expect(mocks.service.prepareReconciliation).not.toHaveBeenCalled();
  });

  it("acknowledging a roster review needs a reason, MANAGE_FINANCE on the event, and acts as the signed-in user", async () => {
    mocks.service.acknowledgeRosterReview.mockResolvedValue({ changed: true, acknowledgementId: "ack-1" });
    expect((await POST(post({ action: "acknowledge", registrationId: "r1", choice: "PRORATED", reason: "Accept the prorated figure" }), context())).status).toBe(200);
    expect(mocks.service.acknowledgeRosterReview).toHaveBeenCalledWith({ eventId: "event-a", registrationId: "r1", choice: "PRORATED", reason: "Accept the prorated figure", actorUserId: "user-finance" });
    expect((await POST(post({ action: "acknowledge", registrationId: "r1", choice: "PRORATED", reason: " " }), context())).status).toBe(400);
    expect((await POST(post({ action: "acknowledge", registrationId: "r1", choice: "PRORATED", reason: "x" }), context("event-c"))).status).toBe(403);
    expect((await POST(post({ action: "acknowledge", registrationId: "r1", choice: "PRORATED", reason: "x" }), context("event-b"))).status).toBe(403);
    expect(mocks.service.acknowledgeRosterReview).toHaveBeenCalledTimes(1);
  });

  it("requires a reason for every correction, and validates the body", async () => {
    expect((await POST(post({ action: "correct", attendeeId: "att-1", kind: "MARK_ATTENDED" }), context())).status).toBe(400);
    expect((await POST(post({ action: "correct", attendeeId: "att-1", kind: "MARK_ATTENDED", reason: "   " }), context())).status).toBe(400);
    expect((await POST(post({ action: "correct", attendeeId: "att-1", kind: "DELETE_IT", reason: "x" }), context())).status).toBe(400);
    expect((await POST(post({ action: "finalize" }), context())).status).toBe(400);
    expect((await POST(post({ action: "send" }), context())).status).toBe(400);
    expect(mocks.service.recordAttendanceCorrection).not.toHaveBeenCalled();
  });

  it("maps refusals: another event's person or version is 404, blocked and stale are 409 with the reasons", async () => {
    mocks.service.recordAttendanceCorrection.mockRejectedValueOnce(new AttendanceReconciliationError("Not on this event.", "ATTENDEE_NOT_FOUND"));
    expect((await POST(post({ action: "correct", attendeeId: "att-other", kind: "MARK_ATTENDED", reason: "x" }), context())).status).toBe(404);
    mocks.service.approveReconciliation.mockRejectedValueOnce(new AttendanceReconciliationError("Not on this event.", "VERSION_NOT_FOUND"));
    expect((await POST(post({ action: "approve", versionId: "v-other" }), context())).status).toBe(404);
    mocks.service.prepareReconciliation.mockRejectedValueOnce(new AttendanceReconciliationError("Finish billing responsibility first.", "RESPONSIBILITY_NOT_READY", [{ registrationId: "r1", confirmationCode: "C-1", label: "Club", reason: "UNRESOLVED" }]));
    const blocked = await POST(post({ action: "prepare" }), context());
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: "RESPONSIBILITY_NOT_READY", blockers: [{ registrationId: "r1" }] });
    mocks.service.approveReconciliation.mockRejectedValueOnce(new AttendanceReconciliationError("Facts changed.", "FACTS_CHANGED"));
    expect((await POST(post({ action: "approve", versionId: "v1" }), context())).status).toBe(409);
  });
});

describe("attendance reconciliation reads", () => {
  it("the CSV export is MANAGE_FINANCE on the event only, and formula-safe", async () => {
    const result = reconcileEvent([{
      key: "g", title: "=SUM(1+1)", partyKind: "ORGANIZATION", partyId: "o", partyName: "Church", clubId: null,
      registrations: [{
        registrationId: "r1", confirmationCode: "C-1", status: "CONFIRMED", label: "+Club", clubId: null, locationId: null, locationName: null,
        estimatedCents: 2500, people: [], registrationCharges: [], credits: [], promo: null, review: null, registrationAdjustmentCents: 0, hasPriceLines: true,
      }],
    }], "PER_CHURCH");
    mocks.service.getAttendanceReconciliationExport.mockResolvedValue({ result, versionLabel: "Current facts (not saved)", factsChanged: null });
    const exported = await exportGet(new Request("https://events.imsda.test/api/x"), context());
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-type")).toContain("text/csv");
    const text = await exported.text();
    expect(text).toContain("\"'=SUM(1+1)\"");
    expect(text).toContain("\"'+Club\"");
    expect((await exportGet(new Request("https://events.imsda.test/api/x"), context("event-c"))).status).toBe(403);
    expect((await exportGet(new Request("https://events.imsda.test/api/x"), context("event-b"))).status).toBe(403);
    expect(mocks.service.getAttendanceReconciliationExport).toHaveBeenCalledTimes(1);
  });

  it("the page shows the restricted notice and loads nothing without MANAGE_FINANCE", async () => {
    mocks.listEventsForUser.mockResolvedValue([{ id: "event-c", name: "Event C", billingMode: "DEFERRED_ORGANIZATION_INVOICE" }]);
    const markup = renderToStaticMarkup(await AttendanceReconciliationPage({ searchParams: Promise.resolve({ event: "event-c" }) }));
    expect(markup).toContain("Finance is restricted");
    expect(mocks.service.getAttendanceReconciliationView).not.toHaveBeenCalled();
  });
});
