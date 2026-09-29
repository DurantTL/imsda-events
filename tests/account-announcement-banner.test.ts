import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  registrationIds: vi.fn(),
  announcementFindMany: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    announcement: { findMany: mocks.announcementFindMany },
  }),
}));
vi.mock("@/modules/attendee-accounts/registrations-repository", () => ({
  matchingRegistrationIdsForVerifiedEmail: mocks.registrationIds,
}));

import { AccountAnnouncementBanner } from "@/components/account-announcement-banner";
import { listAccountBannerAnnouncements } from "@/modules/communications/account-banner";
import {
  selectAccountBannerAnnouncements,
  type AccountBannerCandidate,
} from "@/modules/communications/account-banner-domain";

const now = new Date("2026-09-29T18:00:00.000Z");
const account = { id: "acct-1", verifiedEmail: "person@example.test" };
const liveEvent = { name: "Synthetic Retreat", slug: "synthetic-retreat", timezone: "America/Chicago", endsAt: new Date("2026-10-11T17:00:00.000Z") };
const endedEvent = { ...liveEvent, name: "Past Retreat", slug: "past-retreat", endsAt: new Date("2026-09-01T17:00:00.000Z") };

function candidate(id: string, overrides: Partial<AccountBannerCandidate> = {}): AccountBannerCandidate {
  return {
    id,
    title: `Title ${id}`,
    body: `Body ${id}`,
    audience: { type: "ALL_ATTENDEES" },
    placement: "HOME_BANNER",
    status: "PUBLISHED",
    priority: "NORMAL",
    publishedAt: new Date("2026-09-20T12:00:00.000Z"),
    pinnedAt: null,
    event: liveEvent,
    eventId: "event-1",
    hasOwnRegistration: true,
    clubOrganizationId: null,
    ...overrides,
  };
}

describe("selectAccountBannerAnnouncements", () => {
  it("keeps a published banner announcement for a live event", () => {
    expect(selectAccountBannerAnnouncements([candidate("a")], now).map((item) => item.id)).toEqual(["a"]);
  });

  it("drops drafts, archived rows, other placements, other audiences, future and ended-event rows", () => {
    const rows = [
      candidate("draft", { status: "DRAFT", publishedAt: null }),
      candidate("archived", { status: "ARCHIVED" }),
      candidate("registration-page", { placement: "REGISTRATION_PAGE" }),
      candidate("staff-audience", { audience: { type: "ALL_ATTENDEES", internalTag: "staff-only" } }),
      candidate("other-audience", { audience: { type: "CLUB_DIRECTORS" } }),
      candidate("future", { publishedAt: new Date("2026-10-01T12:00:00.000Z") }),
      candidate("ended", { event: endedEvent }),
      candidate("ok"),
    ];
    expect(selectAccountBannerAnnouncements(rows, now).map((item) => item.id)).toEqual(["ok"]);
  });

  it("orders pinned first, then priority, then newest", () => {
    const rows = [
      candidate("normal-new", { publishedAt: new Date("2026-09-28T12:00:00.000Z") }),
      candidate("normal-old", { publishedAt: new Date("2026-09-10T12:00:00.000Z") }),
      candidate("important", { priority: "IMPORTANT" }),
      candidate("urgent", { priority: "URGENT" }),
      candidate("pinned-normal", { pinnedAt: new Date("2026-09-15T12:00:00.000Z") }),
    ];
    expect(selectAccountBannerAnnouncements(rows, now).map((item) => item.id)).toEqual([
      "pinned-normal",
      "urgent",
      "important",
      "normal-new",
      "normal-old",
    ]);
  });
});

