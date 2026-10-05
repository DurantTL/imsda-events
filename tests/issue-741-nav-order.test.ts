import { createElement } from "react";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const route = vi.hoisted(() => ({ pathname: "/overview" }));

vi.mock("next/navigation", () => ({
  usePathname: () => route.pathname,
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams("event=event_1"),
}));
vi.mock("@/components/sign-out-button", () => ({
  SignOutButton: () => createElement("button", { type: "button" }, "Sign out"),
}));

import { AppShell } from "@/components/app-shell";
import {
  forgetLauncherPosition,
  recallLauncherPosition,
  rememberLauncherPosition,
} from "@/components/more-launcher-model";
import {
  mobileActiveTabHref,
  mobileNavigationLabels,
  mobileNavigationOrder,
  navigation,
  navigationGroupLabels,
  navigationGroupOrder,
} from "@/components/staff-navigation";
import { areaClubPortalNavItems, clubPortalNavItems, clubReporterNavItems } from "@/modules/club-rosters/portal-nav";
import { operationalHealthEntryPermissions } from "@/modules/operations/access";
import { eventPermissions, rolePermissions } from "@/modules/access/permissions";
import type { EventPermission } from "@/modules/access/permissions";
import { clubCapabilities } from "@/modules/organizations/director-grants-domain";

/** The fixed staff navigation order (#741 slice 4). Synthetic data only. */

const AppShellElement = AppShell as ComponentType<Omit<Parameters<typeof AppShell>[0], "children">>;

type Viewer = { permissions: readonly EventPermission[]; systemAdmin?: boolean; pathname?: string };

function render({ permissions, systemAdmin = false, pathname = "/overview" }: Viewer) {
  route.pathname = pathname;
  return renderToStaticMarkup(
    createElement(
      AppShellElement,
      {
        events: [{ id: "event_1", slug: "synthetic-retreat", name: "Synthetic Retreat", permissions }],
        user: {
          displayName: "Synthetic Staff",
          email: "staff@imsda-events.test",
          globalRole: systemAdmin ? "SYSTEM_ADMIN" : null,
        },
      },
      createElement("p", null, "Workspace content"),
    ),
  );
}

/** The sidebar as `Group: item, item`, in document order, More last. */
function sidebar(viewer: Viewer): string[] {
  const markup = render(viewer);
  const nav = markup.slice(markup.indexOf('id="primary-navigation"'), markup.indexOf('class="sidebar-foot"'));
  const tokens: string[] = [];
  for (const match of nav.matchAll(/<span class="nav-group-label">([^<]+)<\/span>|<a [^>]*class="nav-item[^"]*"[^>]*>.*?<span>([^<]+)<\/span><\/a>/g)) {
    tokens.push(match[1] ? `# ${match[1]}` : match[2]);
  }
  return tokens;
}

function phoneTabs(viewer: Viewer): { labels: string[]; active: string[] } {
  const markup = render(viewer);
  const bar = markup.slice(markup.indexOf('aria-label="Mobile navigation"'));
  const labels: string[] = [];
  const active: string[] = [];
  for (const match of bar.matchAll(/<a ([^>]*)>.*?<span>([^<]+)<\/span><\/a>/g)) {
    labels.push(match[2]);
    if (match[1].includes('class="active"')) active.push(match[2]);
  }
  return { labels, active };
}

const systemAdmin: Viewer = { permissions: eventPermissions, systemAdmin: true };
const eventAdmin: Viewer = { permissions: rolePermissions.EVENT_ADMIN };
const fullOrder = [
  "# Main", "Dashboard",
  "# Run the event", "Check-in", "Registrations", "Attendee list", "Imports",
  "# Set up the event", "Event settings", "Registration forms", "Attendee setup", "Tags",
  "# People", "Team", "Emails",
  "# Money", "Payments", "Promo codes",
  "# Reports", "Operational reports", "Operational health",
  "More",
];

