import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #131: only MANAGE_REGISTRATION on the event in the URL may set, change, revoke or close a claim; another
 * event is refused before the service is touched; a missing person or review item is a 404; the page shows
 * the restricted notice and loads nothing; the CSV is formula-safe. The service is mocked here (rules:
 * guardian-authority-service.test.ts). Synthetic data only.
 */
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: vi.fn(() => { throw new Error("redirected"); }), useRouter: () => ({ refresh: vi.fn() }) }));
const mocks = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  findActiveMembership: vi.fn(),
  listEventsForUser: vi.fn(),
  service: {
    setResponsibleAdult: vi.fn(),
    revokeResponsibleAdult: vi.fn(),
    dismissConflict: vi.fn(),
    getGuardianReview: vi.fn(),
    getResponsibleAdultExportRows: vi.fn(),
  },
}));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/modules/events/repository", () => ({ findActiveMembership: mocks.findActiveMembership, listEventsForUser: mocks.listEventsForUser }));
vi.mock("@/lib/env", () => ({ getServerEnv: () => ({ APP_BASE_URL: "https://events.imsda.test" }), isServerEnvironmentError: () => false }));
vi.mock("@/modules/guardian-authority/repository", async () => {
  class GuardianAuthorityError extends Error {
    constructor(message: string, public readonly code: string) { super(message); }
  }
  return { GuardianAuthorityError, ...mocks.service };
});

import { POST } from "@/app/api/events/[eventId]/guardian-authority/route";
import { GET as exportGet } from "@/app/api/events/[eventId]/exports/responsible-adults/route";
import ResponsibleAdultsPage from "@/app/(workspace)/people/responsible-adults/page";
import { GuardianAuthorityError } from "@/modules/guardian-authority/repository";

const manager = { id: "user-manager", globalRole: null, email: "manager@example.test", displayName: "Manager" };
const context = (eventId = "event-a") => ({ params: Promise.resolve({ eventId }) });

function post(body: unknown, origin: string | null = "https://events.imsda.test") {
  return new Request("https://events.imsda.test/api/test", {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  });
}

/** Registration manager on event A; finance manager on event C (not MANAGE_REGISTRATION); nothing on event B. */
function memberships(userId: string, eventId: string) {
  if (eventId === "event-a") return { eventId, userId, role: "REGISTRATION_MANAGER", status: "ACTIVE", permissions: [] };
  if (eventId === "event-c") return { eventId, userId, role: "FINANCE_MANAGER", status: "ACTIVE", permissions: [] };
  if (eventId === "event-d") return { eventId, userId, role: "COMMUNICATIONS_MANAGER", status: "ACTIVE", permissions: [] };
  if (eventId === "event-e") return { eventId, userId, role: "READ_ONLY_STAFF", status: "ACTIVE", permissions: [] };
  return null;
}

const actions = [
  { action: "set", attendeeId: "att-1", adultPersonId: "p-1", reason: "Registrar confirmed" },
  { action: "revoke", attendeeId: "att-1", reason: "Father withdrew" },
  { action: "dismiss", conflictId: "c-1", reason: "Keep current adult" },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentSession.mockResolvedValue({ user: manager });
  mocks.findActiveMembership.mockImplementation(async (userId: string, eventId: string) => memberships(userId, eventId));
  mocks.service.setResponsibleAdult.mockResolvedValue({ authorityId: "g1", supersededAuthorityId: null, resolvedConflictIds: [] });
  mocks.service.revokeResponsibleAdult.mockResolvedValue({ authorityId: "g1" });
  mocks.service.dismissConflict.mockResolvedValue({ conflictId: "c-1" });
});

