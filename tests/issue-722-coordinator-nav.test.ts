import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { actAsBannerClassName } from "@/components/act-as-banner";
import { areaClubsNavItems } from "@/components/area-clubs-subnav";
import { areaClubPortalNavItems, clubPortalNavItems } from "@/modules/club-rosters/portal-nav";
import { clubCapabilities } from "@/modules/organizations/director-grants-domain";

/** The Area Coordinator's club menu and layout (#722). Synthetic ids only. */

const base = "/account/area/club-1";
const items = areaClubPortalNavItems({ organizationId: "club-1" });
const css = readFileSync("app/globals.css", "utf8");

describe("area coordinator club menu (#722)", () => {
  it("lists exactly the destinations a coordinator can already open", () => {
    expect(items.map((item) => `${item.label} -> ${item.href}`)).toEqual([
      `Home -> ${base}`,
      `Roster -> ${base}#open-club-roster`,
      `Honors -> ${base}/honors`,
      `Events -> ${base}#open-club-events`,
      `Club forms -> ${base}/forms`,
      `Monthly Records -> ${base}#open-club-reports`,
      `Orders -> ${base}/orders`,
      `Earned awards -> ${base}/awards`,
    ]);
  });

  it("never lists a director-only destination", () => {
    const hrefs = items.map((item) => item.href);
    for (const denied of ["/class-tracking", "/club-info", "/health", "/records", "/team", "/profile", "/exports", "/notes"]) {
      expect(hrefs.some((href) => href.includes(denied))).toBe(false);
    }
    for (const href of hrefs) expect(href.startsWith("/account/clubs/")).toBe(false);
    // Every item stays inside this club.
    for (const href of hrefs) expect(href.startsWith(base)).toBe(true);
    expect(items.map((item) => item.label)).not.toContain("Background checks");
    expect(items.map((item) => item.label)).not.toContain("Class tracking");
    expect(items.map((item) => item.label)).not.toContain("Club info");
    expect(items.map((item) => item.label)).not.toContain("Club settings");
  });

  it("uses the director portal's grouping and headings-off style", () => {
    const director = clubPortalNavItems({ base: "/account/clubs/club-1", role: "DIRECTOR", capabilities: clubCapabilities("DIRECTOR") });
    const directorGroups = new Set(director.map((item) => item.group).filter(Boolean));
    for (const item of items) {
      if (item.group) {
        expect(directorGroups.has(item.group)).toBe(true);
        expect(item.hideGroupLabel).toBe(true);
      }
    }
    expect(items[0]).toMatchObject({ label: "Home" });
  });

  it("keeps the report month pages under Monthly Records", () => {
    expect(items.find((item) => item.label === "Monthly Records")?.alsoMatchPrefix).toBe(`${base}/reports`);
  });
});

describe("layout classes (#722)", () => {
  it("puts the account-side act-as banner in the content column", () => {
    expect(actAsBannerClassName({ inAccount: true })).toContain("act-as-banner-account");
    expect(actAsBannerClassName({ inShell: true })).toContain("act-as-banner-shell");
    expect(actAsBannerClassName({})).toBe("inline-notice act-as-banner");
    expect(css).toMatch(/\.act-as-banner-account \{[^}]*max-width: 1180px;[^}]*margin: 12px auto 0;/);
    expect(css).toMatch(/\.account-nav, \.account-page-body, \.account-overview-grid, \.act-as-banner-account \{ margin-right: 24px/);
    expect(css).toMatch(/\.account-nav, \.account-page-body, \.account-overview-grid, \.act-as-banner-account \{ margin-right: 12px/);
  });

  it("wraps the Clubs sub-menu in the page-body column on both pages that show it", () => {
    expect(areaClubsNavItems.map((item) => item.label)).toEqual(["All clubs", "Overview", "Monthly reports", "Points", "Club events"]);
    for (const file of ["app/(public)/account/(portal)/area-clubs/layout.tsx", "app/(public)/account/(portal)/clubs/page.tsx"]) {
      expect(readFileSync(file, "utf8")).toContain("<AreaClubsSubNav />");
    }
    expect(readFileSync("components/area-clubs-subnav.tsx", "utf8")).toContain('className="account-page-body account-page-subnav"');
  });

  it("drops the stacked bar buttons from the coordinator club page", () => {
    const page = readFileSync("app/(public)/account/(portal)/area/[organizationId]/page.tsx", "utf8");
    expect(page).not.toContain("secondary-button");
    const layout = readFileSync("app/(public)/account/(portal)/area/[organizationId]/layout.tsx", "utf8");
    expect(layout).toContain('className="club-roster-layout area-club-layout"');
    expect(layout).toContain('variant="secondary"');
    expect(layout).toContain("View only");
    expect(css).toMatch(/\.area-club-layout > :is\(a, p\.inline-notice\)/);
    expect(layout).toContain('href="/account/clubs"');
  });
});