describe("sidebar order (#741 slice 4)", () => {
  it("declares the groups in the fixed order with their names", () => {
    expect(navigationGroupOrder.map((group) => navigationGroupLabels[group])).toEqual([
      "Main", "Run the event", "Set up the event", "People", "Money", "Reports",
    ]);
  });

  it("lists every item in the fixed order for a system admin", () => {
    expect(sidebar(systemAdmin)).toEqual(fullOrder);
  });

  it("lists the same order for an event admin", () => {
    expect(sidebar(eventAdmin)).toEqual(fullOrder);
  });

  it("keeps navigation's own order matching the table, More last", () => {
    expect(navigation.map((item) => item.label)).toEqual(fullOrder.filter((entry) => !entry.startsWith("# ")));
    expect(navigation.at(-1)?.href).toBe("/more");
  });

  it("shows a check-in-only role Dashboard and Check-in, with the other groups hidden", () => {
    expect(sidebar({ permissions: rolePermissions.CHECK_IN_STAFF })).toEqual([
      "# Main", "Dashboard",
      "# Run the event", "Check-in", "Registrations", "Attendee list",
      "More",
    ]);
    expect(sidebar({ permissions: ["MANAGE_CHECK_IN"] })).toEqual([
      "# Main", "Dashboard",
      "# Run the event", "Check-in",
    ]);
  });

  it("shows a finance-only role Money and its reports, with the empty groups hidden", () => {
    expect(sidebar({ permissions: rolePermissions.FINANCE_MANAGER })).toEqual([
      "# Main", "Dashboard",
      "# Run the event", "Registrations", "Attendee list",
      "# Money", "Payments", "Promo codes",
      "# Reports", "Operational reports", "Operational health",
      "More",
    ]);
  });

  it("shows a communications role Emails under People, with no Team", () => {
    expect(sidebar({ permissions: rolePermissions.COMMUNICATIONS_MANAGER })).toEqual([
      "# Main", "Dashboard",
      "# People", "Emails",
      "# Reports", "Operational health",
      "More",
    ]);
  });

  it("shows a read-only role only the Dashboard", () => {
    expect(sidebar({ permissions: rolePermissions.READ_ONLY_STAFF })).toEqual(["# Main", "Dashboard"]);
  });

  it("hides every item whose permission the viewer lacks", () => {
    for (const item of navigation) {
      if (!item.requiredPermission) continue;
      const others = eventPermissions.filter((permission) => permission !== item.requiredPermission);
      expect(sidebar({ permissions: others }), item.label).not.toContain(item.label);
    }
  });

  it("never lists Clubs and churches or a System group in the sidebar", () => {
    const entries = sidebar({ ...systemAdmin, permissions: eventPermissions });
    expect(entries.join("|")).not.toMatch(/Clubs and churches|# System/);
  });
});

describe("System management and the event picker (#741 slice 4)", () => {
  it("appears once, above the single Current event picker, for a system admin", () => {
    const markup = render(systemAdmin);
    expect(markup.split("System management").length - 1).toBe(1);
    expect(markup).toContain("All events and integrations");
    expect(markup.indexOf("System management")).toBeLessThan(markup.indexOf('id="event-picker"'));
    expect(markup.split('id="event-picker"').length - 1).toBe(1);
    // Before the nav, which no longer carries it.
    expect(markup.indexOf("System management")).toBeLessThan(markup.indexOf('id="primary-navigation"'));
  });

  it("is hidden from every role that is not a system admin", () => {
    for (const permissions of [eventAdmin.permissions, rolePermissions.FINANCE_MANAGER, rolePermissions.CHECK_IN_STAFF]) {
      expect(render({ permissions })).not.toContain("System management");
    }
  });

  it("keeps the Event database footer", () => {
    const markup = render(eventAdmin);
    expect(markup).toContain("Event database");
    expect(markup).toContain("Access controlled");
  });
});

describe("phone tabs (#741 slice 4)", () => {
  it("is Home, People, Check-in, Emails, More; People is the Registrations page", () => {
    expect([...mobileNavigationOrder]).toEqual(["/overview", "/people", "/check-in", "/communications", "/more"]);
    expect(mobileNavigationLabels["/people"]).toBe("People");
    expect(navigation.find((item) => item.href === "/people")?.label).toBe("Registrations");
    expect(phoneTabs(eventAdmin).labels).toEqual(["Home", "People", "Check-in", "Emails", "More"]);
    expect(phoneTabs(systemAdmin).labels).toEqual(["Home", "People", "Check-in", "Emails", "More"]);
  });

  it("hides tabs the viewer may not open, keeping the order", () => {
    expect(phoneTabs({ permissions: rolePermissions.CHECK_IN_STAFF }).labels).toEqual(["Home", "People", "Check-in", "More"]);
    expect(phoneTabs({ permissions: rolePermissions.FINANCE_MANAGER }).labels).toEqual(["Home", "People", "More"]);
    expect(phoneTabs({ permissions: rolePermissions.COMMUNICATIONS_MANAGER }).labels).toEqual(["Home", "Emails", "More"]);
    expect(phoneTabs({ permissions: rolePermissions.READ_ONLY_STAFF }).labels).toEqual(["Home"]);
  });

  it("selects More on child routes, Team and the other desktop-only pages included", () => {
    for (const pathname of ["/more/event-settings", "/more/tags", "/more/reports", "/more/health", "/more/promo-codes", "/staff", "/imports", "/finance", "/registration-builder", "/community", "/more/clubs"]) {
      expect(phoneTabs({ ...eventAdmin, pathname }).active, pathname).toEqual(["More"]);
    }
  });

  it("keeps a real tab selected on its own page and children", () => {
    expect(phoneTabs({ ...eventAdmin, pathname: "/people/abc" }).active).toEqual(["People"]);
    expect(phoneTabs({ ...eventAdmin, pathname: "/check-in" }).active).toEqual(["Check-in"]);
    expect(mobileActiveTabHref("/more/health")).toBe("/more");
  });
});

describe("More directory position (#741 slice 4)", () => {
  beforeEach(() => forgetLauncherPosition());
  const remember = (overrides: Partial<Parameters<typeof rememberLauncherPosition>[0]> = {}) =>
    rememberLauncherPosition({ userId: "user_1", eventQuery: "?event=event_1", cardKey: "tags", href: "/more/tags?event=event_1", scrollTop: 120, ...overrides });
  const recall = (overrides: Partial<Parameters<typeof recallLauncherPosition>[0]> = {}) =>
    recallLauncherPosition({ userId: "user_1", eventQuery: "?event=event_1", pathname: "/more/tags", ...overrides });

  it("returns the card and scroll back on the page it opened, or a child of it", () => {
    expect(recall()).toBeNull();
    remember();
    expect(recall()?.scrollTop).toBe(120);
    expect(recall({ pathname: "/more/tags/abc" })?.cardKey).toBe("tags");
  });

  it("is not used on any other page, so focus starts at the first card", () => {
    remember();
    for (const pathname of ["/overview", "/more", "/more/tagsx", "/more/promo-codes"]) expect(recall({ pathname }), pathname).toBeNull();
  });

  it("is keyed by user and event, so a shared tab never leaks it", () => {
    remember();
    expect(recall({ userId: "user_2" })).toBeNull();
    expect(recall({ eventQuery: "?event=event_2" })).toBeNull();
  });

  it("is cleared by forgetLauncherPosition, which Escape and sign-out call", () => {
    remember();
    forgetLauncherPosition();
    expect(recall()).toBeNull();
    const root = join(__dirname, "..");
    const signOut = readFileSync(join(root, "components/sign-out-button.tsx"), "utf8");
    expect(signOut).toContain("forgetLauncherPosition()");
    expect(signOut.indexOf("forgetLauncherPosition()")).toBeLessThan(signOut.indexOf('fetch("/api/auth/logout"'));
    const launcher = readFileSync(join(root, "components/more-launcher.tsx"), "utf8");
    expect(launcher).toMatch(/reason === "escape"\) forgetLauncherPosition\(\)/);
  });
});