describe("POST /api/events/[eventId]/guardian-authority", () => {
  it("lets a registration manager set, revoke and close a claim for their event, as themselves", async () => {
    expect((await POST(post(actions[0]), context())).status).toBe(200);
    expect(mocks.service.setResponsibleAdult).toHaveBeenCalledWith({ eventId: "event-a", attendeeId: "att-1", adultPersonId: "p-1", reason: "Registrar confirmed", actorUserId: "user-manager" });
    expect((await POST(post(actions[1]), context())).status).toBe(200);
    expect(mocks.service.revokeResponsibleAdult).toHaveBeenCalledWith({ eventId: "event-a", attendeeId: "att-1", reason: "Father withdrew", actorUserId: "user-manager" });
    expect((await POST(post(actions[2]), context())).status).toBe(200);
    expect(mocks.service.dismissConflict).toHaveBeenCalledWith({ eventId: "event-a", conflictId: "c-1", reason: "Keep current adult", actorUserId: "user-manager" });
  });

  it("does not take the acting user, the event or the registrant's authority from the body", async () => {
    expect((await POST(post({ ...actions[0], actorUserId: "someone-else" }), context())).status).toBe(400);
    expect((await POST(post({ ...actions[0], eventId: "event-b" }), context())).status).toBe(400);
    expect(Object.values(mocks.service).every((fn) => fn.mock.calls.length === 0)).toBe(true);
  });

  it("refuses a member without MANAGE_REGISTRATION (finance, communications, read-only) and an event the user is not assigned to (403), before the service", async () => {
    for (const body of actions) {
      for (const eventId of ["event-c", "event-d", "event-e", "event-b"]) {
        expect((await POST(post(body), context(eventId))).status, `${body.action} on ${eventId}`).toBe(403);
      }
    }
    expect(Object.values(mocks.service).every((fn) => fn.mock.calls.length === 0)).toBe(true);
  });

  it("requires a signed-in user and a same-origin request", async () => {
    mocks.getCurrentSession.mockResolvedValueOnce({ user: null });
    expect((await POST(post(actions[0]), context())).status).toBe(401);
    expect((await POST(post(actions[0], "https://evil.example.test"), context())).status).toBe(403);
    expect(mocks.service.setResponsibleAdult).not.toHaveBeenCalled();
  });

  it("requires a reason for every change and validates the body", async () => {
    expect((await POST(post({ ...actions[0], reason: "   " }), context())).status).toBe(400);
    expect((await POST(post({ action: "set", attendeeId: "att-1", adultPersonId: "p-1" }), context())).status).toBe(400);
    expect((await POST(post({ action: "revoke", attendeeId: "att-1" }), context())).status).toBe(400);
    expect((await POST(post({ action: "delete", attendeeId: "att-1", reason: "x" }), context())).status).toBe(400);
    expect(Object.values(mocks.service).every((fn) => fn.mock.calls.length === 0)).toBe(true);
  });

  it("maps refusals: a person, event or review item that is not on this event is 404; the rest are 409", async () => {
    mocks.service.setResponsibleAdult.mockRejectedValueOnce(new GuardianAuthorityError("Not on this event.", "ATTENDEE_NOT_FOUND"));
    expect((await POST(post(actions[0]), context())).status).toBe(404);
    mocks.service.revokeResponsibleAdult.mockRejectedValueOnce(new GuardianAuthorityError("Not on this event.", "ATTENDEE_NOT_FOUND"));
    expect((await POST(post(actions[1]), context())).status).toBe(404);
    mocks.service.dismissConflict.mockRejectedValueOnce(new GuardianAuthorityError("Not on this event.", "CONFLICT_NOT_FOUND"));
    expect((await POST(post(actions[2]), context())).status).toBe(404);
    mocks.service.setResponsibleAdult.mockRejectedValueOnce(new GuardianAuthorityError("Choose an adult registered for this event.", "ADULT_INVALID"));
    expect((await POST(post(actions[0]), context())).status).toBe(409);
    mocks.service.revokeResponsibleAdult.mockRejectedValueOnce(new GuardianAuthorityError("Nothing to revoke.", "NO_ACTIVE_AUTHORITY"));
    expect((await POST(post(actions[1]), context())).status).toBe(409);
  });
});

