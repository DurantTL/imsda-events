import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isAccountNavItemActive } from "@/components/account-section-nav";
import {
  buildMoreDirectoryCards,
  canShowMoreLauncher,
  mobileActiveTabHref,
  mobileNavigationOrder,
  navigation,
} from "@/components/staff-navigation";
import { rolePermissions, type EventPermission } from "@/modules/access/permissions";
import { areaClubPortalNavItems, clubPortalNavItems, clubReporterNavItems } from "@/modules/club-rosters/portal-nav";
import { clubCapabilities } from "@/modules/organizations/director-grants-domain";

/** Staff navigation and phone overflow fixes (#737). Synthetic ids only. */

const moreItem = navigation.find((item) => item.href === "/more")!;
const launcher = (permissions: readonly EventPermission[], over: { clubEvent?: boolean; isSystemAdmin?: boolean } = {}) =>
  canShowMoreLauncher({
    item: moreItem,
    permissions,
    clubOversight: false,
    clubEvent: over.clubEvent ?? false,
    isSystemAdmin: over.isSystemAdmin ?? false,
    clubFormsAccess: false,
  });

describe("More launcher follows permitted destinations (#737)", () => {
  it("shows for check-in staff granted health information on a club event", () => {
    const permissions = [...rolePermissions.CHECK_IN_STAFF, "VIEW_HEALTH_INFORMATION" as const];
    expect(launcher(permissions, { clubEvent: true })).toBe(true);
    const cards = buildMoreDirectoryCards({
      permissions, clubOversight: false, clubEvent: true, isSystemAdmin: false, clubFormsAccess: false, eventQuery: "?event=e1",
    }).filter((card) => card.allowed);
    expect(cards.map((card) => card.key)).toEqual(["event-health", "attendee-list"]);
  });

  it("stays hidden when no More destination is permitted", () => {
    // Check-in staff can read attendee records, so the attendee list (#784) is their one destination.
    expect(launcher(rolePermissions.CHECK_IN_STAFF, { clubEvent: true })).toBe(true);
    expect(launcher(["MANAGE_CHECK_IN"], { clubEvent: true })).toBe(false);
    expect(launcher(rolePermissions.READ_ONLY_STAFF)).toBe(false);
    // Health information is a club-event page: nothing to open on a general event.
    expect(launcher(["VIEW_HEALTH_INFORMATION"], { clubEvent: false })).toBe(false);
  });

  it("keeps showing for the permissions it always admitted", () => {
    expect(launcher(["VIEW_REPORTS"])).toBe(true);
    expect(launcher(["MANAGE_STAFF"])).toBe(true);
  });
});

describe("phone tab for child routes (#737)", () => {
  it("keeps the five tabs in their order", () => {
    expect([...mobileNavigationOrder]).toEqual(["/overview", "/people", "/check-in", "/communications", "/more"]);
  });

  it("lights More for Settings, builder and other pages without a tab", () => {
    for (const href of ["/more/event-settings", "/registration-builder", "/more/tags", "/more/attendee-configuration", "/more", "/more/promo-codes", "/finance", "/staff", "/imports"]) {
      expect(mobileActiveTabHref(href)).toBe("/more");
    }
  });

  it("leaves real tabs alone", () => {
    for (const href of mobileNavigationOrder) expect(mobileActiveTabHref(href)).toBe(href);
  });
});

describe("club portal child routes keep their tab (#737)", () => {
  const base = "/account/clubs/club-1";
  const director = clubPortalNavItems({ base, role: "DIRECTOR", capabilities: clubCapabilities("DIRECTOR") });
  const active = (pathname: string, items = director) =>
    items.filter((item) => isAccountNavItemActive(pathname, item)).map((item) => item.label);

  it("maps export, print and year-end pages to their parent", () => {
    expect(active(`${base}/roster/export`)).toEqual(["Roster"]);
    expect(active(`${base}/roster/m1/health`)).toEqual(["Roster"]);
    expect(active(`${base}/exports/honors`)).toEqual(["Honors"]);
    expect(active(`${base}/exports/class-tracking`)).toEqual(["Class tracking"]);
    expect(active(`${base}/orders/print`)).toEqual(["Orders"]);
    expect(active(`${base}/reports/year-end/2026`)).toEqual(["Monthly Records"]);
    expect(active(`${base}/reports/2026-09`)).toEqual(["Monthly Records"]);
  });

  it("keeps existing active states", () => {
    expect(active(base)).toEqual(["Home"]);
    expect(active(`${base}/events/e1/packet`)).toEqual(["Club events"]);
    expect(active(`${base}/exports/class-tracking`)).not.toContain("Honors");
  });

  it("applies to the reporter menu too, and keeps the labels and order", () => {
    const reporter = clubReporterNavItems({ base, capabilities: clubCapabilities("DIRECTOR") });
    expect(active(`${base}/reports/year-end/2026`, reporter)).toEqual(["Monthly Records"]);
    expect(director.map((item) => item.label)).toEqual(
      ["Home", "Roster", "Honors", "Class tracking", "Club events", "Forms", "Health", "Monthly Records", "Orders", "Club settings"],
    );
  });

  it("keeps the coordinator Monthly reports tab on report pages", () => {
    const area = areaClubPortalNavItems({ organizationId: "club-1" });
    expect(active("/account/area/club-1/reports/2026-09", area)).toEqual(["Monthly reports"]);
  });
});

describe("phone overflow CSS (#737)", () => {
  const css = readFileSync("app/globals.css", "utf8");

  it("does not give a visually hidden caption the card caption's width", () => {
    expect(css).toContain("table.table-cards.table-cards > caption:not(.sr-only)");
    expect(css).not.toMatch(/table\.table-cards\.table-cards > caption \{/);
    expect(css).not.toMatch(/table\.table-cards\.table-cards > caption,/);
  });

  it("stacks the raw audit code under the activity summary on a phone", () => {
    expect(css).toMatch(/@media \(max-width: 600px\) \{\s*\.activity-row \{ grid-template-columns: auto minmax\(0, 1fr\)/);
    expect(css).toMatch(/\.activity-row code \{ grid-column: 2;/);
  });
});