describe("Operational health and desktop highlight (#741 slice 4)", () => {
  it("is hidden when none of operationalHealthEntryPermissions is held", () => {
    const withoutEntry = eventPermissions.filter((permission) => !(operationalHealthEntryPermissions as readonly string[]).includes(permission));
    expect(withoutEntry).not.toContain("MANAGE_FINANCE");
    const items = sidebar({ permissions: withoutEntry });
    expect(items).not.toContain("Operational health");
    // VIEW_REPORTS still shows Operational reports, so the group stays with that one item.
    expect(items.slice(items.indexOf("# Reports"))).toEqual(["# Reports", "Operational reports", "More"]);
    for (const permission of operationalHealthEntryPermissions) {
      expect(sidebar({ permissions: [permission] }), permission).toContain("Operational health");
    }
  });

  function activeItems(pathname: string) {
    const markup = render({ ...eventAdmin, pathname });
    const nav = markup.slice(markup.indexOf('id="primary-navigation"'), markup.indexOf('class="sidebar-foot"'));
    return [...nav.matchAll(/<a [^>]*class="nav-item active"[^>]*>.*?<span>([^<]+)<\/span><\/a>/g)].map((match) => match[1]);
  }

  it("highlights Operational reports and Operational health on their own pages, not More", () => {
    expect(activeItems("/more/reports")).toEqual(["Operational reports"]);
    expect(activeItems("/more/reports/packets")).toEqual(["Operational reports"]);
    expect(activeItems("/more/health")).toEqual(["Operational health"]);
    expect(activeItems("/more")).toEqual(["More"]);
  });
});

describe("club portal and coordinator menus are unchanged (#741 slice 4)", () => {
  const base = "/account/clubs/club-1";
  const labels = (items: readonly { group?: string; label: string }[]) => items.map((item) => `${item.group ?? "-"}:${item.label}`);

  it("director and deputy", () => {
    const expected = [
      "-:Home",
      "People:Roster", "People:Honors", "People:Class tracking",
      "Events:Club events", "Events:Forms", "Events:Health",
      "Records:Monthly Records",
      "Orders:Orders",
      "Club:Club settings",
    ];
    expect(labels(clubPortalNavItems({ base, role: "DIRECTOR", capabilities: clubCapabilities("DIRECTOR") }))).toEqual(expected);
    expect(labels(clubPortalNavItems({ base, role: "DEPUTY", capabilities: clubCapabilities("DEPUTY") }))).toEqual(expected);
  });

  it("registrar and reporter", () => {
    expect(labels(clubPortalNavItems({ base, role: "REGISTRAR", capabilities: clubCapabilities("REGISTRAR") }))).toEqual([
      "-:Home", "People:Roster", "People:Honors", "People:Class tracking", "Events:Club events", "Orders:Orders",
    ]);
    expect(labels(clubReporterNavItems({ base, capabilities: clubCapabilities("DIRECTOR") }))).toEqual(["-:Home", "Records:Monthly Records"]);
  });

  it("area coordinator", () => {
    expect(labels(areaClubPortalNavItems({ organizationId: "club-1" }))).toEqual([
      "-:Home",
      "People:Roster", "People:Honors",
      "Events:Events", "Events:Club forms",
      "Records:Monthly reports",
      "Orders:Orders", "Orders:Earned awards",
    ]);
  });
});