describe("responsible-adult reads", () => {
  const rows = [
    { confirmationCode: "REG-1", minorName: "=cmd|' /C calc'!A0", minorAge: 12, minorStatus: "MINOR", responsibleAdult: "@Dad Sample", adultConfirmationCode: "REG-1", state: "Recorded" },
  ];

  it("the CSV export needs VIEW_REPORTS and attendee names on the event, and is formula-safe", async () => {
    mocks.service.getResponsibleAdultExportRows.mockResolvedValue(rows);
    const exported = await exportGet(new Request("https://events.imsda.test/api/x"), context());
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-type")).toContain("text/csv");
    expect(exported.headers.get("cache-control")).toContain("no-store");
    const text = await exported.text();
    expect(text).toContain("\"'=cmd|");
    expect(text).toContain("\"'@Dad Sample\"");
    // Communications and read-only staff have no report access; an event they are not on is refused too.
    for (const eventId of ["event-d", "event-e", "event-b"]) {
      expect((await exportGet(new Request("https://events.imsda.test/api/x"), context(eventId))).status, eventId).toBe(403);
    }
    expect(mocks.service.getResponsibleAdultExportRows).toHaveBeenCalledTimes(1);
  });

  it("the page shows the restricted notice and loads nothing without access to attendee names", async () => {
    mocks.listEventsForUser.mockResolvedValue([{ id: "event-e", name: "Event E", billingMode: "ATTENDEE_PAY" }]);
    const markup = renderToStaticMarkup(await ResponsibleAdultsPage({ searchParams: Promise.resolve({ event: "event-e" }) }));
    expect(markup).toContain("People records are restricted");
    expect(mocks.service.getGuardianReview).not.toHaveBeenCalled();
  });

  it("the page lists who needs review, with change controls only for a registration manager", async () => {
    const review = {
      event: { id: "event-a", name: "Event A", ageOfMajority: 18, startDate: "2027-03-05" },
      items: [{
        attendeeId: "att-1", personId: "p-1", registrationId: "r1", confirmationCode: "REG-1", name: "Sam Sample", age: 12, status: "MINOR",
        kinds: ["NONE_OF_US", "CONFLICT"], responsibleAdult: null, noneOfUs: true,
        conflicts: [{ id: "c1", claimedAdultName: "Mia Sample", claimedAdultPersonId: "p-2", claimingConfirmationCode: "REG-2", declaredAt: "2027-01-01T00:00:00.000Z" }],
      }],
      minors: [],
      adults: [{ personId: "p-2", name: "Mia Sample", confirmationCode: "REG-2" }],
      counts: { NONE_OF_US: 1, NO_ADULT_ON_REGISTRATION: 0, UNKNOWN_AGE: 0, NOT_DECLARED: 0, ADULT_LEFT_REGISTRATION: 0, CONFLICT: 1 },
    };
    mocks.service.getGuardianReview.mockResolvedValue(review);
    mocks.listEventsForUser.mockResolvedValue([
      { id: "event-a", name: "Event A", billingMode: "ATTENDEE_PAY" },
      { id: "event-c", name: "Event C", billingMode: "ATTENDEE_PAY" },
    ]);
    const forManager = renderToStaticMarkup(await ResponsibleAdultsPage({ searchParams: Promise.resolve({ event: "event-a" }) }));
    expect(forManager).toContain("Sam Sample");
    expect(forManager).toContain("Registrant chose “None of us”");
    expect(forManager).toContain("Mia Sample");
    expect(forManager).toContain("Set adult");
    expect(mocks.service.getGuardianReview).toHaveBeenCalledWith("event-a");
    // A finance manager can see names (VIEW_SENSITIVE_DATA) but has no change controls.
    const forFinance = renderToStaticMarkup(await ResponsibleAdultsPage({ searchParams: Promise.resolve({ event: "event-c" }) }));
    expect(forFinance).toContain("Sam Sample");
    expect(forFinance).not.toContain("Set adult");
  });
});
