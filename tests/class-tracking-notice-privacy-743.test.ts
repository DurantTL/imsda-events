import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => ({}) }));
vi.mock("@/modules/events/repository", () => ({ listEventsForUser: vi.fn() }));
vi.mock("@/modules/attendee-accounts/registrations-repository", () => ({ matchingRegistrationIdsForVerifiedEmail: vi.fn() }));

import { ClubEarnedAwardsWorkspace, emptyEarnedAwardsData, memberMatchesSearch } from "@/components/club-earned-awards-workspace";
import { selectAccountBannerAnnouncements, type AccountBannerCandidate } from "@/modules/communications/account-banner-domain";
import { retreatHubAnnouncementRecords } from "@/modules/attendee-accounts/retreat-hub-repository";
import { buildPublicEventAnnouncementFeed } from "@/modules/events/public-domain";
import { areaClubPortalNavItems, clubPortalNavItems, clubReporterNavItems } from "@/modules/club-rosters/portal-nav";
import { CLUB_REGISTRATION_CARD_NOTE } from "@/modules/club-registrations/entry-path";

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

/** Class tracking with a stocked club (#743 verify item). Synthetic names only. */
describe("class tracking with stocked data", () => {
  const members = Array.from({ length: 48 }, (_, i) => ({
    personId: `p${i}`, firstName: `Pat${i}`, lastName: "Sample", classLabel: i % 2 ? "Friend" : "Ranger",
  }));
  const render = (list: typeof members) => renderToStaticMarkup(createElement(ClubEarnedAwardsWorkspace, {
    organizationId: "club-1",
    ordersHref: "/o",
    initial: { ...emptyEarnedAwardsData, members: list, catalog: [{ itemId: "gc", section: "MISCELLANEOUS", sectionLabel: "Miscellaneous", name: "Good Conduct Bar", catalogNumber: "002304" }] },
  }));

  it("matches by every word in a name or class, ignoring case", () => {
    const m = { firstName: "Casey", lastName: "Demo", classLabel: "Ranger" };
    expect(memberMatchesSearch(m, "")).toBe(true);
    expect(memberMatchesSearch(m, "casey ranger")).toBe(true);
    expect(memberMatchesSearch(m, "DEMO")).toBe(true);
    expect(memberMatchesSearch(m, "friend")).toBe(false);
    expect(memberMatchesSearch({ firstName: "A", lastName: "B" }, "a")).toBe(true);
  });

  it("offers one search and one members table, the same for a long or short club", () => {
    for (const list of [members, members.slice(0, 5)]) {
      const html = render(list);
      expect(html.match(/Find a member/g)).toHaveLength(1);
      expect(html.match(/<table/g)).toHaveLength(1);
      expect(html.match(/Sample, Pat0</g)).toHaveLength(1);
    }
  });

  it("keeps the spacing rules and the inline Orders link in the stylesheet", () => {
    const css = read("app/globals.css");
    expect(css).toContain(".earned-scroll-list { max-height: 20rem; overflow-y: auto;");
    expect(css).toContain(".class-tracking-table { table-layout: fixed; width: 100%; }");
    expect(css).toContain("p.field-help.earned-help > a");
  });
});

/**
 * Club notice privacy across views (#743 verify item). "Notice" here means any
 * published announcement or club-only note a viewer might be shown. The one
 * public club note, "For club directors. Sign in…", is intentional.
 */
