import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `resolveEventContext` (#465 — Q1: a wrong or missing event never silently
 * opens a different event). The selection order itself is covered, pure and
 * unmocked, in `event-context-selection.test.ts`; this exercises the
 * effectful wrapper — session, membership lookup, and the redirects a
 * missing/invalid/unpermitted or absent id now takes instead of falling back
 * to `events[0]`.
 */

const mocks = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  listEventsForUser: vi.fn(),
  findActiveMembership: vi.fn(),
  readLastUsedEventId: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new RedirectSignal(path);
  }),
}));

class RedirectSignal extends Error {
  constructor(public readonly path: string) {
    super(`REDIRECT:${path}`);
  }
}

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/modules/events/repository", () => ({
  listEventsForUser: mocks.listEventsForUser,
  findActiveMembership: mocks.findActiveMembership,
}));
vi.mock("@/modules/events/last-used-event", () => ({ readLastUsedEventId: mocks.readLastUsedEventId }));

import { resolveEventContext } from "@/modules/events/selection";

const staff = { id: "usr_staff", email: "staff@imsda-events.test", displayName: "Synthetic Staff", globalRole: null };
const admin = { ...staff, id: "usr_admin", globalRole: "SYSTEM_ADMIN" as const };

function event(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    slug: id,
    name: `Event ${id}`,
    startsAt: new Date("2027-04-09T00:00:00.000Z"),
    endsAt: new Date("2027-04-11T00:00:00.000Z"),
    timezone: "America/Chicago",
    location: null,
    capacity: null,
    isPublished: true,
    registrationOpensOn: null,
    registrationClosesOn: null,
    waitlistEnabled: false,
    collectsShirtSizes: false,
    checksAdultBackgrounds: false,
    attendeeEditPolicy: "STAFF_ONLY",
    billingMode: "ATTENDEE_PAY",
    seminarPreferenceClosesOn: null,
    seminarPreferenceSelfServiceLocked: false,
    autoPromoteWaitlist: false,
    publicInfoUrl: null,
    supportContact: null,
    ...overrides,
  };
}

async function expectRedirect(path: string, run: () => Promise<unknown>) {
  await expect(run()).rejects.toThrow(`REDIRECT:${path}`);
  expect(mocks.redirect).toHaveBeenCalledWith(path);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.redirect.mockImplementation((path: string) => {
    throw new RedirectSignal(path);
  });
  mocks.readLastUsedEventId.mockResolvedValue(null);
  mocks.findActiveMembership.mockResolvedValue(null);
});

describe("resolveEventContext — an invalid or unpermitted requested id never opens another event", () => {
  it("sends staff to the picker with a not-available notice for a mistyped or deleted id, rather than another event", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: staff });
    mocks.listEventsForUser.mockResolvedValue([event("evt_a"), event("evt_b")]);

    await expectRedirect("/select-event?unavailable=1", () => resolveEventContext("evt_typo"));
    expect(mocks.findActiveMembership).not.toHaveBeenCalled();
  });

  it("sends staff to the same not-available notice for an event that exists but they aren't a member of — no different message that would leak which", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: staff });
    mocks.listEventsForUser.mockResolvedValue([event("evt_a")]);

    await expectRedirect("/select-event?unavailable=1", () => resolveEventContext("evt_owned_by_another_club"));
  });

  it("sends a system administrator to the same not-available notice for a nonexistent id, never substituting another event", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: admin });
    mocks.listEventsForUser.mockResolvedValue([event("evt_a"), event("evt_b")]);

    await expectRedirect("/select-event?unavailable=1", () => resolveEventContext("evt_does_not_exist"));
  });

  it("never falls back for an account with only one real event", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: staff });
    mocks.listEventsForUser.mockResolvedValue([event("evt_only")]);

    await expectRedirect("/select-event?unavailable=1", () => resolveEventContext("evt_wrong"));
  });
});

describe("resolveEventContext — no id given, the automatic order", () => {
  it("uses the last-used-event cookie when it still matches one of the account's events, and marks it auto-selected", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: staff });
    mocks.listEventsForUser.mockResolvedValue([event("evt_a"), event("evt_b")]);
    mocks.readLastUsedEventId.mockResolvedValue("evt_b");
    mocks.findActiveMembership.mockResolvedValue({ eventId: "evt_b", userId: staff.id, role: "READ_ONLY_STAFF", status: "ACTIVE", permissions: [] });

    const context = await resolveEventContext(undefined);

    expect(context.event.id).toBe("evt_b");
    expect(context.autoSelected).toBe(true);
  });

  it("falls through to the nearest published/open event when the cookie no longer matches", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: staff });
    mocks.listEventsForUser.mockResolvedValue([
      event("evt_far", { startsAt: new Date("2028-01-01T00:00:00.000Z") }),
      event("evt_near", { startsAt: new Date("2027-01-01T00:00:00.000Z") }),
    ]);
    mocks.readLastUsedEventId.mockResolvedValue("evt_no_longer_active");

    const context = await resolveEventContext(undefined);

    expect(context.event.id).toBe("evt_near");
    expect(context.autoSelected).toBe(true);
  });

  it("does not read the cookie at all when an id was explicitly requested", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: staff });
    mocks.listEventsForUser.mockResolvedValue([event("evt_a")]);

    await resolveEventContext("evt_a");

    expect(mocks.readLastUsedEventId).not.toHaveBeenCalled();
  });

  it("does not mark an explicitly requested event as auto-selected", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: staff });
    mocks.listEventsForUser.mockResolvedValue([event("evt_a"), event("evt_b")]);
    mocks.findActiveMembership.mockResolvedValue({ eventId: "evt_a", userId: staff.id, role: "READ_ONLY_STAFF", status: "ACTIVE", permissions: [] });

    const context = await resolveEventContext("evt_a");

    expect(context.autoSelected).toBe(false);
  });

  it("sends staff to the picker (no notice) when nothing can be chosen automatically", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: staff });
    mocks.listEventsForUser.mockResolvedValue([
      event("evt_draft_1", { isPublished: false }),
      event("evt_draft_2", { isPublished: false }),
    ]);

    await expectRedirect("/select-event", () => resolveEventContext(undefined));
  });

  it("picks the nearest published/open event the same way for a system administrator", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: admin });
    mocks.listEventsForUser.mockResolvedValue([
      event("evt_far", { startsAt: new Date("2028-01-01T00:00:00.000Z") }),
      event("evt_near", { startsAt: new Date("2027-01-01T00:00:00.000Z") }),
    ]);

    const context = await resolveEventContext(undefined);

    expect(context.event.id).toBe("evt_near");
    expect(context.autoSelected).toBe(true);
    expect(mocks.findActiveMembership).not.toHaveBeenCalled();
  });

  it("sends an account with no events at all to /no-access, before any selection is attempted", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: staff });
    mocks.listEventsForUser.mockResolvedValue([]);

    await expectRedirect("/no-access", () => resolveEventContext(undefined));
  });
});