describe("listAccountBannerAnnouncements", () => {
  const directorClub = { organizationId: "club-dir", name: "A", role: "DIRECTOR" as const, sponsoringChurch: null };
  const deputyClub = { organizationId: "club-dep", name: "B", role: "DEPUTY" as const, sponsoringChurch: null };
  const registrarClub = { organizationId: "club-reg", name: "C", role: "REGISTRAR" as const, sponsoringChurch: null };

  // What the database hands back for one announcement row.
  function row(id: string, link: { own?: boolean; club?: string | null }, overrides: Record<string, unknown> = {}) {
    const base = candidate(id);
    return {
      id: base.id,
      title: base.title,
      body: base.body,
      audience: base.audience,
      placement: base.placement,
      status: base.status,
      priority: base.priority,
      publishedAt: base.publishedAt,
      pinnedAt: base.pinnedAt,
      eventId: "event-1",
      event: {
        ...liveEvent,
        registrations: link.own ? [{ id: "reg-1" }] : [],
        clubRegistrations: link.club ? [{ organizationId: link.club }] : [],
      },
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.registrationIds.mockResolvedValue([]);
    mocks.announcementFindMany.mockResolvedValue([row("a", { own: true })]);
  });

  it("shows nothing and reads no announcements when the account has no link to an event", async () => {
    expect(await listAccountBannerAnnouncements(account, [], now)).toEqual([]);
    expect(await listAccountBannerAnnouncements(account, [registrarClub], now)).toEqual([]);
    expect(mocks.announcementFindMany).not.toHaveBeenCalled();
  });

  it("links an event through an active registration, in the one announcement query", async () => {
    mocks.registrationIds.mockResolvedValue(["reg-1"]);
    const result = await listAccountBannerAnnouncements(account, [], now);
    expect(result.map((item) => item.id)).toEqual(["a"]);
    expect(result[0].href).toBe("/account/events/synthetic-retreat");
    expect(mocks.announcementFindMany).toHaveBeenCalledTimes(1);
    expect(mocks.announcementFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: "PUBLISHED",
        placement: "HOME_BANNER",
        event: {
          OR: [{ registrations: { some: { id: { in: ["reg-1"] }, status: { in: ["SUBMITTED", "CONFIRMED"] } } } }],
        },
      }),
    }));
  });

  it("links an event through a directed or deputised club, never a registrar's", async () => {
    mocks.announcementFindMany.mockResolvedValue([row("a", { club: "club-dir" })]);
    const result = await listAccountBannerAnnouncements(account, [directorClub, deputyClub, registrarClub], now);
    expect(result.map((item) => item.id)).toEqual(["a"]);
    expect(mocks.announcementFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        event: {
          OR: [{
            clubRegistrations: {
              some: {
                organizationId: { in: ["club-dir", "club-dep"] },
                registration: { status: { in: ["SUBMITTED", "CONFIRMED"] } },
              },
            },
          }],
        },
      }),
    }));
  });

  it("links a club-only director to the club's event page, not the hub they cannot open", async () => {
    mocks.announcementFindMany.mockResolvedValue([row("a", { club: "club-dir" })]);
    const [item] = await listAccountBannerAnnouncements(account, [directorClub], now);
    expect(item.href).toBe("/account/clubs/club-dir/events/event-1");
  });

  it("prefers the hub when the account also has its own registration", async () => {
    mocks.registrationIds.mockResolvedValue(["reg-1"]);
    mocks.announcementFindMany.mockResolvedValue([row("a", { own: true, club: "club-dir" })]);
    const [item] = await listAccountBannerAnnouncements(account, [directorClub], now);
    expect(item.href).toBe("/account/events/synthetic-retreat");
  });

  it("filters drafts, ended events and other audiences from what the database returned", async () => {
    mocks.registrationIds.mockResolvedValue(["reg-1"]);
    mocks.announcementFindMany.mockResolvedValue([
      row("draft", { own: true }, { status: "DRAFT" }),
      row("ended", { own: true }, { event: { ...endedEvent, registrations: [{ id: "reg-1" }], clubRegistrations: [] } }),
      row("audience", { own: true }, { audience: { type: "SOMEONE_ELSE" } }),
      row("ok", { own: true }),
    ]);
    expect((await listAccountBannerAnnouncements(account, [], now)).map((item) => item.id)).toEqual(["ok"]);
  });
});

describe("AccountAnnouncementBanner", () => {
  const items = selectAccountBannerAnnouncements([
    candidate("urgent", { priority: "URGENT", body: "Urgent <b>body</b>" }),
    candidate("normal"),
  ], now);
  const show = (announcements: typeof items) =>
    renderToStaticMarkup(createElement(AccountAnnouncementBanner, { accountId: "acct-1", announcements }));

  it("always shows URGENT items outside the collapsed list, with no dismiss button", () => {
    const markup = show(items);
    expect(markup).toContain("Synthetic Retreat");
    expect(markup).toContain("Title urgent");
    expect(markup).toContain("1 more");
    expect(markup).not.toContain("Title normal");
    expect(markup).not.toContain("Dismiss announcement");
  });

  it("shows every URGENT item even when several are present", () => {
    const many = selectAccountBannerAnnouncements([
      candidate("u1", { priority: "URGENT" }),
      candidate("u2", { priority: "URGENT" }),
      candidate("n1"),
    ], now);
    const markup = show(many);
    expect(markup).toContain("Title u1");
    expect(markup).toContain("Title u2");
    expect(markup).toContain("1 more");
  });

  it("shows only the top item and N more when nothing is urgent", () => {
    const many = selectAccountBannerAnnouncements([
      candidate("n1"),
      candidate("n2", { publishedAt: new Date("2026-09-10T12:00:00.000Z") }),
      candidate("n3", { publishedAt: new Date("2026-09-09T12:00:00.000Z") }),
    ], now);
    const markup = show(many);
    expect(markup).toContain("Title n1");
    expect(markup).not.toContain("Title n2");
    expect(markup).toContain("2 more");
  });

  it("escapes the body instead of injecting HTML", () => {
    const markup = show(items);
    expect(markup).toContain("Urgent &lt;b&gt;body&lt;/b&gt;");
    expect(markup).not.toContain("<b>body</b>");
  });

  it("splits paragraphs and trims whitespace like the event hub", () => {
    const two = selectAccountBannerAnnouncements([candidate("p", { body: "  First line.\n\n  Second line.  " })], now);
    const markup = show(two);
    expect(markup).toContain("<p>First line.</p><p>Second line.</p>");
  });

  it("offers dismissal on non-urgent announcements and trims long bodies with the item's own link", () => {
    const long = selectAccountBannerAnnouncements([
      candidate("long", { body: "x".repeat(400), hasOwnRegistration: false, clubOrganizationId: "club-dir" }),
    ], now);
    const markup = show(long);
    expect(markup).toContain("Dismiss announcement: Title long");
    expect(markup).toContain('href="/account/clubs/club-dir/events/event-1"');
    expect(markup).not.toContain("x".repeat(400));
  });

  it("renders nothing when there are no announcements", () => {
    expect(show([])).toBe("");
  });
});
