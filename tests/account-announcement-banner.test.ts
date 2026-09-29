import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  registrationIds: vi.fn(),
  directedClubs: vi.fn(),
  registrationFindMany: vi.fn(),
  clubRegistrationFindMany: vi.fn(),
  announcementFindMany: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    registration: { findMany: mocks.registrationFindMany },
    clubEventRegistration: { findMany: mocks.clubRegistrationFindMany },
    announcement: { findMany: mocks.announcementFindMany },
  }),
}));
vi.mock("@/modules/attendee-accounts/registrations-repository", () => ({
  matchingRegistrationIdsForVerifiedEmail: mocks.registrationIds,
}));
vi.mock("@/modules/organizations/director-access", () => ({
  listDirectedClubs: mocks.directedClubs,
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
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.registrationIds.mockResolvedValue([]);
    mocks.directedClubs.mockResolvedValue([]);
    mocks.registrationFindMany.mockResolvedValue([]);
    mocks.clubRegistrationFindMany.mockResolvedValue([]);
    mocks.announcementFindMany.mockResolvedValue([candidate("a")]);
  });

  it("shows nothing and reads no announcements when the account has no link to an event", async () => {
    expect(await listAccountBannerAnnouncements(account, now)).toEqual([]);
    expect(mocks.announcementFindMany).not.toHaveBeenCalled();
  });

  it("links an event through an active registration", async () => {
    mocks.registrationIds.mockResolvedValue(["reg-1"]);
    mocks.registrationFindMany.mockResolvedValue([{ eventId: "event-1" }]);
    const result = await listAccountBannerAnnouncements(account, now);
    expect(result.map((item) => item.id)).toEqual(["a"]);
    expect(mocks.registrationFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ["reg-1"] }, status: { in: ["SUBMITTED", "CONFIRMED"] } },
    }));
    expect(mocks.announcementFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        eventId: { in: ["event-1"] },
        status: "PUBLISHED",
        placement: "HOME_BANNER",
      }),
    }));
  });

  it("links an event through a directed or deputised club's active club registration", async () => {
    mocks.directedClubs.mockResolvedValue([
      { organizationId: "club-dir", name: "A", role: "DIRECTOR", sponsoringChurch: null },
      { organizationId: "club-dep", name: "B", role: "DEPUTY", sponsoringChurch: null },
      { organizationId: "club-reg", name: "C", role: "REGISTRAR", sponsoringChurch: null },
    ]);
    mocks.clubRegistrationFindMany.mockResolvedValue([{ eventId: "event-2" }, { eventId: "event-2" }]);
    const result = await listAccountBannerAnnouncements(account, now);
    expect(result.map((item) => item.id)).toEqual(["a"]);
    expect(mocks.clubRegistrationFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        organizationId: { in: ["club-dir", "club-dep"] },
        registration: { status: { in: ["SUBMITTED", "CONFIRMED"] } },
      },
    }));
    expect(mocks.announcementFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ eventId: { in: ["event-2"] } }),
    }));
  });

  it("ignores registrar and reporter roles", async () => {
    mocks.directedClubs.mockResolvedValue([
      { organizationId: "club-reg", name: "C", role: "REGISTRAR", sponsoringChurch: null },
    ]);
    expect(await listAccountBannerAnnouncements(account, now)).toEqual([]);
    expect(mocks.clubRegistrationFindMany).not.toHaveBeenCalled();
  });

  it("filters drafts, ended events and other audiences from what the database returned", async () => {
    mocks.registrationIds.mockResolvedValue(["reg-1"]);
    mocks.registrationFindMany.mockResolvedValue([{ eventId: "event-1" }]);
    mocks.announcementFindMany.mockResolvedValue([
      candidate("draft", { status: "DRAFT" }),
      candidate("ended", { event: endedEvent }),
      candidate("audience", { audience: { type: "SOMEONE_ELSE" } }),
      candidate("ok"),
    ]);
    expect((await listAccountBannerAnnouncements(account, now)).map((item) => item.id)).toEqual(["ok"]);
  });
});

describe("AccountAnnouncementBanner", () => {
  const items = selectAccountBannerAnnouncements([
    candidate("urgent", { priority: "URGENT", body: "Urgent <b>body</b>" }),
    candidate("normal"),
  ], now);

  it("shows the top announcement, an N more control, and no dismiss on URGENT", () => {
    const markup = renderToStaticMarkup(createElement(AccountAnnouncementBanner, { announcements: items }));
    expect(markup).toContain("Synthetic Retreat");
    expect(markup).toContain("Title urgent");
    expect(markup).toContain("1 more");
    expect(markup).not.toContain("Title normal");
    expect(markup).not.toContain("Dismiss announcement");
  });

  it("escapes the body instead of injecting HTML", () => {
    const markup = renderToStaticMarkup(createElement(AccountAnnouncementBanner, { announcements: items }));
    expect(markup).toContain("Urgent &lt;b&gt;body&lt;/b&gt;");
    expect(markup).not.toContain("<b>body</b>");
  });

  it("offers dismissal on non-urgent announcements and trims long bodies with a link to the event hub", () => {
    const long = selectAccountBannerAnnouncements([candidate("long", { body: "x".repeat(400) })], now);
    const markup = renderToStaticMarkup(createElement(AccountAnnouncementBanner, { announcements: long }));
    expect(markup).toContain("Dismiss announcement: Title long");
    expect(markup).toContain('href="/account/events/synthetic-retreat"');
    expect(markup).not.toContain("x".repeat(400));
  });

  it("renders nothing when there are no announcements", () => {
    expect(renderToStaticMarkup(createElement(AccountAnnouncementBanner, { announcements: [] }))).toBe("");
  });
});