describe("club notice privacy across signed-out, attendee, director and coordinator views", () => {
  const publishedAt = new Date("2027-01-01T00:00:00Z");
  const all = { type: "ALL_ATTENDEES" };
  const clubOnly = { type: "CLUB_DIRECTORS" };
  const secret = "Directors only: synthetic private body";

  const hubRows = [
    { id: "a1", title: "Open to all", body: "Parking opens at noon.", audience: all, priority: "NORMAL" as const, publishedAt, pinnedAt: null },
    { id: "a2", title: "Directors only", body: secret, audience: clubOnly, priority: "URGENT" as const, publishedAt, pinnedAt: null },
    { id: "a3", title: "Mixed", body: secret, audience: { type: "ALL_ATTENDEES", clubId: "club-1" }, priority: "NORMAL" as const, publishedAt, pinnedAt: null },
    { id: "a4", title: "No audience", body: secret, audience: null, priority: "NORMAL" as const, publishedAt, pinnedAt: null },
  ];

  it("signed-out visitors: the public event feed shows only attendee-wide notices", () => {
    const feed = buildPublicEventAnnouncementFeed(
      hubRows.map((row) => ({ ...row, status: "PUBLISHED", placement: "HOME_BANNER" })) as never,
      "America/Chicago",
      new Date("2027-02-01T00:00:00Z"),
    );
    expect(feed.map((item) => item.title)).toEqual(["Open to all"]);
    expect(JSON.stringify(feed)).not.toContain(secret);
  });

  it("attendees: the hub (and the staff preview of it) drops club-directed notices and the audience field", () => {
    const records = retreatHubAnnouncementRecords({ announcements: hubRows });
    expect(records.map((item) => item.title)).toEqual(["Open to all"]);
    expect(JSON.stringify(records)).not.toContain(secret);
    expect(JSON.stringify(records)).not.toContain("audience");
  });

  it("directors and coordinators with an account: the account banner shows only attendee-wide notices, whoever the viewer is", () => {
    const candidate = (row: (typeof hubRows)[number], clubOrganizationId: string | null): AccountBannerCandidate => ({
      id: row.id, title: row.title, body: row.body, audience: row.audience, placement: "HOME_BANNER", status: "PUBLISHED",
      priority: row.priority, publishedAt, pinnedAt: null, eventId: "event-1",
      event: { name: "Synthetic Event", slug: "synthetic-event", timezone: "America/Chicago", endsAt: new Date("2027-12-31T00:00:00Z") },
      hasOwnRegistration: false, clubOrganizationId,
    });
    const now = new Date("2027-02-01T00:00:00Z");
    for (const clubOrganizationId of ["club-1", null]) {
      const shown = selectAccountBannerAnnouncements(hubRows.map((row) => candidate(row, clubOrganizationId)), now);
      expect(shown.map((item) => item.title)).toEqual(["Open to all"]);
      expect(JSON.stringify(shown)).not.toContain(secret);
    }
  });

  it("the public club note appears on the public event page only, never in the portal", () => {
    expect(CLUB_REGISTRATION_CARD_NOTE).toContain("For club directors");
    const users = [
      "app/(public)/events/[eventSlug]/page.tsx",
      "app/(public)/account/(portal)/layout.tsx",
      "app/(public)/account/(portal)/clubs/[organizationId]/page.tsx",
      "app/(public)/account/(portal)/clubs/[organizationId]/layout.tsx",
      "app/(public)/account/(portal)/area/[organizationId]/layout.tsx",
      "app/(public)/account/events/[eventSlug]/page.tsx",
    ];
    expect(users.filter((file) => read(file).includes("CLUB_REGISTRATION_CARD_NOTE"))).toEqual(["app/(public)/events/[eventSlug]/page.tsx"]);
    // It says to sign in; it names no club, person or amount.
    expect(CLUB_REGISTRATION_CARD_NOTE).not.toMatch(/\$|@|club-\d/);
  });

  it("the coordinator's view-only notice lives only in the coordinator layout, and the director layout never shows it", () => {
    expect(read("app/(public)/account/(portal)/area/[organizationId]/layout.tsx")).toContain("View only");
    expect(read("app/(public)/account/(portal)/clubs/[organizationId]/layout.tsx")).not.toContain("View only");
  });

  it("menus: a coordinator never gets director-only screens, and a reporter gets neither roster nor events", () => {
    const capabilities = { roster: true, registerForEvents: true, seeBirthDates: true, manageTeam: true, editProfile: true, submitReports: true, guardians: true };
    const director = clubPortalNavItems({ base: "/account/clubs/c", role: "DIRECTOR", capabilities }).map((item) => item.label);
    const coordinator = areaClubPortalNavItems({ organizationId: "c" }).map((item) => item.label);
    for (const label of ["Class tracking", "Club settings", "Health"]) {
      expect(director).toContain(label);
      expect(coordinator).not.toContain(label);
    }
    // The coordinator's tab shares the portal's "Monthly Records" name (#789) but stays on the view-only report pages.
    for (const item of areaClubPortalNavItems({ organizationId: "c" })) expect(item.href.startsWith("/account/area/c")).toBe(true);
    const reporter = clubReporterNavItems({ base: "/account/clubs/c", capabilities: { ...capabilities, roster: false } }).map((item) => item.label);
    expect(reporter).toEqual(["Home", "Monthly Records"]);
  });
});
