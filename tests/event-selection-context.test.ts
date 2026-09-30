import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { loadWorkspaceEventContext, resolveEventContext } from "@/modules/events/selection";

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

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  // "Nearest event" is measured from now; pin it so the fixtures stay valid.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-28T12:00:00.000Z"));
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

  it("sends a system administrator to the same not-available notice on /admin for a nonexistent id, never substituting another event", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: admin });
    mocks.listEventsForUser.mockResolvedValue([event("evt_a"), event("evt_b")]);

    // /select-event sends admins to /admin, so the notice lives there — one hop, no loop.
    await expectRedirect("/admin?unavailable=1", () => resolveEventContext("evt_does_not_exist"));
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

  it("sends a system administrator to /admin, not the picker (which would bounce them back), when nothing can be chosen automatically", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: admin });
    mocks.listEventsForUser.mockResolvedValue([
      event("evt_draft_1", { isPublished: false }),
      event("evt_draft_2", { isPublished: false }),
    ]);

    await expectRedirect("/admin", () => resolveEventContext(undefined));
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

describe("loadWorkspaceEventContext — the workspace layout never redirects for event selection", () => {
  const drafts = () => [
    event("evt_draft_a", { isPublished: false }),
    event("evt_draft_b", { isPublished: false }),
  ];

  it("does not redirect a system administrator whose events are all drafts (no /admin ⇄ picker loop)", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: admin });
    mocks.listEventsForUser.mockResolvedValue(drafts());

    const context = await loadWorkspaceEventContext();

    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(context.defaultEventId).toBeNull();
    expect(context.autoSelected).toBe(false);
    expect(context.events.map((candidate) => candidate.id)).toEqual(["evt_draft_a", "evt_draft_b"]);
  });

  it("lets a multi-event staff member with no cookie open a valid ?event= deep link to a draft", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: staff });
    mocks.listEventsForUser.mockResolvedValue(drafts());
    mocks.findActiveMembership.mockResolvedValue({ eventId: "evt_draft_a", userId: staff.id, role: "READ_ONLY_STAFF", status: "ACTIVE", permissions: [] });

    // The layout renders…
    const layout = await loadWorkspaceEventContext();
    expect(layout.defaultEventId).toBeNull();
    // …and the page resolves the requested event.
    const page = await resolveEventContext("evt_draft_a");

    expect(page.event.id).toBe("evt_draft_a");
    expect(page.autoSelected).toBe(false);
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("still sends a signed-out request to /login and an account with no events to /no-access", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: null });
    await expectRedirect("/login", () => loadWorkspaceEventContext());

    mocks.getCurrentSession.mockResolvedValue({ user: staff });
    mocks.listEventsForUser.mockResolvedValue([]);
    await expectRedirect("/no-access", () => loadWorkspaceEventContext());
  });

  it("lets any staff account with zero events load the shell for the profile page only when asked (#623)", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: staff });
    mocks.listEventsForUser.mockResolvedValue([]);

    const context = await loadWorkspaceEventContext({ anyStaffWithoutEvents: true });

    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(context.events).toEqual([]);
    expect(context.defaultEventId).toBeNull();
    await expectRedirect("/no-access", () => loadWorkspaceEventContext());
  });

  it("lets a system administrator with zero events load the layout context for global /admin pages (#567 F-6)", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: admin });
    mocks.listEventsForUser.mockResolvedValue([]);

    const context = await loadWorkspaceEventContext();

    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(context.events).toEqual([]);
    expect(context.defaultEventId).toBeNull();
    // Event-scoped pages still resolve for themselves and send the admin on.
    await expectRedirect("/no-access", () => resolveEventContext(undefined));
  });

  it.each([
    ["the last-used cookie", "evt_far"],
    ["the nearest published event (stale cookie)", "evt_gone"],
    ["the nearest published event (no cookie)", null],
  ])("gives the shell the same default the page resolves to, via %s", async (_label, cookie) => {
    mocks.getCurrentSession.mockResolvedValue({ user: staff });
    mocks.listEventsForUser.mockResolvedValue([
      event("evt_draft", { isPublished: false, startsAt: new Date("2026-10-01T00:00:00.000Z") }),
      event("evt_far", { startsAt: new Date("2028-01-01T00:00:00.000Z") }),
      event("evt_near", { startsAt: new Date("2027-01-01T00:00:00.000Z") }),
    ]);
    mocks.readLastUsedEventId.mockResolvedValue(cookie);

    const layout = await loadWorkspaceEventContext();
    const page = await resolveEventContext(undefined);

    expect(layout.defaultEventId).toBe(page.event.id);
    expect(layout.autoSelected).toBe(page.autoSelected);
    expect(layout.autoSelected).toBe(true);
    expect(layout.defaultEventId).not.toBe("evt_draft");
  });
});
